#!/usr/bin/env node
/**
 * **Quita del servidor las cuentas de PRUEBA** que sembraba el seed.
 *
 * ```
 * node tools/purgar-cuentas-prueba.mjs            # enseña qué haría (no toca nada)
 * node tools/purgar-cuentas-prueba.mjs --si       # las DESACTIVA (recomendado)
 * node tools/purgar-cuentas-prueba.mjs --si --borrar   # las elimina de verdad
 * ```
 *
 * **Por qué existe.** `services/identity/src/seed.ts` crea, además del `admin`, dos cuentas
 * que son personal **de prueba** —«Recepción prueba» (`recepcion`) y el odontólogo de
 * `CLINIC.dentists` («Odontólogo prueba»)—. El instalador siembra solo `admin`, pero
 * `odontocrm actualizar` llegó a sembrar el juego completo en producción (el defecto de
 * `30-desplegar.sh`), y las cuentas quedaron ahí. Esto las retira sin tocar al personal real.
 *
 * **Es prudente.** Por defecto solo DESACTIVA (`is_active = false`): la cuenta no puede entrar
 * pero su rastro queda. Con `--borrar` se elimina (la cascada se lleva roles, sesiones y
 * tokens). En ambos casos se comprueba que el nombre coincida con el de la cuenta sembrada
 * antes de tocarla: si un consultorio tuvo la mala idea de usar el usuario `prueba` para una
 * persona real, esto se niega y lo avisa (con `--forzar` se salta esa comprobación).
 *
 * La base es la de **identity**: se lee `DATABASE_URL` del entorno (lo pone `con-entorno`).
 */
import pg from 'pg';

import { CLINIC } from '@odontocrm/contracts';

const { Client } = pg;

const args = process.argv.slice(2);
const CONOCIDAS = [
  '--si',
  '--desactivar',
  '--borrar',
  '--dry-run',
  '--forzar',
  '--ayuda',
  '--help',
];
const desconocida = args.find((arg) => arg.startsWith('--') && !CONOCIDAS.includes(arg));

const ok = (m) => console.log(`  ✔ ${m}`);
const aviso = (m) => console.log(`  ! ${m}`);
const error = (m) => console.error(`  ✖ ${m}`);
const detalle = (m) => console.log(`      ${m}`);

if (args.includes('--ayuda') || args.includes('--help')) {
  console.log(
    'Uso: node tools/purgar-cuentas-prueba.mjs [--si] [--desactivar | --borrar] [--forzar] [--dry-run]\n\n' +
      '  (sin --si)     enseña qué haría, SIN tocar nada\n' +
      '  --si           lo hace: desactiva las cuentas de prueba (por defecto)\n' +
      '  --desactivar   solo pone is_active=false (por defecto; conserva el rastro)\n' +
      '  --borrar       las elimina de la base (cascada: roles, sesiones, tokens)\n' +
      '  --forzar       no exige que el nombre coincida con el de la cuenta sembrada\n' +
      '  --dry-run      igual que no poner --si\n',
  );
  process.exit(0);
}
if (desconocida !== undefined) {
  error(`Bandera desconocida: ${desconocida}. Opciones: ${CONOCIDAS.join(', ')}`);
  process.exit(1);
}

const asumir = args.includes('--si');
const dry = args.includes('--dry-run') || !asumir;
const borrar = args.includes('--borrar');
const forzar = args.includes('--forzar');

/** Las cuentas que crea el seed de prueba: `recepcion` + un odontólogo por `CLINIC.dentists`. */
const OBJETIVOS = [
  { username: 'recepcion', nombreEsperado: 'Recepción prueba', rol: 'secretario' },
  ...CLINIC.dentists.map((dentista) => ({
    username: dentista.username,
    nombreEsperado: dentista.fullName,
    rol: 'odontologo',
  })),
];

const url = process.env.DATABASE_URL;
if (url === undefined || url.trim() === '') {
  error('falta DATABASE_URL (usa: sudo odontocrm purgar-prueba)');
  process.exit(1);
}

const normalizar = (texto) => texto.replace(/\s+/g, ' ').trim().toLowerCase();
const acciones = [];

const cliente = new Client({ connectionString: url });
try {
  await cliente.connect();

  console.log(
    `\nCuentas de prueba a ${borrar ? 'ELIMINAR' : 'desactivar'} en la base de identidad` +
      `${dry ? '  (sin --si: solo se muestra)' : ''}\n`,
  );

  for (const objetivo of OBJETIVOS) {
    const fila = await cliente.query(
      'SELECT id, full_name, is_active FROM users WHERE lower(username) = lower($1) LIMIT 1',
      [objetivo.username],
    );
    if (fila.rowCount === 0) {
      detalle(`«${objetivo.username}»: no existe (nada que hacer)`);
      continue;
    }
    const { id, full_name: nombre, is_active: activa } = fila.rows[0];

    // La salvaguarda: no tocar una cuenta cuyo nombre no sea el de la cuenta sembrada.
    if (!forzar && normalizar(nombre) !== normalizar(objetivo.nombreEsperado)) {
      error(
        `«${objetivo.username}» tiene el nombre «${nombre}», no «${objetivo.nombreEsperado}»: ` +
          'NO la toco (¿es una persona real? usa --forzar si estás seguro)',
      );
      continue;
    }

    acciones.push({ ...objetivo, id, nombre, activa });
    detalle(
      `«${objetivo.username}» (${nombre}, rol ${objetivo.rol})${activa ? '' : ' — ya inactiva'}`,
    );
  }

  if (acciones.length === 0) {
    console.log();
    ok('no hay cuentas de prueba que quitar');
    await cliente.end();
    process.exit(0);
  }

  if (dry) {
    console.log();
    aviso(
      `se ${borrar ? 'eliminarían' : 'desactivarían'} ${String(acciones.length)} cuenta(s). ` +
        'Para hacerlo de verdad:  sudo odontocrm purgar-prueba --si' +
        (borrar ? ' --borrar' : ''),
    );
    await cliente.end();
    process.exit(10);
  }

  let hechas = 0;
  for (const cuenta of acciones) {
    if (borrar) {
      await cliente.query('DELETE FROM users WHERE id = $1', [cuenta.id]);
    } else {
      await cliente.query('UPDATE users SET is_active = false, updated_at = now() WHERE id = $1', [
        cuenta.id,
      ]);
    }
    hechas += 1;
  }

  console.log();
  ok(`${String(hechas)} cuenta(s) de prueba ${borrar ? 'eliminada(s)' : 'desactivada(s)'}`);
  if (!borrar) {
    detalle('siguen en la base, pero no pueden entrar; borrar de verdad: --borrar');
  } else {
    detalle('si alguna firmaba documentos, el récipe conserva su nombre (issued_by_username)');
  }
} catch (fallo) {
  error(`no pude purgar las cuentas: ${fallo instanceof Error ? fallo.message : String(fallo)}`);
  process.exitCode = 1;
} finally {
  await cliente.end().catch(() => {});
}
