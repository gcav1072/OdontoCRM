#!/usr/bin/env node
/**
 * Emisión de **licencias offline** ([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Esto es el corazón del lado proveedor: construye los claims, firma el JWT con
 * la clave privada (que vive fuera del repo), guarda el `.lic` y anota la
 * emisión en el registro. Lo usan el CLI (`tools/licencia.mjs`) y el bot de
 * Telegram del proveedor (`tools/licencia-bot.mjs`); el consultorio **nunca**
 * ejecuta este archivo.
 *
 * Regla de renovación (decisión del 2026-11-11): el nuevo vencimiento es
 * `max(desde ?? ahora, vencimiento anterior) + días del tipo`. Renovar antes de
 * tiempo **suma** los días en vez de perderlos, y `--desde` permite al proveedor
 * fijar el inicio sin poder acortar una licencia vigente.
 */
import {
  LICENSE_KIND_DAYS,
  LICENSE_KIND_LABELS,
  LICENSE_KINDS,
  LICENSE_REQUEST_PREFIX,
  LICENSE_VERSION,
  decodeLicenseRequest,
  licenseClaimsSchema,
} from '@odontocrm/contracts';
import { loadPrivateKey, loadPublicKey, signLicenseToken } from '@odontocrm/kernel';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { asegurarDirectorios, rutasDeLicencias } from './licencia-config.mjs';
import {
  agregarEntrada,
  elegirId,
  fechaCorta,
  textoDias,
  textoVencimiento,
  ultimaPorInstalacion,
} from './licencia-registro.mjs';

export { elegirId } from './licencia-registro.mjs';

const DAY_MS = 86_400_000;

/** Normaliza un instante ISO o `Date`; `null` si no vino. Falla con un mensaje útil. */
const aFecha = (valor, campo) => {
  if (valor === undefined || valor === null || valor === '') return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    throw new Error(
      `${campo}: fecha no válida («${String(valor)}»). Usa ISO 8601, p. ej. 2026-12-31T23:59:59-04:00`,
    );
  }
  return fecha;
};

/** Días que dura un tipo de licencia; falla si el tipo no existe. */
export const diasDelTipo = (tipo) => {
  if (!Object.hasOwn(LICENSE_KIND_DAYS, String(tipo))) {
    throw new Error(
      `Tipo de licencia no válido: «${String(tipo)}». Usa ${LICENSE_KINDS.join(' / ')}.`,
    );
  }
  return LICENSE_KIND_DAYS[tipo];
};

/**
 * Calcula el vencimiento de una emisión. `desde` (opcional) fija el inicio; si
 * no viene, empieza ahora. Nunca retrocede respecto del vencimiento anterior de
 * la misma instalación (renovación que suma).
 */
export const calcularVencimiento = ({
  tipo,
  ahora = new Date(),
  desde = null,
  vencimientoAnterior = null,
} = {}) => {
  const dias = diasDelTipo(tipo);
  const instanteAhora = aFecha(ahora, 'ahora') ?? new Date();
  const instanteDesde = aFecha(desde, '--desde');
  const anterior = aFecha(vencimientoAnterior, 'vencimiento anterior');

  const candidatos = [instanteDesde ?? instanteAhora];
  if (anterior !== null) candidatos.push(anterior);
  const base = candidatos.reduce((mayor, fecha) =>
    fecha.getTime() > mayor.getTime() ? fecha : mayor,
  );

  return new Date(base.getTime() + dias * DAY_MS).toISOString();
};

/** Construye y valida los claims firmables a partir de los datos comerciales. */
export const construirClaims = ({
  lic,
  tipo,
  instalacion,
  cliente,
  rif,
  notas,
  ahora = new Date(),
  venceEn,
}) => {
  const instante = aFecha(ahora, 'ahora') ?? new Date();
  const datos = {
    v: LICENSE_VERSION,
    lic,
    tipo,
    instalacion,
    cliente: {
      nombre: String(cliente ?? '').trim(),
      ...(rif === undefined || String(rif).trim() === '' ? {} : { rif: String(rif).trim() }),
    },
    emitidaEn: instante.toISOString(),
    venceEn,
    modulos: ['*'],
    ...(notas === undefined || String(notas).trim() === '' ? {} : { notas: String(notas).trim() }),
  };

  const parsed = licenseClaimsSchema.safeParse(datos);
  if (!parsed.success) {
    const detalles = parsed.error.issues
      .map((problema) => `${problema.path.join('.') || '(licencia)'}: ${problema.message}`)
      .join('; ');
    throw new Error(`Los datos de la licencia no son válidos (${detalles}).`);
  }
  return parsed.data;
};

