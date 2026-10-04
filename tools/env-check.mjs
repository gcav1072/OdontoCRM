#!/usr/bin/env node
/**
 * Comprueba que los `.env` de los servicios tengan las claves de su plantilla.
 *
 *   npm run env:check            → informa y falla si falta algo esperado
 *   npm run env:check -- --todo  → informa de todo (incluidos los .env ausentes)
 *
 * Es la comprobación que faltaba cuando un corte de luz dejó los ocho `.env` con el
 * contenido a ceros: al rehacerlos se perdió el `TELEGRAM_BOT_TOKEN` (no lo escribe
 * `db:bootstrap`) y el bot pasó a modo simulado sin avisar. Ver
 * `tools/lib/entorno.mjs` y docs/COMANDOS.md §4.
 *
 * **No imprime valores**, solo nombres de claves: un `.env` no se enseña en pantalla.
 */
import { relative } from 'node:path';

import { revisarEntornos } from './lib/entorno.mjs';
import { ROOT } from './lib/mantenimiento.mjs';

const todo = process.argv.includes('--todo');
const { faltantes, sinPlantilla, sinEnv, consecuencia } = revisarEntornos();

const ruta = (absoluta) => relative(ROOT, absoluta).replaceAll('\\', '/');

if (sinEnv.length > 0 && todo) {
  console.log('servicios sin `.env` (los escribe `npm run db:bootstrap`):');
  for (const servicio of sinEnv) console.log(`  · ${servicio}`);
}

if (sinPlantilla.length > 0) {
  console.warn(
    `sin plantilla (.env.example): ${sinPlantilla.join(', ')}\n` +
      '  Sin plantilla no se puede saber qué claves faltan; conviene escribirla.\n',
  );
}

if (faltantes.length === 0) {
  console.log('env:check: los .env tienen todas las claves de su plantilla ✔');
  process.exit(0);
}

console.error('env:check: a estos .env les faltan claves que su plantilla espera:\n');
for (const { servicio, archivo, claves } of faltantes) {
  console.error(`  ✖ ${servicio.padEnd(14)} ${ruta(archivo)}`);
  for (const clave of claves) {
    console.error(
      `      · ${clave}${consecuencia[clave] === undefined ? '' : ` → ${consecuencia[clave]}`}`,
    );
  }
}

console.error(
  '\nQué hacer:\n' +
    '  · Copia las claves que falten desde su plantilla: services/<servicio>/.env.example\n' +
    '  · Las de la base las repone:  npm run db:bootstrap\n' +
    '  · El token del bot lo da BotFather (/mybots → tu bot → API Token) y va en\n' +
    '    services/notifications/.env; después: pm2 restart odontocrm-notifications\n' +
    '  · Detalle: docs/COMANDOS.md §4 y docs/SEGURIDAD_SECRETOS.md\n',
);

process.exit(1);
