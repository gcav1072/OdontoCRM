#!/usr/bin/env node
/**
 * **Aceptación de la Fase 10**: el día completo de la clínica, de punta a punta.
 *
 * ```
 * npm run e2e:clinica                 # todo (incluye las pruebas de navegador)
 * npm run e2e:clinica -- --rapido     # sin navegador (API y pantallas por HTTP)
 * npm run e2e:clinica -- --solo reportes
 * npm run e2e:clinica -- --desde recetas
 * ```
 *
 * Recorre, en orden, lo que el plan pide como criterio de aceptación —«pruebas
 * end-to-end del flujo completo: solicitud por bot → programación → notificación
 * con `.ics` → secretaría → consultorio → historia/sesión/récipe → reportes →
 * auditoría»— encadenando las pruebas que ya existen, cada una por el camino real
 * (gateway y navegador), no por dentro de los servicios.
 *
 * No inventa una prueba nueva: **ordena las que hay** y da un solo veredicto, que
 * es lo que hace falta para decir «la fase está aceptada». Si un paso falla, se
 * detiene y dice cuál (con `--seguir` continúa y resume al final, útil para ver
 * todos los fallos de una corrida).
 *
 * Antes: la pila arriba (`npm run stack:dev`) y el mundo sembrado
 * (`npm run seed:test`). Al terminar, las pruebas de humo dejan contraseñas
 * cambiadas: el último paso las restaura (`npm run seed:users -- --reset`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const CONOCIDAS = ['--rapido', '--seguir', '--solo', '--desde', '--sin-bot', '--ayuda'];
const desconocida = args.find((arg) => arg.startsWith('--') && !CONOCIDAS.includes(arg));
const valor = (bandera) => {
  const indice = args.indexOf(bandera);
  return indice === -1 ? undefined : args[indice + 1];
};

const rapido = args.includes('--rapido');
const seguir = args.includes('--seguir');
/**
 * `--sin-bot`: esta instalación todavía no tiene el bot configurado (la PC de
 * pruebas antes de poner el token). La parte del bot se marca como **pendiente** en
 * lugar de fallar; sin esta bandera, no tenerlo es un fallo, porque la aceptación de
 * la fase incluye la notificación con `.ics`.
 */
const sinBot = args.includes('--sin-bot');
const solo = valor('--solo');
const desde = valor('--desde');

/**
 * Los pasos del día, en orden. Cada uno dice **qué parte del flujo cubre**, que es
 * lo que se lee cuando algo falla.
 */
const PASOS = [
  {
    id: 'acceso',
    titulo: 'Acceso y sesión',
    cubre: 'entrar, roles y permisos',
    script: 'tools/smoke-auth.mjs',
  },
  {
    id: 'bot',
    titulo: 'Solicitud por el bot',
    cubre: 'asistente del bot, vinculación y aviso con el .ics',
    script: 'tools/smoke-notifications.mjs',
  },
  {
    id: 'agenda',
    titulo: 'Programación de la cita',
    cubre: 'ticket, cupo, franja, sobrecupo, reprogramación y aviso en lote',
    script: 'tools/smoke-agenda.mjs',
  },
  {
    id: 'pantallas',
    titulo: 'Secretaría y pantallas',
    cubre: 'llegada, llamado en el lobby por SSE y pantalla del consultorio',
    script: 'tools/smoke-screens.mjs',
  },
  {
    id: 'pacientes',
    titulo: 'Registro de pacientes',
    cubre: 'alta, duplicado, edición con motivo y borrado lógico',
    script: 'tools/smoke-patients.mjs',
  },
  {
    id: 'clinica',
    titulo: 'Historia y sesión clínica',
    cubre: 'historia firmada, sesión cerrada y «atendido» con respaldo',
    script: 'tools/smoke-clinical-session.mjs',
  },
  {
    id: 'odontograma',
    titulo: 'Odontograma',
    cubre: 'boca por teclado, superación de caras y auditoría',
    script: 'tools/smoke-odontogram.mjs',
  },
  {
    id: 'recetas',
    titulo: 'Récipes A5',
    cubre: 'emisión con PDF, verificación por QR, anulación y reimpresión',
    script: 'tools/smoke-prescription.mjs',
  },
  {
    id: 'reportes',
    titulo: 'Reportes, KPIs y auditoría',
    cubre: 'los seis reportes, CSV/PDF, permisos y el cambio auditado',
    script: 'tools/smoke-reporting.mjs',
  },
  {
    id: 'interfaz-flujo',
    titulo: 'El día en `/flujo` (navegador)',
    cubre: 'la doctora lleva el día completo desde una sola pantalla',
    script: 'tools/e2e-flujo.mjs',
    navegador: true,
  },
  {
    id: 'interfaz-reportes',
    titulo: '`/reportes` y `/auditoria` (navegador)',
    cubre: 'seis pestañas, filtros, descargas y el diff de la auditoría',
    script: 'tools/e2e-reportes.mjs',
    navegador: true,
  },
];