/**
 * Emite una licencia completa: valida, firma, guarda el `.lic` y anota el
 * registro. Devuelve también el token para que el bot lo mande como documento.
 *
 * `entradas` es el registro ya leído (`leerRegistro(...).entradas`); se pasa en
 * vez de leerlo aquí para que el cálculo sea reproducible y se pueda probar con
 * temporales. `clavePrivada` es la clave ya importada (nunca el PEM).
 */
export const emitirLicencia = async ({
  tipo,
  instalacion,
  cliente,
  rif,
  desde = null,
  notas,
  emitidaPor = 'cli',
  entradas = [],
  clavePrivada,
  rutas = rutasDeLicencias(),
  ahora = new Date(),
} = {}) => {
  if (typeof instalacion !== 'string' || instalacion.trim() === '') {
    throw new Error('Falta la instalación: el UUID del consultorio que pide la licencia.');
  }
  if (clavePrivada === undefined || clavePrivada === null) {
    throw new Error('Falta la clave privada del proveedor con la que firmar la licencia.');
  }

  const instante = aFecha(ahora, 'ahora') ?? new Date();
  const previa = ultimaPorInstalacion(entradas, instalacion);
  const venceEn = calcularVencimiento({
    tipo,
    ahora: instante,
    desde,
    vencimientoAnterior: previa === null ? null : previa.venceEn,
  });
  const lic = elegirId(entradas, instante);
  const claims = construirClaims({
    lic,
    tipo,
    instalacion,
    cliente,
    rif,
    notas,
    ahora: instante,
    venceEn,
  });
  const token = await signLicenseToken(claims, { privateKey: clavePrivada });

  asegurarDirectorios(rutas);
  const archivo = join(rutas.emitidas, `${lic}.lic`);
  writeFileSync(archivo, token, { encoding: 'utf8', mode: 0o600 });

  const entrada = {
    ...claims,
    emitidaPor,
    renovacion: previa !== null,
    anterior: previa === null ? null : { lic: previa.lic, venceEn: previa.venceEn },
    archivo: `${lic}.lic`,
    registradaEn: instante.toISOString(),
  };
  agregarEntrada(rutas.registro, entrada);

  return {
    token,
    claims,
    entrada,
    archivo,
    renovacion: previa !== null,
    anterior: entrada.anterior,
  };
};

/** Carga la clave privada del proveedor con un error que diga qué hacer si falta. */
export const cargarClavePrivada = async (ruta) => {
  try {
    return await loadPrivateKey(ruta);
  } catch (fallo) {
    if (fallo !== null && typeof fallo === 'object' && fallo.code === 'ENOENT') {
      throw new Error(
        `No encuentro la clave privada en ${ruta}.\n` +
          'Genera el par una vez con:  npm run licencia -- claves',
        { cause: fallo },
      );
    }
    throw new Error(
      `No pude leer la clave privada de ${ruta}: ${String(fallo?.message ?? fallo)}`,
      {
        cause: fallo,
      },
    );
  }
};

/** Carga la clave pública (para `verificar`); error claro si no está publicada. */
export const cargarClavePublica = async (ruta) => {
  try {
    return await loadPublicKey(ruta);
  } catch (fallo) {
    if (fallo !== null && typeof fallo === 'object' && fallo.code === 'ENOENT') {
      throw new Error(
        `No encuentro la clave pública en ${ruta}.\n` +
          'Genera el par con:  npm run licencia -- claves --publicar',
        { cause: fallo },
      );
    }
    throw new Error(
      `No pude leer la clave pública de ${ruta}: ${String(fallo?.message ?? fallo)}`,
      {
        cause: fallo,
      },
    );
  }
};

const PREFIJO_ESCAPADO = LICENSE_REQUEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const SOLICITUD_EN_TEXTO = new RegExp(`${PREFIJO_ESCAPADO}[A-Za-z0-9_-]+`, 'u');

/**
 * Busca un código `ODO-REQ1.…` dentro de un mensaje reenviado y lo decodifica.
 * Devuelve `null` si no hay ninguno o si el código está roto (quien llama decide
 * si avisa «regenéralo en el consultorio»).
 */
