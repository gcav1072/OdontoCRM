#!/usr/bin/env node
/**
 * Preflight de `npm run dev`: comprueba que los puertos que va a necesitar estén
 * **libres** y, si no lo están, dice quién los ocupa, desde cuándo y cómo liberarlos.
 *
 *   npm run dev:check          (se ejecuta solo antes de `npm run dev`)
 *   npm run dev:check -- --all (no falla: solo informa)
 *
 * Existe por un caso real: un servidor de Vite de una sesión anterior seguía
 * ocupando el 5173 con el grafo de módulos roto; `npm run dev` no podía tomar el
 * puerto (`strictPort`), `concurrently -k` mataba el resto y el navegador seguía
 * mirando el servidor viejo: pantalla en negro sin ningún mensaje.
 *
 * Desde que la pila se cambia de modo con `npm run stack:*`, este preflight es la
 * puerta de `npm run dev`: la regla es **una sola pila a la vez**.
 */
import { cuando, retratoDeLaPila } from './lib/stack.mjs';

const soloInformar = process.argv.includes('--all');
const retrato = await retratoDeLaPila();

if (retrato.ocupados.length === 0) {
  console.log('dev:check: los puertos del desarrollo están libres ✔');
  process.exit(0);
}

console.error('dev:check: hay puertos ocupados y `npm run dev` los necesita todos:\n');
for (const entrada of retrato.ocupados) {
  const quien =
    entrada.pid === null ? entrada.nombre : `${entrada.nombre} (PID ${String(entrada.pid)})`;
  console.error(
    `  ✖ ${String(entrada.puerto).padStart(4)} · ${entrada.servicio.padEnd(14)} → ${quien}` +
      `  desde ${cuando(entrada.desde)}${entrada.conWatch ? ' · con recarga' : ''}`,
  );
}

const conPm2 = retrato.ocupados.some((entrada) => entrada.pm2 !== null);

console.error('\nQué hacer:');
if (conPm2) {
  console.error(
    '  · La pila la tiene PM2 (o procesos sueltos de un `start:*`), que ocupan los mismos puertos.\n' +
      '      Cambiar de modo:   npm run stack:dev    (con recarga: para la anterior y arranca esta)\n' +
      '      Ver qué corre:     npm run stack:status\n' +
      '      Sola la web:       npm run dev:web      (usa el 5173, si está libre)',
  );
} else {
  console.error(
    '  · Suele ser un `npm run dev` o un Vite de una sesión anterior que quedó vivo.\n' +
      '      Parar y arrancar:  npm run stack:dev',
  );
}
console.error('  · Ver solo el estado, sin fallar:   npm run dev:check -- --all\n');

process.exit(soloInformar ? 0 : 1);
