#!/usr/bin/env node
/**
 * OdontoCRM · prueba de los imprimibles: compone UN PDF con el Chromium de Playwright.
 *
 * Es la comprobación de EFECTO de los guiones de instalación de Windows: que exista
 * `chrome.exe` no prueba que arranque. El 2026-10-15 los imprimibles —récipe, factura y
 * reportes— fallaban con «EPERM … mkdtemp '…\Temp\playwright-artifacts-…'»: los procesos
 * de PM2 heredan el `%TEMP%` de la consola del administrador que los lanzó, y
 * `LocalService` (la cuenta del servicio) no puede escribir ahí.
 *
 * Los guiones ejecutan esta prueba con el MISMO entorno que tendrán los servicios
 * (`TMP`/`TEMP`/`TMPDIR` en `data\tmp` y `PLAYWRIGHT_BROWSERS_PATH` en
 * `data\ms-playwright`, igual que `ecosystem.produccion.config.cjs`), así que reproduce
 * —o descarta— ese fallo en la instalación y no en el mostrador de la consulta.
 *
 * ```
 * node infra\windows\instalar\probar-pdf.mjs [ruta-del-código]      # sale 0 si el PDF sale
 * ```
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const codigo = process.argv[2] ?? process.env.ODONTOCRM_CODE_DIR ?? process.cwd();

// `playwright` vive en el `node_modules` del CÓDIGO desplegado (no de este guion): se
// resuelve desde allí para que la prueba sirva aunque los guiones corran desde otro clon.
const require = createRequire(join(codigo, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error(`no encuentro «playwright» en ${codigo}: ¿terminó «npm ci»? (${error.message})`);
  process.exit(1);
}

try {
  const navegador = await chromium.launch({
    headless: true,
    // Los MISMOs argumentos que los tres renderers de PDF (récipe, factura y reportes).
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const pagina = await navegador.newPage();
    await pagina.setContent('<h1>OdontoCRM</h1>');
    const pdf = await pagina.pdf({ format: 'A5' });
    if (!pdf || pdf.length < 500) {
      throw new Error(`el PDF salió demasiado pequeño (${pdf ? pdf.length : 0} bytes)`);
    }
    console.log(`ok: Chromium compuso un PDF de ${pdf.length} bytes`);
  } finally {
    await navegador.close().catch(() => undefined);
  }
} catch (error) {
  console.error(`no pude componer el PDF: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
