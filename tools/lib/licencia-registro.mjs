#!/usr/bin/env node
/**
 * Registro del **proveedor de licencias**: un JSONL (`registro.jsonl`) con una
 * línea por licencia emitida, más las consultas de vencimientos y los textos.
 *
 * Vive en el directorio de datos del proveedor, **fuera del repo**
 * (`tools/lib/licencia-config.mjs`), y es la memoria comercial del emisor:
 *
 *   · de aquí sale el siguiente identificador legible (`LIC-AAAA-NNNN`),
 *   · aquí se busca el vencimiento anterior para renovar sin perder días, y
 *   · con esto responde `/pendientes` (qué consultorio hay que llamar este mes).
 *
 * Las funciones de este archivo son **puras** (reciben las entradas ya leídas)
 * salvo `leerRegistro`/`agregarEntrada`, que son el único acceso a disco. Así se
 * prueban sin tocar la máquina del proveedor.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { LICENSE_KIND_DAYS, LICENSE_KIND_LABELS } from '@odontocrm/contracts';

const DAY_MS = 86_400_000;

const formatoFecha = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

/** Fecha `dd/mm/aaaa` (hora de Caracas) de un ISO; `—` si no se puede leer. */
export const fechaCorta = (iso) => {
  const instante = new Date(iso);
  return Number.isNaN(instante.getTime()) ? '—' : formatoFecha.format(instante);
};

/** «1 día» / «N días», en singular o plural. */
export const textoDias = (cantidad) => `${String(cantidad)} ${cantidad === 1 ? 'día' : 'días'}`;

/**
 * @typedef {object} EntradaRegistro
 * @property {string} lic                Identificador legible (`LIC-2026-0001`).
 * @property {'mensual'|'trimestral'|'anual'} tipo
 * @property {string} instalacion        UUID de la instalación (consultorio).
 * @property {{nombre: string, rif?: string}} cliente
 * @property {string} emitidaEn          ISO de emisión.
 * @property {string} venceEn            ISO de vencimiento.
 * @property {string[]} modulos          Módulos licenciados (`['*']` hoy).
 * @property {string} [notas]
 * @property {'cli'|'bot'} emitidaPor    Herramienta que la emitió.
 * @property {boolean} renovacion        `true` si suma sobre una licencia anterior.
 * @property {{lic: string, venceEn: string} | null} anterior
 * @property {string} archivo            Nombre del `.lic` guardado en `emitidas/`.
 * @property {string} registradaEn       ISO del momento de anotar la entrada.
 */

/** Patrón del identificador legible: `LIC-<año>-<secuencia>`. */
const ID_LICENCIA = /^LIC-(?<anio>\d{4})-(?<secuencia>\d{3,})$/u;

/** Una entrada es aprovechable si tiene lo mínimo para operar con ella. */
const esEntradaValida = (valor) =>
  valor !== null &&
  typeof valor === 'object' &&
  !Array.isArray(valor) &&
  typeof valor.lic === 'string' &&
  ID_LICENCIA.test(valor.lic) &&
  typeof valor.instalacion === 'string' &&
  valor.instalacion !== '' &&
  typeof valor.tipo === 'string' &&
  Number.isFinite(Date.parse(valor.venceEn)) &&
  Number.isFinite(Date.parse(valor.emitidaEn));

/**
 * Lee el texto completo del registro. **No falla por una línea corrupta** (un
 * apagón a mitad de escritura deja una línea rota y perder el registro entero
 * sería peor): devuelve las entradas buenas y los números de línea descartados
 * para que quien llama lo avise.
 */
export const parsearRegistro = (texto) => {
  const entradas = [];
  const invalidas = [];
  const lineas = String(texto ?? '').split(/\r?\n/u);

  lineas.forEach((linea, indice) => {
    const limpia = linea.trim();
    if (limpia === '') return;
    try {
      const valor = JSON.parse(limpia);
      if (esEntradaValida(valor)) {
        entradas.push(valor);
      } else {
        invalidas.push(indice + 1);
      }
    } catch {
      invalidas.push(indice + 1);
    }
  });

  return { entradas, invalidas };
};

/** Una entrada a una línea JSONL (la forma que se guarda y se lee). */
export const serializarEntrada = (entrada) => JSON.stringify(entrada);

