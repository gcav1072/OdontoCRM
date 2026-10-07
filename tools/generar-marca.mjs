#!/usr/bin/env node
/**
 * Genera `packages/ui/src/styles/marca.css` desde la fuente única de marca
 * (`packages/contracts/src/brand.ts`).
 *
 *   npm run marca:css
 *   npm run marca:css -- --check   (no escribe: falla si el CSS está desfasado)
 *
 * La SPA no puede importar el TypeScript de los contratos como hoja de estilo, y
 * las plantillas del servidor no pueden `@import` un archivo del repositorio: por
 * eso los dos leen del MISMO sitio (`brand.ts`) y este guion deja el `.css` de la
 * web en disco.
 *
 * Usa el `dist` del contrato (como `tools/telegram-menu.mjs`), así que requiere
 * `npm run build:node` antes. Si alguien edita la marca y no regenera, la prueba
 * `packages/contracts/src/brand.test.ts` lo denuncia.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const comprobar = process.argv.includes('--check');
const destino = resolve(ROOT, 'packages/ui/src/styles/marca.css');

const dist = resolve(ROOT, 'packages/contracts/dist/brand.js');
if (!existsSync(dist)) {
  console.error('Falta packages/contracts/dist. Ejecuta antes "npm run build:node".');
  process.exit(1);
}

const { brandRootBlock } = await import(`file://${dist.replace(/\\/g, '/')}`);

const cabecera = `/**
 * Variables CSS de marca (\`--brand-*\`): paleta, tipografías y medidas del
 * membrete de la interfaz y de los documentos impresos.
 *
 * ARCHIVO GENERADO — no lo edites a mano. La fuente única es
 * \`packages/contracts/src/brand.ts\`; se regenera con \`npm run marca:css\`.
 */
`;

const contenido = `${cabecera}\n${brandRootBlock()}\n`;

if (comprobar) {
  const actual = existsSync(destino) ? readFileSync(destino, 'utf8') : '';
  if (actual !== contenido) {
    console.error('marca.css está desfasado respecto a brand.ts: ejecuta "npm run marca:css".');
    process.exit(1);
  }
  console.log('marca.css coincide con brand.ts ✔');
  process.exit(0);
}

const anterior = existsSync(destino) ? readFileSync(destino, 'utf8') : null;
if (anterior === contenido) {
  console.log('marca.css ya estaba al día: no se toca.');
  process.exit(0);
}

writeFileSync(destino, contenido, 'utf8');
console.log(`marca.css ${anterior === null ? 'creado' : 'actualizado'}: ${destino}`);
