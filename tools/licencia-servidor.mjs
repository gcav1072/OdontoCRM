#!/usr/bin/env node
/**
 * Licencia de **la instalación**, desde la consola del servidor ([ADR 0075](../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 *   sudo odontocrm licencia                  estado + installationId + solicitud
 *   sudo odontocrm licencia solicitud        solo el texto ODO-REQ1.… para el proveedor
 *   sudo odontocrm licencia activar licencia.lic
 *
 * Existe para la instalación asistida y para soporte: activar una licencia no
 * exige abrir la interfaz. Habla con las rutas internas de identity usando el
 * MISMO entorno de producción que el resto de herramientas (`/etc/odontocrm` en
 * Fedora, `etc/env` en Windows) y el `INTERNAL_SERVICE_SECRET`; el `.lic` viaja
 * por HTTP a loopback y no se imprime en ningún mensaje.
 *
 * La licencia que llega aquí es un JWT firmado por el proveedor: activarla solo
 * **verifica** una firma. La clave privada no está en esta máquina.
 *
 * En desarrollo (sin `ODONTOCRM_ENV_DIR`) lee el `.env` de la raíz y el de
 * identity, igual que las demás herramientas de consola.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { entornoRaiz, leerEnv, rutaEnvDe, SERVICIOS } from './lib/servicios.mjs';

const AYUDA = [
  'OdontoCRM · licencia de la instalación',
  '',
  '  node tools/licencia-servidor.mjs                estado y solicitud',
  '  node tools/licencia-servidor.mjs solicitud      solo el texto para el proveedor',
  '  node tools/licencia-servidor.mjs activar <archivo.lic>',
  '',
  'Con el comando del servidor:',
  '  sudo odontocrm licencia [estado|solicitud|activar <archivo.lic>]',
].join('\n');

const TIMEOUT_MS = 10_000;
/** Un `.lic` son ~1 KB; 64 KiB es de sobra y evita pegar un archivo equivocado. */
const MAX_LICENCIA_BYTES = 64 * 1024;
const MAX_SOLICITUD_TEXTO = 4096;

const identidad = SERVICIOS.find((servicio) => servicio.name === 'identity');
const notificaciones = SERVICIOS.find((servicio) => servicio.name === 'notifications');

/** Une las fuentes de entorno con el mismo criterio que las demás herramientas. */
const resolverConexion = () => {
  const comun = entornoRaiz();
  const envIdentidad = identidad === undefined ? {} : leerEnv(rutaEnvDe(identidad));
  const envNotificaciones = notificaciones === undefined ? {} : leerEnv(rutaEnvDe(notificaciones));

  const puerto = comun.IDENTITY_PORT ?? envIdentidad.IDENTITY_PORT ?? '4001';
  const url = process.env.IDENTITY_URL ?? comun.IDENTITY_URL ?? `http://127.0.0.1:${puerto}`;

  const secreto =
    process.env.INTERNAL_SERVICE_SECRET ??
    comun.INTERNAL_SERVICE_SECRET ??
    envIdentidad.INTERNAL_SERVICE_SECRET ??
    envNotificaciones.INTERNAL_SERVICE_SECRET;

  return { url: url.replace(/\/+$/, ''), secreto };
};

const pedir = async (metodo, ruta, cuerpo) => {
  const { url, secreto } = resolverConexion();
  if (secreto === undefined || secreto === '') {
    throw new Error(
      'falta INTERNAL_SERVICE_SECRET: ejecútame con el entorno del servidor ' +
        '(sudo odontocrm licencia, o node tools/con-entorno.mjs /etc/odontocrm identity -- ...)',
    );
  }

  let respuesta;
  try {
    respuesta = await fetch(`${url}${ruta}`, {
      method: metodo,
      headers: {
        'content-type': 'application/json',
        'x-internal-token': secreto,
      },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (fallo) {
    const motivo = fallo instanceof Error ? fallo.message : String(fallo);
    throw new Error(`no pude hablar con identity en ${url}: ${motivo}`, { cause: fallo });
  }

  const datos = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    const detalle =
      datos !== null && typeof datos === 'object' && 'detail' in datos
        ? String(datos.detail)
        : `HTTP ${String(respuesta.status)}`;
    throw new Error(detalle);
  }
  return datos;
};

const fechaCorta = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Caracas',
});

