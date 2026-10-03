import { jwtKeyPaths, loadIdentityConfig, REPO_ROOT } from './config.js';
import { generateKeyPairPem } from '@odontocrm/kernel';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Genera el par de claves EdDSA con el que se firman los JWT de acceso.
 *
 *   npm run build:node
 *   npm run keys:generate -w @odontocrm/identity            (no sobrescribe)
 *   npm run keys:generate -w @odontocrm/identity -- --force (regenera: invalida
 *                                                            todas las sesiones)
 *
 * Las rutas se resuelven contra la raíz del repositorio, así que funciona igual
 * desde la raíz o desde el directorio del servicio. La clave privada se escribe
 * con permisos 0600 y `.keys/` está ignorado por Git.
 */
const force = process.argv.includes('--force');

// Generar claves no necesita la base de datos: si la configuración no está
// completa, se usan las rutas por defecto del proyecto.
let privatePath: string;
let publicPath: string;
try {
  ({ privateKeyPath: privatePath, publicKeyPath: publicPath } = jwtKeyPaths(loadIdentityConfig()));
} catch {
  privatePath = resolve(REPO_ROOT, 'services/identity/.keys/jwt-private.pem');
  publicPath = resolve(REPO_ROOT, 'services/identity/.keys/jwt-public.pem');
}

if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
  // eslint-disable-next-line no-console -- script de línea de comandos
  console.error(
    `Ya existen claves en ${dirname(privatePath)}.\n` +
      'Si las regeneras, todas las sesiones activas dejan de valer: usa --force para confirmarlo.',
  );
  process.exit(1);
}

const { privatePem, publicPem } = await generateKeyPairPem();

mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, publicPem, { mode: 0o644 });

// eslint-disable-next-line no-console -- script de línea de comandos
console.log(
  `Claves EdDSA escritas:\n  privada: ${privatePath} (0600)\n  pública: ${publicPath}\n` +
    'Recuerda: nunca se versionan ni se comparten.',
);