/** Lee el registro de disco. Sin archivo, registro vacío (la primera emisión lo crea). */
export const leerRegistro = (ruta) => {
  if (!existsSync(ruta)) return { entradas: [], invalidas: [] };
  return parsearRegistro(readFileSync(ruta, 'utf8'));
};

/** Añade una entrada al final del registro, creando el archivo si hace falta. */
export const agregarEntrada = (ruta, entrada) => {
  mkdirSync(dirname(ruta), { recursive: true, mode: 0o700 });
  appendFileSync(ruta, `${serializarEntrada(entrada)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entrada;
};

/**
 * Siguiente identificador legible: `LIC-AAAA-NNNN`, con la secuencia del año de
 * emisión. Se calcula del **máximo** ya usado, no del número de líneas: así un
 * registro con huecos o entradas borradas no repite un identificador. El año se
 * toma en UTC para que la secuencia no cambie según la zona del proveedor.
 */
export const siguienteId = (entradas, fecha = new Date()) => {
  const anio = fecha.getUTCFullYear();
  const prefijo = `LIC-${String(anio)}-`;
  let maximo = 0;

  for (const entrada of entradas ?? []) {
    if (!esEntradaValida(entrada) || !entrada.lic.startsWith(prefijo)) continue;
    const secuencia = Number(entrada.lic.slice(prefijo.length));
    if (Number.isInteger(secuencia) && secuencia > maximo) maximo = secuencia;
  }

  return `${prefijo}${String(maximo + 1).padStart(4, '0')}`;
};

/** Alias con el nombre que usa la emisión (`elegirId`) para el identificador. */
export const elegirId = siguienteId;

/**
 * Licencia **más reciente** de una instalación: la de vencimiento mayor. Si hay
 * empate, la emitida después y, si también, la última anotada. Es la que manda
 * para renovar y para `/licencia <uuid>`.
 */
export const ultimaPorInstalacion = (entradas, instalacion) => {
  let elegida = null;
  let venceElegida = Number.NEGATIVE_INFINITY;
  let emitidaElegida = Number.NEGATIVE_INFINITY;

  for (const entrada of entradas ?? []) {
    if (!esEntradaValida(entrada) || entrada.instalacion !== instalacion) continue;
    const vence = Date.parse(entrada.venceEn);
    const emitida = Date.parse(entrada.emitidaEn);
    if (vence > venceElegida || (vence === venceElegida && emitida >= emitidaElegida)) {
      elegida = entrada;
      venceElegida = vence;
      emitidaElegida = emitida;
    }
  }

  return elegida;
};

/**
 * La última licencia de **cada** instalación (la vigente o la última que tuvo).
 * Es lo que se lista en `/pendientes`: si un consultorio renovó cinco veces, no
 * salen cinco filas, sale la que de verdad importa.
 */
export const ultimasPorInstalacion = (entradas) => {
  const porInstalacion = new Map();
  for (const entrada of entradas ?? []) {
    if (!esEntradaValida(entrada)) continue;
    const previa = porInstalacion.get(entrada.instalacion);
    if (previa === undefined) {
      porInstalacion.set(entrada.instalacion, entrada);
      continue;
    }
    const anterior = ultimaPorInstalacion([previa, entrada], entrada.instalacion);
    if (anterior !== null) porInstalacion.set(entrada.instalacion, anterior);
  }
  return [...porInstalacion.values()];
};

/** Días que faltan para `venceEn` (redondeo hacia arriba; negativo si ya venció). */
export const diasRestantes = (venceEn, ahora = new Date()) => {
  const vence = Date.parse(venceEn);
  if (!Number.isFinite(vence)) return null;
  return Math.ceil((vence - ahora.getTime()) / DAY_MS);
};

/** Texto del vencimiento para listas: fecha + «quedan N días» / «VENCIDA». */
export const textoVencimiento = (venceEn, ahora = new Date()) => {
  const vence = Date.parse(venceEn);
  if (!Number.isFinite(vence)) return 'fecha ilegible';
  const fecha = fechaCorta(venceEn);
  if (vence <= ahora.getTime()) return `VENCIDA el ${fecha}`;
  const dias = diasRestantes(venceEn, ahora);
  if (dias === 0) return `vence hoy (${fecha})`;
  return `vence el ${fecha} (quedan ${textoDias(dias)})`;
};

/**
 * Licencias que vencen en los próximos `dias` (o que ya vencieron y no se
 * renovaron), una por instalación y en orden de vencimiento. `dias` se mide
 * desde `ahora`; las vencidas entran siempre para que el proveedor pueda llamar
 * a renovar.
 */
export const pendientes = (entradas, { ahora = new Date(), dias = 30 } = {}) => {
  return ultimasPorInstalacion(entradas)
    .map((entrada) => ({ ...entrada, diasRestantes: diasRestantes(entrada.venceEn, ahora) }))
    .filter((entrada) => entrada.diasRestantes !== null && entrada.diasRestantes <= dias)
    .sort((izquierda, derecha) => Date.parse(izquierda.venceEn) - Date.parse(derecha.venceEn));
};

/** ¿Es el tipo un tipo de licencia vendible? (para validar entradas del CLI/bot). */
export const esTipoDeLicencia = (tipo) => Object.hasOwn(LICENSE_KIND_DAYS, tipo);

/** Una línea legible de una licencia pendiente. */
export const formatearLineaPendiente = (entrada, ahora = new Date()) => {
  const cliente = entrada.cliente?.nombre ?? '(sin consultorio)';
  const rif = entrada.cliente?.rif === undefined ? '' : ` · ${entrada.cliente.rif}`;
  const tipo = LICENSE_KIND_LABELS[entrada.tipo] ?? entrada.tipo;
  return (
    `· ${entrada.lic} · ${cliente}${rif} · ${tipo} · ` +
    `${textoVencimiento(entrada.venceEn, ahora)} · instalación ${instalacionCorta(entrada.instalacion)}`
  );
};

/** UUID abreviado (primeros 8) para listas; el completo sale en `/licencia <uuid>`. */
const instalacionCorta = (uuid) =>
  typeof uuid === 'string' && uuid.length > 8 ? uuid.slice(0, 8) : '—';

/** Texto de `/pendientes`: cabecera + filas, o el «no hay nada» explícito. */
export const formatearPendientes = (filas, { ahora = new Date(), dias = 30 } = {}) => {
  const cabecera = `Licencias que vencen en los próximos ${textoDias(dias)} (o ya vencidas), a ${fechaCorta(ahora.toISOString())}:`;
  if (filas.length === 0) {
    return `No hay licencias que venzan en los próximos ${textoDias(dias)} ni licencias vencidas sin renovar.`;
  }
  return [cabecera, ...filas.map((fila) => formatearLineaPendiente(fila, ahora))].join('\n');
};

/** Ficha completa de una licencia (`/licencia <uuid>` y `verificar`). */
export const formatearDetalleLicencia = (entrada, ahora = new Date()) => {
  if (entrada === null || entrada === undefined)
    return 'No hay licencias emitidas para esa instalación.';
  const tipo = LICENSE_KIND_LABELS[entrada.tipo] ?? entrada.tipo;
  const dias = LICENSE_KIND_DAYS[entrada.tipo];
  const vencida = Date.parse(entrada.venceEn) <= ahora.getTime();
  const lineas = [
    `Licencia ${entrada.lic}${vencida ? ' · VENCIDA' : ''}`,
    `  Consultorio: ${entrada.cliente?.nombre ?? '—'}${entrada.cliente?.rif === undefined ? '' : ` (${entrada.cliente.rif})`}`,
    `  Tipo: ${tipo}${dias === undefined ? '' : ` (${textoDias(dias)})`}`,
    `  Instalación: ${entrada.instalacion}`,
    `  Emitida: ${fechaCorta(entrada.emitidaEn)} · ${textoVencimiento(entrada.venceEn, ahora)}`,
    `  Archivo: ${entrada.archivo ?? `${entrada.lic}.lic`} · emitida por ${entrada.emitidaPor ?? '—'}`,
  ];
  if (entrada.renovacion === true && entrada.anterior !== null && entrada.anterior !== undefined) {
    lineas.push(
      `  Renovación de ${entrada.anterior.lic} (vencía el ${fechaCorta(entrada.anterior.venceEn)})`,
    );
  }
  if (entrada.notas !== undefined && entrada.notas !== '') lineas.push(`  Notas: ${entrada.notas}`);
  return lineas.join('\n');
};
