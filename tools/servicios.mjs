#!/usr/bin/env node
/**
 * OdontoCRM · la lista de servicios, para que la lean TODOS los guiones.
 *
 * Existe porque las listas escritas a mano ya fallaron tres veces al entrar `billing`:
 * el despliegue no esperaba su puerto, una comprobación de seguridad no lo miraba y la
 * copia diaria no lo incluía… diciendo «respaldo completado sin errores». El instalador de
 * Fedora resolvió esto con `infra/fedora/lib/servicios.sh`. Este comando es lo mismo para
 * el instalador de Windows (y para cualquier guion .sh que quiera el JSON).
 *
 * La fuente es una sola y es el propio repositorio: **una carpeta `services/<x>/` con
 * `migrations/`** y su puerto declarado en `.env.example` (`<X>_PORT`). El gateway va
 * aparte (no tiene base).
 *
 * ```
 * npm run servicios                # tabla legible
 * npm run servicios -- --json      # la lista completa, en JSON (la consumen los .ps1)
 * npm run servicios -- --puertos   # solo los puertos internos, uno por línea
 * ```
 */
import { PROCESOS, ROOT, rutaEnvRaiz, SERVICIOS } from './lib/servicios.mjs';

const args = process.argv.slice(2);
const CONOCIDAS = ['--json', '--puertos', '--ayuda', '-h', '--help'];
const desconocida = args.find((arg) => arg.startsWith('-') && !CONOCIDAS.includes(arg));
const pideAyuda = args.some((arg) => ['--ayuda', '-h', '--help'].includes(arg));

if (desconocida !== undefined || pideAyuda) {
  console.log(
    'Uso: npm run servicios [-- --json | --puertos]\n\n' +
      '  --json     servicios, puertos, bases y unidades (lo leen los guiones)\n' +
      '  --puertos  solo los puertos internos que NO deben publicarse, uno por línea\n',
  );
  process.exit(desconocida === undefined ? 0 : 2);
}

const puertoDe = (nombre) => PROCESOS.find((proceso) => proceso.name === nombre)?.port ?? 0;
const puertoGateway = puertoDe('gateway');

const foto = {
  raiz: ROOT,
  envRaiz: rutaEnvRaiz(),
  produccion: (process.env.ODONTOCRM_ENV_DIR ?? '') !== '',
  envDir: process.env.ODONTOCRM_ENV_DIR ?? null,
  puertoGateway,
  servicios: SERVICIOS.map((servicio) => ({
    nombre: servicio.name,
    puerto: puertoDe(servicio.name),
    base: servicio.database,
    unidad: `odontocrm@${servicio.name}`,
    proceso: `odontocrm-${servicio.name}`,
  })),
  procesos: PROCESOS.map((proceso) => ({
    nombre: proceso.name,
    puerto: proceso.port,
    variable: proceso.variable,
    unidad: proceso.unidad ?? `odontocrm@${proceso.name}`,
    proceso: `odontocrm-${proceso.name}`,
  })),
  // La cola (pg-boss) es una base más, compartida por todos los servicios.
  bases: [...SERVICIOS.map((servicio) => servicio.database), 'odonto_events'],
  // Lo que NO puede quedar publicado: la base, cada servicio y la puerta.
  puertosInternos: [5432, ...SERVICIOS.map((servicio) => puertoDe(servicio.name)), puertoGateway],
};

if (args.includes('--puertos')) {
  for (const puerto of foto.puertosInternos) console.log(String(puerto));
} else if (args.includes('--json')) {
  console.log(JSON.stringify(foto, null, 2));
} else {
  const ancho = Math.max('gateway'.length, ...foto.servicios.map((s) => s.nombre.length));
  console.log(`\nOdontoCRM · servicios (según ${ROOT})\n`);
  for (const servicio of foto.servicios) {
    console.log(
      `  ${servicio.nombre.padEnd(ancho)}  ${String(servicio.puerto).padEnd(5)} ${servicio.base}`,
    );
  }
  console.log(
    `  ${'gateway'.padEnd(ancho)}  ${String(puertoGateway).padEnd(5)} (puerta: sin base)`,
  );
  console.log(`\n  puertos internos (no publicar): ${foto.puertosInternos.join(', ')}\n`);
}
