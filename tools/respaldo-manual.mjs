#!/usr/bin/env node
/**
 * **Respaldo completo a mano**: bases + configuración + almacén, en el servidor.
 *
 * ```
 * npm run respaldo:manual
 * npm run respaldo:manual -- --dest D:\respaldo-prueba    # otra carpeta (pruebas)
 * npm run respaldo:manual -- --conservar 3               # cuántas copias se guardan
 * ```
 *
 * Es **la misma pieza** que responde `/respaldo` en el bot de administración (Telegram): esta
 * herramienta existe para poder hacerlo sin Telegram —desde una consola, en mantenimiento o
 * para probarlo— y para que la prueba no dependa del bot.
 *
 * **Por qué no llama al respaldo nocturno.** `odontocrm-backup.sh`/`odontocrm-backup.ps1` solo se
 * pueden lanzar como Administrador (Windows) o root (Fedora) y leen el `.pgpass`, que en Windows
 * es de solo Administradores: el bot corre como `LocalService` y no podría. Aquí se volca cada
 * base con el `DATABASE_URL` de **su propio servicio** (como `/respaldos`), y lo que se añade es
 * el almacén y la configuración, con los nombres y el formato que esperan
 * `odontocrm recuperar --from DIR` y `npm run verify:backup -- --from DIR`.
 *
 * **Lo que queda en la carpeta**: un `<base>.dump` por servicio (más `odonto_events`, la cola),
 * el archivo del almacén, el de la configuración (CONTINENE SECRETOS), `SHA256SUMS` y
 * `manifest.txt`. Cada copia se lleva el almacén entero, así que la retención es corta
 * (`--conservar`, 5 por defecto); y si algo no se pudo copiar, se dice —una copia a la que le
 * falta un bloque no sirve, y hay que saberlo ahora y no el día del desastre—.
 *
 * Sale con 1 si falló el volcado de alguna base (la copia existe, pero no está completa).
 */
import { formatearRespaldoCompleto, tomarRespaldoCompleto } from './lib/admin-informes.mjs';

const args = process.argv.slice(2);

const valorDe = (nombre) => {
  const directo = args.find((arg) => arg.startsWith(`${nombre}=`));
  if (directo !== undefined) return directo.slice(nombre.length + 1);
  const indice = args.indexOf(nombre);
  return indice === -1 ? undefined : args[indice + 1];
};

if (args.includes('--ayuda') || args.includes('--help') || args.includes('-h')) {
  console.log(
    'Uso: npm run respaldo:manual [-- --dest DIR | --conservar N | --json]\n\n' +
      '  --dest DIR      carpeta raíz de las copias (por defecto, la del sistema)\n' +
      '  --conservar N   cuántas copias se conservan (por defecto, 5)\n' +
      '  --json          resultado en JSON (para guiones)\n',
  );
  process.exit(0);
}

const conservar = Number.parseInt(valorDe('--conservar') ?? '', 10);

const resultado = await tomarRespaldoCompleto({
  destino: valorDe('--dest'),
  conservar: Number.isInteger(conservar) && conservar > 0 ? conservar : undefined,
});

if (args.includes('--json')) {
  console.log(JSON.stringify(resultado, null, 2));
} else {
  console.log(formatearRespaldoCompleto(resultado));
}

process.exitCode = resultado.fallos.length > 0 ? 1 : 0;