if (desconocida !== undefined || args.includes('--ayuda')) {
  console.log(
    'Uso: npm run e2e:clinica [-- --rapido | --sin-bot | --solo <paso> | --desde <paso> | --seguir]\n\n' +
      `Pasos: ${PASOS.map((paso) => paso.id).join(', ')}\n`,
  );
  process.exit(desconocida === undefined ? 0 : 1);
}

let seleccionados = PASOS.filter((paso) => (rapido ? paso.navegador !== true : true));
if (solo !== undefined) {
  const paso = PASOS.find((item) => item.id === solo);
  if (paso === undefined) {
    console.error(
      `No hay un paso llamado "${solo}". Opciones: ${PASOS.map((p) => p.id).join(', ')}`,
    );
    process.exit(2);
  }
  seleccionados = [paso];
} else if (desde !== undefined) {
  const indice = PASOS.findIndex((item) => item.id === desde);
  if (indice === -1) {
    console.error(
      `No hay un paso llamado "${desde}". Opciones: ${PASOS.map((p) => p.id).join(', ')}`,
    );
    process.exit(2);
  }
  const desdeEse = PASOS.slice(indice);
  seleccionados = rapido ? desdeEse.filter((paso) => paso.navegador !== true) : desdeEse;
}

const color = {
  ok: (texto) => `\u001b[32m${texto}\u001b[0m`,
  error: (texto) => `\u001b[31m${texto}\u001b[0m`,
  tenue: (texto) => `\u001b[2m${texto}\u001b[0m`,
  titulo: (texto) => `\u001b[1m${texto}\u001b[0m`,
};