const cuando = (iso) =>
  iso === null || iso === undefined ? '—' : fechaCorta.format(new Date(iso));

/** «vence el dd/mm/aaaa» o «sin vencimiento (vitalicia)». */
const textoVencimiento = (iso) =>
  iso === null || iso === undefined ? 'sin vencimiento (vitalicia)' : `vence el ${cuando(iso)}`;

const mostrarEstado = (vista) => {
  console.log('');
  console.log(
    `  Licencia · ${vista.consultorio.nombre}${vista.consultorio.rif === null ? '' : ` (${vista.consultorio.rif})`}`,
  );
  console.log(`  Estado:       ${vista.mensaje}`);
  console.log(`  Instalación:  ${vista.instalacion}`);
  console.log(`  Instalada el: ${cuando(vista.instaladaEn)}`);
  if (vista.licencia !== null) {
    console.log(
      `  Licencia:     ${vista.licencia.tipo} · ${vista.licencia.id} · ${textoVencimiento(vista.licencia.venceEn)}`,
    );
    console.log(`  Activada el:  ${cuando(vista.licencia.activadaEn)}`);
  } else {
    console.log('  Licencia:     ninguna (periodo de prueba)');
  }
  console.log('');
  console.log('  Solicitud para el proveedor (reenvía este texto):');
  console.log('');
  for (const linea of String(vista.solicitud.texto).split('\n')) console.log(`    ${linea}`);
  console.log('');
};

const activar = async (rutaArchivo) => {
  let contenido;
  if (rutaArchivo === '-' || rutaArchivo === undefined) {
    contenido = readFileSync(0, 'utf8');
  } else {
    const absoluta = resolve(rutaArchivo);
    if (!existsSync(absoluta)) throw new Error(`no existe el archivo ${absoluta}`);
    if (readFileSync(absoluta).byteLength > MAX_LICENCIA_BYTES) {
      throw new Error('el archivo es demasiado grande para ser una licencia (.lic)');
    }
    contenido = readFileSync(absoluta, 'utf8');
  }

  const licencia = contenido.trim();
  if (licencia === '') throw new Error('el archivo de licencia está vacío');

  const vista = await pedir('POST', '/internal/v1/licensing/activate', {
    licencia,
    motivo: 'activación desde la consola del servidor',
  });

  console.log('');
  console.log(`  ✔ Licencia activada · ${vista.consultorio.nombre}`);
  console.log(`  Estado:  ${vista.mensaje}`);
  if (vista.licencia !== null) {
    console.log(
      `  Licencia: ${vista.licencia.tipo} · ${vista.licencia.id} · ${textoVencimiento(vista.licencia.venceEn)}`,
    );
  }
  console.log('');
  console.log('  La interfaz y el bot de administración ya ven el estado nuevo (sin reiniciar).');
  console.log('');
};

const main = async () => {
  const [orden = 'estado', ...resto] = process.argv.slice(2);

  if (orden === '--ayuda' || orden === '-h' || orden === 'help' || orden === 'ayuda') {
    console.log(AYUDA);
    return 0;
  }

  if (orden === 'estado' || orden === 'status') {
    mostrarEstado(await pedir('GET', '/internal/v1/licensing/status'));
    return 0;
  }

  if (orden === 'solicitud') {
    const vista = await pedir('GET', '/internal/v1/licensing/status');
    const texto = String(vista.solicitud.texto);
    console.log(texto.length <= MAX_SOLICITUD_TEXTO ? texto : texto.slice(0, MAX_SOLICITUD_TEXTO));
    return 0;
  }

  if (orden === 'activar') {
    await activar(resto[0]);
    return 0;
  }

  console.error(`orden desconocida: ${orden}\n\n${AYUDA}`);
  return 2;
};

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((fallo) => {
    console.error(`\n  ✖ ${fallo instanceof Error ? fallo.message : String(fallo)}\n`);
    process.exitCode = 1;
  });