export const extraerSolicitudDeTexto = (texto) => {
  const encontrado = SOLICITUD_EN_TEXTO.exec(String(texto ?? ''));
  if (encontrado === null) return null;
  return decodeLicenseRequest(encontrado[0]);
};

/** Texto legible de una solicitud recibida (para el bot del proveedor). */
export const formatearSolicitud = (solicitud) => {
  const tipo =
    solicitud.tipoSolicitado === undefined || solicitud.tipoSolicitado === 'no_se'
      ? 'no indicado'
      : (LICENSE_KIND_LABELS[solicitud.tipoSolicitado] ?? solicitud.tipoSolicitado);
  const lineas = [
    'Solicitud de licencia recibida:',
    `  · Consultorio: ${solicitud.cliente.nombre}${solicitud.cliente.rif === undefined ? '' : ` (${solicitud.cliente.rif})`}`,
    `  · Instalación: ${solicitud.instalacion}`,
    `  · Tipo pedido: ${tipo}`,
    `  · Generada: ${fechaCorta(solicitud.generadaEn)}`,
  ];
  if (solicitud.nota !== undefined && solicitud.nota !== '')
    lineas.push(`  · Nota: ${solicitud.nota}`);
  return lineas.join('\n');
};

/** Resumen de una emisión (lo pinta el CLI y lo manda el bot por Telegram). */
export const formatearEmision = (
  { claims, archivo, renovacion, anterior = null },
  { adjunto = false } = {},
) => {
  const rif = claims.cliente.rif === undefined ? '' : ` (${claims.cliente.rif})`;
  const lineas = [
    `✔ Licencia emitida: ${claims.lic}`,
    `  Consultorio: ${claims.cliente.nombre}${rif}`,
    `  Tipo: ${LICENSE_KIND_LABELS[claims.tipo]} (${textoDias(LICENSE_KIND_DAYS[claims.tipo])})`,
    `  Instalación: ${claims.instalacion}`,
    `  Emitida: ${fechaCorta(claims.emitidaEn)} · Vence: ${fechaCorta(claims.venceEn)}`,
  ];
  lineas.push(
    adjunto
      ? '  El archivo .lic va adjunto a este mensaje.'
      : `  Archivo: ${archivo ?? `${claims.lic}.lic`}`,
  );
  if (renovacion && anterior !== null && anterior !== undefined) {
    lineas.push(
      `  Renovación de ${anterior.lic}: suma sobre su vencimiento (${fechaCorta(anterior.venceEn)}).`,
    );
  } else if (renovacion) {
    lineas.push('  Renovación: suma sobre la licencia anterior de esta instalación.');
  }
  if (claims.notas !== undefined && claims.notas !== '') lineas.push(`  Notas: ${claims.notas}`);
  return lineas.join('\n');
};

/** Ficha verificada de una licencia (`verificar` del CLI). */
export const formatearVerificacion = (claims, ahora = new Date()) => {
  const rif = claims.cliente.rif === undefined ? '' : ` (${claims.cliente.rif})`;
  const vencida = Date.parse(claims.venceEn) <= ahora.getTime();
  return [
    '✔ La licencia es válida (firma, emisor y formato correctos).',
    `  Licencia: ${claims.lic}`,
    `  Consultorio: ${claims.cliente.nombre}${rif}`,
    `  Tipo: ${LICENSE_KIND_LABELS[claims.tipo]} (${textoDias(LICENSE_KIND_DAYS[claims.tipo])})`,
    `  Instalación: ${claims.instalacion}`,
    `  Emitida: ${fechaCorta(claims.emitidaEn)}`,
    `  Estado: ${vencida ? 'VENCIDA' : 'vigente'} · ${textoVencimiento(claims.venceEn, ahora)}`,
    ...(claims.notas === undefined || claims.notas === '' ? [] : [`  Notas: ${claims.notas}`]),
  ].join('\n');
};

/**
 * Nombre de archivo seguro para mandar el `.lic` por Telegram: sin acentos ni
 * espacios (nombre del consultorio incluido de forma estable).
 */
export const nombreArchivoLicencia = (claims) => {
  const base = (claims.cliente.nombre ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
    .slice(0, 40);
  return `licencia-${claims.lic}${base === '' ? '' : `-${base}`}.lic`;
};