/** El puerto del gateway, para comprobar antes de empezar que hay pila. */
const puertoGateway = (() => {
  try {
    const linea = readFileSync(resolve(ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((texto) => texto.startsWith('GATEWAY_PORT='));
    return Number(linea?.split('=')[1] ?? '8090') || 8090;
  } catch {
    return 8090;
  }
})();

const restaurarContrasenas = () => {
  // Los DOS archivos de entorno, como el script `seed:users`: sin el de identity no
  // hay DATABASE_URL y el seed no puede regenerar nada (fallaba en silencio).
  const resultado = spawnSync(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--env-file-if-exists=services/identity/.env',
      'services/identity/dist/seed.js',
      '--reset',
    ],
    { cwd: ROOT, stdio: 'ignore' },
  );
  if (resultado.status !== 0) {
    console.warn(
      '  ! No se pudieron restaurar las contraseñas sembradas (¿falta el build?): ' +
        'npm run seed:users -- --reset',
    );
  }
};

/**
 * Antes de recorrer nada: ¿hay pila? ¿están las contraseñas sembradas?
 *
 * Las pruebas de humo y las de navegador **cambian la contraseña del
 * administrador** (a `prueba-e2e-odontocrm-2026`); si la corrida anterior se cortó
 * antes del final, la siguiente empezaría con un login fallido y un mensaje que no
 * explica nada. Se restauran al empezar y al terminar.
 */
const preparar = async () => {
  try {
    const respuesta = await fetch(`http://127.0.0.1:${String(puertoGateway)}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!respuesta.ok) throw new Error(`HTTP ${String(respuesta.status)}`);
  } catch (fallo) {
    console.error(
      `\n${color.error('✖')} La pila no responde en http://127.0.0.1:${String(puertoGateway)}/health` +
        ` (${fallo instanceof Error ? fallo.message : String(fallo)}).\n` +
        '  Arráncala primero:  npm run stack:dev\n' +
        '  Y siembra el mundo: npm run seed:test\n',
    );
    process.exit(2);
  }

  restaurarContrasenas();
};

const segundos = (ms) => `${(ms / 1000).toFixed(1)} s`;
const resultados = [];

await preparar();

console.log('');
console.log(
  color.titulo(`OdontoCRM · aceptación del flujo completo (${String(seleccionados.length)} pasos)`),
);
if (rapido) console.log(color.tenue('  modo rápido: sin pruebas de navegador'));

for (const [indice, paso] of seleccionados.entries()) {
  const numero = String(indice + 1).padStart(2, ' ');
  console.log('');
  console.log(color.titulo(`${numero}. ${paso.titulo}`));
  console.log(color.tenue(`     cubre: ${paso.cubre}`));

  const empezado = Date.now();
  const resultado = spawnSync(process.execPath, [resolve(ROOT, paso.script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Solo el paso del bot entiende esta variable: en las demás no hace nada.
      ...(sinBot ? { SMOKE_BOT_OPCIONAL: '1' } : {}),
    },
  });
  const duracion = Date.now() - empezado;

  resultados.push({
    id: paso.id,
    titulo: paso.titulo,
    ok: resultado.status === 0,
    ms: duracion,
    status: resultado.status,
  });
  console.log(
    `  ${resultado.status === 0 ? color.ok('✔') : color.error('✖')} ${paso.titulo} · ${segundos(duracion)}`,
  );

  if (resultado.status !== 0 && !seguir) {
    console.log('');
    console.log(color.error(`Se detuvo en «${paso.titulo}» (código ${String(resultado.status)}).`));
    console.log('  · Corrige lo que dice arriba y vuelve a empezar, o salta a este paso con:');
    console.log(`      npm run e2e:clinica -- --desde ${paso.id}`);
    process.exit(1);
  }
}

// Las pruebas de humo cambian la contraseña del administrador: se restaura siempre.
console.log('');
console.log(color.tenue('  Restaurando las contraseñas sembradas…'));
spawnSync(
  process.execPath,
  ['--env-file-if-exists=.env', 'services/identity/dist/seed.js', '--reset'],
  {
    cwd: ROOT,
    stdio: 'ignore',
  },
);

const fallidos = resultados.filter((resultado) => !resultado.ok);
console.log('');
console.log(color.titulo('── Resumen ───────────────────────────────────────────────────────'));
for (const resultado of resultados) {
  console.log(
    `  ${resultado.ok ? color.ok('✔') : color.error('✖')} ${resultado.titulo.padEnd(42)} ${segundos(resultado.ms)}`,
  );
}

if (fallidos.length === 0) {
  console.log('');
  console.log(
    color.ok(
      `El flujo completo de la clínica pasó: ${String(resultados.length)} pasos en verde` +
        ` (${segundos(resultados.reduce((total, resultado) => total + resultado.ms, 0))}).`,
    ),
  );
  if (sinBot) {
    console.log(
      color.tenue(
        '  Pendiente: la parte del bot (identidad, enlace, QR y envío real). Configura\n' +
          '  TELEGRAM_BOT_TOKEN y TELEGRAM_BOT_USERNAME y repite sin --sin-bot.',
      ),
    );
  }
  console.log('');
} else {
  console.log('');
  console.log(
    color.error(
      `${String(fallidos.length)} de ${String(resultados.length)} pasos fallaron: ${fallidos.map((f) => f.id).join(', ')}`,
    ),
  );
  console.log('');
  process.exitCode = 1;
}
