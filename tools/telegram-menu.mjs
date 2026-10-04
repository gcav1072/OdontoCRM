#!/usr/bin/env node
/**
 * Muestra el menú de comandos que **Telegram tiene registrado** para el bot y lo
 * compara con el catálogo del contrato (`BOT_COMMANDS`).
 *
 *   npm run telegram:menu            (usa el token de services/notifications/.env)
 *   npm run telegram:menu -- --set   (vuelve a registrarlo, por si se desincronizó)
 *
 * Sirve para responder a «no me sale el menú»: si aquí aparece y en el móvil no,
 * el problema es la caché de la aplicación de Telegram (se cierra y se abre).
 * Requiere `npm run build:node` (usa el `dist` del servicio).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const aplicar = process.argv.includes('--set');

const leerEnv = (ruta, clave) => {
  const camino = resolve(ROOT, ruta);
  if (!existsSync(camino)) return undefined;
  return new RegExp(`^${clave}=(.*)$`, 'm').exec(readFileSync(camino, 'utf8'))?.[1]?.trim();
};

const dist = resolve(ROOT, 'services/notifications/dist');
if (!existsSync(dist)) {
  console.error('Falta services/notifications/dist. Ejecuta antes "npm run build:node".');
  process.exit(1);
}

const { BOT_COMMANDS, toMenuCommands } = await import(
  `file://${resolve(ROOT, 'packages/contracts/dist/index.js').replace(/\\/g, '/')}`
);
const { loadNotificationsConfig } = await import(
  `file://${resolve(dist, 'config.js').replace(/\\/g, '/')}`
);
const { createHttpTransport } = await import(
  `file://${resolve(dist, 'canales/telegram-api.js').replace(/\\/g, '/')}`
);

const token = leerEnv('services/notifications/.env', 'TELEGRAM_BOT_TOKEN');
if (token === undefined || token === '') {
  console.error(
    'No hay TELEGRAM_BOT_TOKEN en services/notifications/.env: sin token el bot está en modo\n' +
      'simulado y no hay menú que consultar. Configúralo y reinicia el servicio.',
  );
  process.exit(1);
}

const config = loadNotificationsConfig({
  DATABASE_URL:
    leerEnv('services/notifications/.env', 'DATABASE_URL') ??
    'postgres://odonto_notifications:clave@127.0.0.1:5432/odonto_notifications',
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_MODE: 'real',
  LOG_LEVEL: 'silent',
});

const transport = createHttpTransport(config, token);

const identidad = await transport.getMe().catch(() => null);
console.log(
  `Bot: ${identidad?.username === null || identidad === null ? '(sin identificar)' : `@${identidad.username}`}`,
);

if (aplicar) {
  await transport.setMyCommands(toMenuCommands());
  await transport.setChatMenuButton();
  console.log('Menú registrado de nuevo desde el catálogo del contrato.');
}

const registrado = await transport.getMyCommands();
console.log('\nMenú en Telegram:');
for (const comando of registrado) {
  console.log(`  /${comando.command.padEnd(12)} ${comando.description}`);
}

const esperado = BOT_COMMANDS.map(({ comando, descripcion }) => ({
  command: comando,
  description: descripcion,
}));
const iguales =
  registrado.length === esperado.length &&
  esperado.every((comando, indice) => registrado[indice]?.command === comando.command);

console.log(`\nCatálogo del contrato: ${String(esperado.length)} comando(s)`);
if (iguales) {
  console.log('El menú de Telegram coincide con el catálogo ✔');
} else {
  console.error('El menú de Telegram NO coincide: ejecuta  npm run telegram:menu -- --set');
  process.exitCode = 1;
}
