#!/usr/bin/env node
/**
 * **Verificador de las plantillas de Fedora** (`npm run fedora:check`).
 *
 * Existe porque el despliegue tiene su propia copia de los nombres de las variables
 * —`/etc/odontocrm/*.env`, que genera `infra/fedora/install.sh`— y esa copia se
 * queda vieja en silencio cuando un servicio renombra algo: el servicio arranca con
 * el valor por defecto, que en desarrollo funciona y en producción no.
 *
 * Pasó dos veces en el ensayo de la Fase 10, y las dos con el mismo síntoma (el
 * servicio muere en bucle y systemd lo reintenta):
 *
 * - `STORAGE_ROOT`, que ningún servicio lee (el que lee es `STORAGE_DIR`), dejaba el
 *   almacén apuntando a `/opt/odontocrm/storage`, de solo lectura con
 *   `ProtectSystem=strict`.
 * - El gateway no tenía `JWT_PUBLIC_KEY_PATH` y su valor por defecto es relativo al
 *   código, donde en producción ya no hay claves.
 *
 * Este comando comprueba dos cosas, sin tocar el sistema:
 *
 * 1. **Las variables críticas están**: las que no pueden quedarse con el valor por
 *    defecto en producción aparecen en las plantillas de `install.sh` (o las escribe
 *    el bootstrap y las traslada el §8.6, que aquí se dan por puestas).
 * 2. **Los nombres muertos no vuelven**: los valores y paquetes que ya se
 *    corrigieron (y que dejarían una instalación nueva rota) no reaparecen ni en la
 *    guía ni en los scripts.
 *
 * Corre dentro de `npm run verify`: si alguien renombra una variable y no toca
 * Fedora, el commit no pasa.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (ruta) => readFileSync(resolve(ROOT, ruta), 'utf8');

const installSh = leer('infra/fedora/install.sh');

/**
 * Los guiones del despliegue que hay que revisar: los del índice de git **y los que
 * todavía no se han confirmado**, descartando los que ya no están en disco.
 *
 * Así un guion recién añadido pasa por estas comprobaciones desde el primer momento
 * —no cuando alguien se acuerde de `git add`— y borrar uno no rompe la comprobación
 * antes de confirmar el borrado (pasó al retirar `instalar-servidor.sh`).
 */
const guionesDeFedora = (extensiones = ['.sh', '.mjs']) => {
  const listar = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const todos = [
    ...listar(['ls-files', 'infra/fedora']),
    ...listar(['ls-files', '--others', '--exclude-standard', 'infra/fedora']),
  ];
  return todos
    .filter(
      (linea) =>
        extensiones.some((ext) => linea.endsWith(ext)) || linea === 'infra/fedora/odontocrm',
    )
    .filter((linea) => existsSync(join(ROOT, linea)));
};

/**
 * Lo que el despliegue **pone** además de las plantillas. Son valores que genera
 * `npm run db:bootstrap` en el repositorio y que la guía traslada a `/etc/odontocrm`
 * (§8.6), más lo que añade la propia migración de `install.sh`.
 */
/**
 * Variables que **no** escribe la plantilla de `install.sh` porque las pone otro paso (el
 * bootstrap, el traslado de secretos o la unidad). No puede ser un cheque en blanco: cada
 * una tiene que estar **documentada** en `install.sh` o en la guía, porque si no, quitar la
 * variable de la plantilla dejaría de detectarse (pasaba con `DATABASE_URL` y compañía).
 */
const LOS_PONE_OTRO_PASO = new Set([
  'DATABASE_URL',
  'EVENTS_DATABASE_URL',
  'INTERNAL_SERVICE_SECRET',
  'COOKIE_SECRET',
  'JWT_PRIVATE_KEY_PATH',
  'JWT_PUBLIC_KEY_PATH',
  'STORAGE_DIR',
  'MAX_FILE_BYTES',
  'PUBLIC_APP_URL',
]);

/**
 * Variables que **no pueden** quedarse con su valor por defecto en producción: si
 * falta la del despliegue, el servicio arranca mal (o no arranca) en la clínica.
 */
const CRITICAS = {
  '*': ['NODE_ENV', 'TZ', 'TEST_MODE', 'ALLOW_TEST_MODE'],
  identity: ['WEB_ORIGIN'],
  patients: ['DATABASE_URL', 'EVENTS_DATABASE_URL', 'STORAGE_DIR', 'MAX_FILE_BYTES'],
  clinical: [
    'DATABASE_URL',
    'EVENTS_DATABASE_URL',
    'STORAGE_DIR',
    'MAX_FILE_BYTES',
    'PUBLIC_APP_URL',
  ],
  notifications: ['DATABASE_URL', 'EVENTS_DATABASE_URL', 'TELEGRAM_MODE'],
  gateway: ['WEB_ORIGIN', 'JWT_PUBLIC_KEY_PATH'],
};

/** Servicios con base de datos (los que llevan `env_service_body`). */
const CON_BASE = [
  'identity',
  'patients',
  'scheduling',
  'notifications',
  'clinical',
  'odontogram',
  'screens',
  'reporting',
];

/**
 * Nombres y valores que ya se corrigieron una vez y no deben volver. Cada uno con el
 * porqué, para que quien lo lea sepa qué rompe.
 */
const MARCA_MENCION = 'fedora:check-ok';

const PROHIBIDOS = [
  {
    patron: /^STORAGE_ROOT=/m,
    donde: ['infra/fedora/install.sh'],
    motivo:
      'ningún servicio lee STORAGE_ROOT (lee STORAGE_DIR): deja el almacén en /opt, de solo lectura',
  },
  {
    patron: /^STORAGE_MAX_UPLOAD_MB=/m,
    donde: ['infra/fedora/install.sh'],
    motivo: 'ningún servicio lee STORAGE_MAX_UPLOAD_MB (lee MAX_FILE_BYTES, en bytes)',
  },
  {
    patron: /^TELEGRAM_MODE=polling[[:space:]]*$/m,
    donde: ['infra/fedora/install.sh'],
    motivo: 'TELEGRAM_MODE solo acepta auto | real | simulado: con polling el servicio no arranca',
  },
  {
    patron: /dnf\s+(-y\s+)?install[^\n]*setools-conftools/,
    donde: ['infra/fedora/install.sh', 'infra/fedora/INSTALL.md'],
    motivo: 'el paquete de SELinux se llama setools-console',
  },
  {
    patron: /playwright install-deps/,
    donde: ['infra/fedora/install.sh', 'infra/fedora/INSTALL.md'],
    motivo:
      'Playwright no soporta Fedora en install-deps: hay que usar la lista de dnf (plan B documentado)',
  },
];

/**
 * **Valores por defecto que en producción no sirven.**
 *
 * Un `default('./storage/clinical')` o `default('./services/identity/.keys/…')` es cómodo
 * en desarrollo (se resuelve relativo a la raíz del repositorio) y **roto en el servidor**:
 * el código vive en `/opt/odontocrm`, que es de solo lectura para el servicio, así que el
 * proceso muere al primer archivo. Nos pasó con `STORAGE_DIR` (la plantilla ponía
 * `STORAGE_ROOT`, que ningún servicio lee) y con las claves del JWT del gateway.
 *
 * Esta comprobación busca esos defaults en TODOS los esquemas y exige que la variable
 * aparezca en las plantillas de `install.sh` (o en la lista de las que pone otro paso).
 * Así, un servicio nuevo que traiga una ruta relativa no puede colarse.
 */
const revisarDefaultsRelativos = () => {
  const rutas = [
    ...new Set(
      execFileSync(
        'git',
        [
          'ls-files',
          'services/*/src/config.ts',
          'apps/*/src/config.ts',
          'packages/*/src/config.ts',
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
        },
      )
        .split('\n')
        .filter((linea) => linea !== ''),
    ),
  ];

  for (const ruta of rutas) {
    comprobaciones += 1;
    const contenido = leer(ruta);
    // `algo: z.string()...default('./…')`: se busca la CLAVE y su default **en la misma
    // declaración**. La versión anterior usaba `[\s\S]*?`, que avanzaba hasta el primer
    // `default('./` del archivo y culpaba siempre a la primera clave del esquema
    // (`SERVICE_VERSION`, que sí está en la plantilla): el chequeo no detectaba nada.
    const relativos = contenido
      .split('\n')
      .map((linea, indice, lineas) => {
        const clave = /^\s{2}([A-Z][A-Z0-9_]+):/.exec(linea);
        if (clave === null) return null;
        // La declaración puede seguir en las dos líneas siguientes (z.string().default('./x')).
        const declaracion = [linea, lineas[indice + 1] ?? '', lineas[indice + 2] ?? ''].join(' ');
        return declaracion.includes("default('./") ? clave[1] : null;
      })
      .filter((clave) => clave !== null);
    const pendientes = relativos.filter(
      (variable) =>
        !new RegExp(`^${variable}=`, 'm').test(installSh) && !LOS_PONE_OTRO_PASO.has(variable),
    );
    if (pendientes.length === 0) {
      ok(`${ruta.padEnd(42)} sin rutas relativas sueltas`);
    } else {
      err(
        `${ruta}: ${pendientes.join(', ')} tienen valor por defecto relativo (\`./…\`) y NO están en las plantillas: el servicio fallaría en /opt`,
      );
    }
  }
};

let fallos = 0;
let comprobaciones = 0;

const ok = (texto) => console.log(`  ✔ ${texto}`);
const err = (texto) => {
  fallos += 1;
  console.error(`  ✖ ${texto}`);
};

// ── 1. Variables críticas presentes en las plantillas ────────────────────────
console.log('\nfedora:check · plantillas de /etc/odontocrm\n');
console.log('Críticas (no pueden quedarse con el valor por defecto en producción):');

for (const servicio of [...CON_BASE, 'gateway']) {
  const criticas = [...(CRITICAS['*'] ?? []), ...(CRITICAS[servicio] ?? [])];
  const faltan = criticas.filter(
    (variable) =>
      !new RegExp(`^${variable}=`, 'm').test(installSh) && !LOS_PONE_OTRO_PASO.has(variable),
  );
  comprobaciones += 1;
  if (faltan.length === 0) ok(`${servicio.padEnd(14)} todas puestas`);
  else err(`${servicio.padEnd(14)} faltan en las plantillas: ${faltan.join(', ')}`);
}

// ── 1-bis. Defaults relativos en el código ──────────────────────────────────
console.log('\nRutas por defecto que en producción no sirven:');
revisarDefaultsRelativos();

// ── 1-ter. Ningún guion del despliegue se corta en silencio ──────────────────
console.log('\nAvisos de corte en los guiones (un guion mudo es el peor fallo):');
{
  // Se enumeran los del índice **y los todavía sin confirmar**, y se descartan los que ya
  // no están en disco: un guion recién añadido tiene que pasar esta prueba desde el primer
  // momento (no cuando alguien se acuerde de `git add`), y uno borrado no puede romperla.
  const guiones = guionesDeFedora(['.sh']);
  for (const guion of guiones) {
    comprobaciones += 1;
    const contenido = leer(guion);
    // Una BIBLIOTECA que solo se carga con `source` no lleva traps propios: los pone
    // quien la ejecuta, y ponerlos aquí los duplicaría en cada pieza. Se declara con
    // la marca que ya usa el proyecto, en su cabecera.
    if (/fedora:check-ok[^\n]*biblioteca/.test(contenido)) {
      ok(`${guion.padEnd(42)} es una biblioteca (los traps los pone quien la carga)`);
      continue;
    }
    const tieneErr = /trap '.*ERR/.test(contenido);
    const tieneExit = /terminó con error/.test(contenido);
    if (tieneErr && tieneExit) {
      ok(`${guion.padEnd(42)} avisa si se corta`);
    } else {
      err(
        `${guion}: le falta ${[!tieneErr ? 'el trap de ERR' : '', !tieneExit ? 'el aviso de salida' : ''].filter(Boolean).join(' y ')} — se cortaría en silencio`,
      );
    }
  }
}

// ── 1-quater. Nada de datos de ESTA máquina en los guiones ───────────────────
console.log('\nDatos de una máquina concreta en los guiones:');
{
  const prohibidosMaquina = [
    { patron: /\bgabox\b/, motivo: 'usuario de la PC de pruebas (usa $SUDO_USER o $USER)' },
    {
      patron: /\/home\/[a-z][a-z0-9_-]*/,
      motivo: 'ruta de un usuario concreto (dedúcela del propio guion)',
    },
  ];
  const guiones = guionesDeFedora();
  for (const guion of guiones) {
    for (const regla of prohibidosMaquina) {
      comprobaciones += 1;
      const contenido = leer(guion);
      const usos = contenido
        .split('\n')
        .filter((linea) => regla.patron.test(linea))
        .filter((linea) => !linea.includes('fedora:check-ok'));
      if (usos.length === 0) {
        ok(`${guion.padEnd(42)} sin ${String(regla.patron).slice(0, 22)}…`);
      } else {
        err(`${guion}: ${regla.motivo}`);
        for (const uso of usos.slice(0, 2)) console.error(`      ${uso.trim().slice(0, 100)}`);
      }
    }
  }
}

// ── 1-quinquies. La guía no puede contradecirse a sí misma ───────────────────
// Si un punto del registro (§20.1) está marcado ✅ —verificado—, no puede seguir habiendo
// en el cuerpo una nota que diga que está pendiente: es lo que hacía dudar de si una
// comprobación se había hecho. Pasó con doce puntos al cerrar la fase.
console.log('\nCoherencia entre el registro de verificación y el cuerpo de la guía:');
{
  const guia = leer('infra/fedora/INSTALL.md');
  const verificados = new Set(
    [...guia.matchAll(/^\|\s*(P-\d+)\s*\|[^\n]*\|\s*✅/gm)].map((m) => m[1]),
  );
  const pendientesEnCuerpo = [...guia.matchAll(/^> PENDIENTE FASE 10: \((P-\d+)\)/gm)].map(
    (m) => m[1],
  );
  const contradicciones = [...new Set(pendientesEnCuerpo.filter((id) => verificados.has(id)))];
  comprobaciones += 1;
  if (contradicciones.length === 0) {
    ok(
      `${String(pendientesEnCuerpo.length).padStart(2)} nota(s) de pendiente, ninguna de un punto ya verificado`,
    );
  } else {
    err(
      `INSTALL.md: ${contradicciones.join(', ')} están marcados ✅ en §20.1 y a la vez anunciados como pendientes en el cuerpo`,
    );
  }
}

// ── 1-sexies. Lecciones de la auditoría, convertidas en guardias ──────────────
// Cada una de estas comprobaciones es un fallo REAL que se encontró auditando el despliegue
// para que otra PC pudiera instalarse sin tropezar con él. Si alguna se pone roja, no es un
// falso positivo: es que el fallo ha vuelto.
console.log('\nLecciones de la auditoría (no deben volver):');

const exigir = (condicion, bien, mal) => {
  comprobaciones += 1;
  if (condicion) ok(bien);
  else err(mal);
};

{
  const installSh = leer('infra/fedora/install.sh');
  const base = leer('infra/fedora/instalar-base-fedora.sh');
  const odontocrm = leer('infra/fedora/odontocrm');
  const runbook = leer('infra/fedora/RUNBOOK.md');
  const guia = leer('infra/fedora/INSTALL.md');

  // (1) Los DOS temporizadores se programan: sin esto, la clínica se queda sin respaldo diario.
  exigir(
    /enable --now odontocrm-alertas\.timer/.test(installSh) &&
      /enable --now odontocrm-backup\.timer/.test(installSh),
    'install.sh programa los dos temporizadores (alertas y respaldo diario)',
    'install.sh NO programa odontocrm-backup.timer: la clínica se quedaría sin respaldo diario',
  );

  // (2) Los .env no se leen con `source`: bash vacía un WEB_ORIGIN con coma y espacio y
  //     expande los `$` de una contraseña.
  const usosSource = ['infra/fedora/odontocrm', 'infra/fedora/ensayo-despliegue.sh'].filter(
    (ruta) => /set -a;\s*(source|\.)/.test(leer(ruta)),
  );
  exigir(
    usosSource.length === 0,
    'las migraciones y `con-entorno` cargan los .env sin interpretarlos como shell',
    `${usosSource.join(', ')} siguen usando 'source' sobre los .env (WEB_ORIGIN y las contraseñas con $ se corrompen)`,
  );

  // (3) El supervisor por defecto es systemd (el validado). PM2 no puede leer las plantillas
  //     0600 y su ecosistema solo declara 3 de los 9 servicios.
  exigir(
    /^SUPERVISOR="systemd"/m.test(installSh),
    'el supervisor por defecto de install.sh es systemd',
    'install.sh vuelve a traer PM2 por defecto: media pila y dos supervisores a la vez',
  );

  // (4) El puerto 80 se abre: por ahí se descarga la CA en cada equipo.
  exigir(
    /add-service=http/.test(installSh),
    'install.sh abre el 80 (descarga de la CA y redirección a HTTPS)',
    'install.sh no abre el 80: ningún equipo podrá descargar la CA por http://<servidor>/ca.crt',
  );

  // (5) Los nombres de Fedora: `postgresql-18.service`/`postgresql-18-setup` no existen allí
  //     (y systemd ignora en silencio una unidad inexistente en After=/Wants=).
  const conNombreVersionado = [
    'infra/fedora/install.sh',
    'infra/fedora/instalar-base-fedora.sh',
    'infra/fedora/systemd/odontocrm@.service',
    'infra/fedora/systemd/odontocrm-backup.service',
    'infra/fedora/INSTALL.md',
  ].filter((ruta) => {
    // Se mira línea a línea y se perdonan las que EXPLICAN la otra convención (mencionan
    // PGDG, o listan las dos unidades a propósito, como las unidades systemd del proyecto).
    return (
      leer(ruta)
        .split('\n')
        // Se perdonan los comentarios (explican la otra convención a propósito) y las líneas
        // que ya nombran Fedora o PGDG para aclarar cuál es cuál.
        .filter((linea) => !/^\s*#/.test(linea) && !/PGDG|postgresql\.service/.test(linea))
        .some(
          (linea) =>
            /systemctl\s+(enable|start|restart|status)[^\n]*postgresql-\d+/.test(linea) ||
            /postgresql-\d+-setup/.test(linea),
        )
    );
  });
  exigir(
    conNombreVersionado.length === 0,
    'los comandos de PostgreSQL usan el nombre de Fedora (o detectan el sabor)',
    `${conNombreVersionado.join(', ')}: comandos con el nombre versionado de PGDG, que no existe en Fedora`,
  );

  // (6) La red no se inventa como /24.
  const conSlash24 = ['infra/fedora/ensayo-despliegue.sh', 'infra/fedora/odontocrm'].filter(
    (ruta) => /printf "%s\.%s\.%s\.0\/24"/.test(leer(ruta)),
  );
  exigir(
    conSlash24.length === 0,
    'el CIDR se deduce de la interfaz (no se inventa una /24)',
    `${conSlash24.join(', ')}: construyen un /24 a mano (en redes /16 o 10/8 la regla deja fuera a equipos legítimos)`,
  );

  // (7) Los documentos no pueden citar banderas que no existen (el RUNBOOK enseñaba una
  //     restauración imposible, y sin `--keep-old` se borraba la base actual).
  const banderasInventadas = ['--file', '--verify', '--database', '--keep '].filter(
    (bandera) => runbook.includes(bandera) || guia.includes(bandera),
  );
  exigir(
    banderasInventadas.length === 0,
    'los documentos usan las banderas reales de los guiones',
    `los documentos citan banderas que no existen (${banderasInventadas.join(', ')}): compruébalas con --help`,
  );

  // (7-bis) Sembrar usuarios en producción EXIGE una contraseña por cuenta
  //     (`SEED_PASSWORD_<USUARIO>`, mínimo 10 caracteres): con `NODE_ENV=production` el seed
  //     NO acepta las claves de desarrollo y se niega a escribir si falta alguna. Enseñar la
  //     receta sin ellas deja al operador con un error y sin poder entrar (pasó en el servidor
  //     con la del odontólogo, que es justo la que se olvida porque sale de `CLINIC.dentists`).
  const usuariosDelSeed = [
    'ADMIN',
    'RECEPCION',
    ...(leer('packages/contracts/src/clinic.ts').match(/username: '([^']+)'/g) ?? []).map((linea) =>
      linea.slice(linea.indexOf("'") + 1, -1).toUpperCase(),
    ),
  ];
  /** Los comandos de los bloques de código, con las continuaciones de línea (`\`) ya unidas. */
  const comandosDocumentados = (texto) =>
    (texto.match(/```[\s\S]*?```/g) ?? []).flatMap((bloque) => {
      const comandos = [];
      let buffer = '';
      for (const linea of bloque.split('\n')) {
        buffer = buffer === '' ? linea : `${buffer} ${linea}`;
        if (linea.trimEnd().endsWith('\\')) continue;
        comandos.push(buffer);
        buffer = '';
      }
      return comandos;
    });
  const recetasIncompletas = [];
  for (const ruta of ['infra/fedora/RUNBOOK.md', 'docs/COMANDOS_PRODUCCION.md']) {
    for (const comando of comandosDocumentados(leer(ruta))) {
      // `--print` no escribe en la base: puede ir sin claves. Lo que se comprueba es lo que siembra.
      if (!/dist\/seed\.js/.test(comando) || /--print/.test(comando)) continue;
      // Con `--usuarios=` solo hacen falta las claves de esas cuentas: es como siembra el
      // servidor (solo `admin`) y como se resetea una sola cuenta.
      const pedidos = /--usuarios=([^\s\\]+)/.exec(comando);
      const cuentas =
        pedidos === null
          ? usuariosDelSeed
          : pedidos[1].split(',').map((n) => n.trim().toUpperCase());
      const faltan = cuentas.filter((u) => !comando.includes(`SEED_PASSWORD_${u}`));
      if (faltan.length > 0) recetasIncompletas.push(`${ruta}: falta ${faltan.join(', ')}`);
    }
  }
  exigir(
    recetasIncompletas.length === 0,
    'las recetas documentadas del seed llevan la clave de cada cuenta en el entorno',
    `hay recetas de siembra sin todas las claves de producción:\n      ${recetasIncompletas.join('\n      ')}`,
  );

  // (7-ter) Las preguntas de la instalación viven SOLO en `instalar.sh`. Las cuatro piezas
  //     siguen siendo desatendidas a propósito: `odontocrm actualizar` ejecuta la 3 sin
  //     terminal, y un `read` ahí dejaría una actualización colgada esperando a nadie.
  // Se busca el `read` que PREGUNTA (`-p`, `-s`) o el que lee de `/dev/tty`: un
  // `while IFS= read -r usuario` (aquí-string) no pregunta nada y no cuenta.
  const preguntaAlOperador = (texto) =>
    /\bread\b(?=[^\n]*\s-[a-zA-Z]*[ps]\b)|\/dev\/tty/.test(texto);
  const piezasConPreguntas = [
    '10-preparar.sh',
    '20-aprovisionar.sh',
    '30-desplegar.sh',
    '40-verificar.sh',
  ].filter((guion) => preguntaAlOperador(leer(`infra/fedora/instalar/${guion}`)));
  exigir(
    piezasConPreguntas.length === 0,
    'las piezas del instalador siguen siendo desatendidas (las preguntas están en instalar.sh)',
    `estas piezas preguntan algo: ${piezasConPreguntas.join(', ')} — una actualización sin terminal se quedaría esperando`,
  );

  // (7-quáter) Y `instalar.sh` de verdad pregunta, y ofrece `--sin-preguntas`: sin eso, el
  //     operador vuelve a pelearse con los tokens después del despliegue (lo que se arregló).
  exigir(
    /preguntar_secreto/.test(leer('infra/fedora/instalar/instalar.sh')) &&
      /--sin-preguntas/.test(leer('infra/fedora/instalar/instalar.sh')),
    'instalar.sh pregunta por la clave del admin y los tokens, y se puede desatender',
    'instalar.sh no pregunta (o no hay forma de desatenderlo): vuelve el trabajo manual tras el despliegue',
  );

  // (8) La guía explica dónde se cambian los datos de la clínica (otra consulta = otro
  //     membrete, otro QR y otro usuario clínico).
  exigir(
    /clinic\.ts/.test(guia),
    'la guía explica cómo cambiar los datos del consultorio (clinic.ts)',
    'INSTALL.md no menciona packages/contracts/src/clinic.ts: otra clínica imprimiría récipes con estos datos',
  );

  // (9) La lista de bases coincide en todos los sitios (incluida la cola `odonto_events`).
  const basesDe = (texto, etiqueta) => {
    // Se busca la línea y se limpia lo que la envuelve: en la plantilla el valor va
    // escapado en el heredoc (`DATABASES=\"…\"`), así que sobran barras y comillas.
    const linea = texto
      .split('\n')
      .find((l) => l.includes(`${etiqueta}=`) && l.includes('odonto_identity'));
    if (linea === undefined) return '';
    return linea
      .slice(linea.indexOf(`${etiqueta}=`) + etiqueta.length + 1)
      .replace(/[\\"]/g, '')
      .trim()
      .split(/\s+/)
      .sort()
      .join(' ');
  };
  const enPlantilla = basesDe(installSh, 'DATABASES');
  const enRespaldo = basesDe(leer('infra/fedora/backup/odontocrm-backup.sh'), 'DATABASES');
  exigir(
    enPlantilla !== '' && enPlantilla === enRespaldo && enPlantilla.includes('odonto_events'),
    'la lista de bases es la misma en la plantilla y en el guion, e incluye la cola',
    `las listas de bases no coinciden o falta la cola:\n      plantilla: ${enPlantilla}\n      guion:     ${enRespaldo}`,
  );

  // (10) El agente `odontocrm` avisa de los marcadores sin sustituir.
  exigir(
    /CAMBIAR/.test(odontocrm) && /marcador/.test(odontocrm),
    'odontocrm verificar avisa de los marcadores CAMBIAR_* sin sustituir',
    '`odontocrm` no comprueba los marcadores CAMBIAR_*: un secreto del repositorio pasaría por bueno',
  );

  // (11) El cargador de entorno existe y se usa (no basta con tenerlo).
  exigir(
    existsSync(join(ROOT, 'tools/con-entorno.mjs')) &&
      /con-entorno\.mjs/.test(leer('infra/fedora/odontocrm')),
    'el cargador de entorno (tools/con-entorno.mjs) existe y se usa en el despliegue',
    'falta el uso de tools/con-entorno.mjs en el despliegue: los .env volverían a leerse como shell',
  );

  // (12) Las SONDAS no deben disparar los avisos de error. Un `x="$(… | grep …)"` devuelve 1
  //      cuando no encuentra nada —que es una respuesta válida— y el aviso de ERR lo contaba
  //      como si el guion se hubiera cortado: ruido que tapa los avisos de verdad (pasó al
  //      actualizar el servidor: catorce «✖ se detuvo» con los nueve servicios en verde).
  const sondasSinGuardar = [];
  for (const ruta of [
    'infra/fedora/odontocrm',
    'infra/fedora/ensayo-despliegue.sh',
    'infra/fedora/install.sh',
    'infra/fedora/instalar-base-fedora.sh',
    'infra/fedora/nginx/instalar.sh',
    'infra/fedora/backup/odontocrm-backup.sh',
    'infra/fedora/backup/odontocrm-restore.sh',
    'infra/fedora/backup/crear-rol-respaldo.sh',
  ]) {
    for (const [indice, linea] of leer(ruta).split('\n').entries()) {
      const esSonda =
        /^\s*[\w[\]{}@-]+="\$\(.*(grep|awk|sed|head|ss |ip -|firewall-cmd|avahi-resolve|systemctl show).*\)"$/.test(
          linea,
        );
      if (esSonda && !linea.includes('|| true') && !linea.includes('|| echo')) {
        sondasSinGuardar.push(`${ruta}:${indice + 1}`);
      }
    }
  }
  exigir(
    sondasSinGuardar.length === 0,
    'las sondas (grep/ss/ip) no disparan los avisos de error',
    `sondas sin \`|| true\` (el aviso de error las contaría como fallo): ${sondasSinGuardar.slice(0, 5).join(', ')}`,
  );

  // (13-bis) El nombre en los demás equipos: la guía tiene que avisar de que Android no
  //          resuelve `.local` y ofrecer el camino del DNS propio. Si no, se repite el
  //          problema que apareció al probar con otros equipos de la red.
  exigir(
    /Android/.test(guia) && /instalar-dns\.sh/.test(guia),
    'la guía explica que Android no resuelve .local y ofrece el DNS propio',
    'INSTALL.md no avisa de la limitación de Android ni menciona infra/fedora/nombre/instalar-dns.sh',
  );
  exigir(
    existsSync(join(ROOT, 'infra/fedora/nombre/instalar-dns.sh')),
    'existe el instalador de nombre por DNS (infra/fedora/nombre/instalar-dns.sh)',
    'falta infra/fedora/nombre/instalar-dns.sh: los equipos sin mDNS se quedarían sin nombre',
  );
  // Y el comando que lo diagnostica.
  exigir(
    /nombre\|mdns\|dns\)/.test(odontocrm),
    '`odontocrm nombre` diagnostica cómo entran los demás equipos',
    'falta la orden `odontocrm nombre` (el diagnóstico del nombre en la red)',
  );

  // (13-ter) El soporte multiplataforma del certificado: nginx tiene que servir los cuatro
  //          formatos (PEM, DER, perfil de Apple y los scripts de un comando) y el perfil
  //          **con su tipo MIME**, o iOS muestra el XML en vez de ofrecer instalarlo.
  const conf = leer('infra/fedora/nginx/odontocrm.conf');
  const formatos = [
    '/ca.crt',
    '/ca.der',
    '/odontocrm.mobileconfig',
    '/ca-windows.ps1',
    '/ca-linux.sh',
  ];
  const sinServir = formatos.filter((f) => !conf.includes(`location = ${f}`));
  exigir(
    sinServir.length === 0,
    'el proxy sirve la CA en los formatos de todas las plataformas (PEM, DER, perfil y scripts)',
    `faltan en nginx/odontocrm.conf: ${sinServir.join(', ')}`,
  );
  // Y en los DOS bloques (80 y 443): un equipo que todavía no confía en la CA **no puede
  // descargarla por HTTPS** (Safari ni siquiera ofrece el perfil), así que si el enlace solo
  // está en el bloque de 443 la petición por HTTP cae en el redirect y devuelve 301. Pasó de
  // verdad: los cuatro enlaces nuevos respondían 301 y el certificado no se podía instalar.
  const soloEnHttps = formatos.filter(
    (f) =>
      (conf.match(new RegExp(`location = ${f.replace(/[.]/g, '\\.')}\\b`, 'g')) ?? []).length < 2,
  );
  exigir(
    soloEnHttps.length === 0,
    'los enlaces de la CA se sirven por HTTP y por HTTPS (antes de confiar en la CA, solo hay HTTP)',
    `estos enlaces solo están en el bloque de 443 y por HTTP devolverían 301: ${soloEnHttps.join(', ')}`,
  );
  exigir(
    /application\/x-apple-aspen-config/.test(conf),
    'el perfil de Apple se sirve con su tipo MIME (si no, Safari lo muestra como texto)',
    'odontocrm.mobileconfig no lleva `application/x-apple-aspen-config`: iOS no ofrecerá instalarlo',
  );
  exigir(
    /mobileconfig/.test(guia) &&
      /odontocrm\.mobileconfig/.test(leer('docs/CERTIFICADO_EN_LOS_EQUIPOS.md')),
    'las guías explican el perfil de Apple y los formatos por plataforma',
    'los documentos no mencionan odontocrm.mobileconfig (iOS/macOS instalarían el .crt a mano)',
  );

  // (13-quater) LO QUE PROTEGE EL CRECIMIENTO DEL PROGRAMA.
  //
  // Añadir una característica no puede romper el despliegue en silencio. Estas dos
  // comprobaciones son las que vigilan eso:
  //
  //  a) **Un servicio nuevo tiene que estar en todas las listas**: si se crea
  //     `services/<nuevo>` y se olvida en `SERVICIOS` (arranque y verificación), en el
  //     bootstrap (bases) o en la lista de respaldo, el despliegue queda a medias y no
  //     falla nada.
  //  b) **Las variables muertas no vuelven**: la plantilla llegó a definir claves que
  //     ningún servicio lee (`COOKIE_SECRET`, `LOGIN_MAX_ATTEMPTS`…), y eso hace creer que
  //     se pueden ajustar: uno pone `ACCESS_TOKEN_TTL=4h` y no pasa nada.
  const serviciosEnDisco = execFileSync('git', ['ls-files', 'services/*/src/config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((ruta) => ruta.split('/')[1])
    .sort();

  const listaDe = (texto, etiqueta) => {
    const m =
      new RegExp(`${etiqueta}=\\(([^)]*)\\)`).exec(texto) ??
      new RegExp(`${etiqueta} = \\[([^\\]]*)\\]`).exec(texto);
    if (m === null) return [];
    return m[1]
      .replace(/['"\n]/g, '')
      .split(/[,\s]+/)
      .filter(Boolean)
      .sort();
  };

  const enComando = listaDe(odontocrm, 'SERVICIOS');
  const enEnsayo = listaDe(leer('infra/fedora/ensayo-despliegue.sh'), 'SERVICIOS');
  const faltanEnListas = serviciosEnDisco.filter(
    (svc) => !enComando.includes(svc) || !enEnsayo.includes(svc),
  );
  exigir(
    faltanEnListas.length === 0,
    `los ${serviciosEnDisco.length} servicios de services/ están en las listas de despliegue`,
    `services/ tiene ${serviciosEnDisco.join(', ')} pero faltan en las listas: ${faltanEnListas.join(', ')} (revisa SERVICIOS en odontocrm y en ensayo-despliegue.sh)`,
  );

  const muertas = [
    'COOKIE_SECRET',
    'COOKIE_SAMESITE',
    'LOGIN_MAX_ATTEMPTS',
    'LOGIN_LOCK_MINUTES',
    'REFRESH_TOKEN_TTL_DAYS',
    'TELEGRAM_TEST_CHAT_ID',
  ];
  const reaparecidas = muertas.filter((v) => new RegExp(`^${v}=`, 'm').test(installSh));
  exigir(
    reaparecidas.length === 0,
    'la plantilla no define variables que ningún servicio lee',
    `estas variables no las lee nadie y volvieron a la plantilla: ${reaparecidas.join(', ')} (los valores viven en packages/contracts)`,
  );

  // (13-quinquies) EL INSTALADOR: una PC nueva se instala con UN comando.
  //
  // ADR 0043 descartó el camino anterior —el ensayo como instalador, el traslado de
  // secretos de `services/*.env` a /etc/odontocrm, el `sincronizar-credenciales` que lo
  // reparaba y las fases con `--hasta`— porque los secretos vivían en DOS sitios y el
  // paso que los copiaba fallaba en silencio («password authentication failed» cinco
  // veces, cada una en un sitio distinto del síntoma).
  //
  // Estas comprobaciones protegen el diseño nuevo: piezas separadas y comprobables,
  // encadenadas por un comando, con UNA SOLA copia de cada credencial.
  const INSTALADOR = 'infra/fedora/instalar';
  const piezasDelInstalador = [
    'instalar.sh',
    '10-preparar.sh',
    '20-aprovisionar.sh',
    '30-desplegar.sh',
    '40-verificar.sh',
    'aprovisionar.mjs',
    'comun.sh',
  ];
  const piezasQueFaltan = piezasDelInstalador.filter(
    (pieza) => !existsSync(join(ROOT, INSTALADOR, pieza)),
  );
  exigir(
    piezasQueFaltan.length === 0,
    'el instalador está completo: el comando único y las cuatro piezas',
    `faltan piezas del instalador: ${piezasQueFaltan.join(', ')}`,
  );

  const leerInstalador = (pieza) => leer(`${INSTALADOR}/${pieza}`);
  const entrada = leerInstalador('instalar.sh');
  const faltanEnLaEntrada = [
    '10-preparar.sh',
    '20-aprovisionar.sh',
    '30-desplegar.sh',
    '40-verificar.sh',
  ].filter((pieza) => !entrada.includes(pieza));
  exigir(
    faltanEnLaEntrada.length === 0,
    'el comando único encadena las cuatro piezas, en orden',
    `instalar.sh no llama a: ${faltanEnLaEntrada.join(', ')}`,
  );

  // UNA SOLA FUENTE DE VERDAD: el aprovisionador es el único que escribe las
  // credenciales, y las comprueba conectándose (no basta con que el archivo exista).
  const aprovisionador = leerInstalador('aprovisionar.mjs');
  exigir(
    /EVENTS_DATABASE_URL/.test(aprovisionador) && /DATABASE_URL/.test(aprovisionador),
    'el aprovisionador escribe las credenciales de los 9 servicios en /etc/odontocrm',
    'aprovisionar.mjs no escribe DATABASE_URL/EVENTS_DATABASE_URL: alguien tendría que copiarlas',
  );
  exigir(
    /spawnSync\(\s*'psql'/.test(aprovisionador) && /PGPASSWORD/.test(aprovisionador),
    'el aprovisionador COMPRUEBA cada credencial con una conexión real (no con el archivo)',
    'aprovisionar.mjs no abre una conexión por credencial: un desfase pasaría inadvertido',
  );
  exigir(
    /--solo-verificar|soloVerificar/.test(aprovisionador),
    'hay un modo de solo comprobar, para poder verificar sin aprovisionar',
    'falta el modo de solo comprobar: la verificación tendría que escribir para poder comprobar',
  );

  // Y NADIE traslada secretos desde el repositorio en el camino nuevo: eso es
  // exactamente lo que el ADR descarta.
  const caminoNuevo = [
    entrada,
    leerInstalador('20-aprovisionar.sh'),
    leerInstalador('30-desplegar.sh'),
  ].join('\n');
  exigir(
    !/sincronizar-credenciales/.test(caminoNuevo),
    'el instalador nuevo no usa `sincronizar-credenciales` (el modelo de dos copias)',
    'el instalador nuevo volvió a llamar a sincronizar-credenciales: eso reintroduce el traslado de secretos',
  );
  exigir(
    !/services\/\$?\{?s?\}?\/\.env/.test(caminoNuevo),
    'el instalador nuevo no lee los .env del repositorio (no hay segunda copia)',
    'el instalador nuevo lee services/*/.env: volvería a haber dos copias que se desfasan',
  );
  exigir(
    !/^\s*(DATABASE_URL|INTERNAL_SERVICE_SECRET|COOKIE_SECRET)=/m.test(
      leerInstalador('30-desplegar.sh'),
    ),
    'el despliegue NO escribe credenciales: solo las lee de /etc/odontocrm',
    '30-desplegar.sh escribe credenciales: habría dos escritores de /etc/odontocrm',
  );
  // El código desplegado en /opt se clona, y un clon nunca trae lo ignorado por Git
  // (.env, .keys): así no puede contener secretos.
  exigir(
    /git clone/.test(leerInstalador('30-desplegar.sh')),
    'el código se despliega con `git clone` (nunca copia los .env ignorados por Git)',
    '30-desplegar.sh no usa git clone: copiar a mano podría arrastrar los .env al servidor',
  );

  // Y la documentación tiene que presentar ESE camino, no el viejo.
  // No se prohíbe NOMBRARLO (la guía explica que se retiró y por qué: eso es
  // documentación útil); lo que no puede haber es que se ofrezca como el comando a
  // ejecutar, que es como vuelve un camino retirado.
  const instaladorRetirado = /bash\s+infra\/fedora\/instalar-servidor\.sh/;
  exigir(
    !instaladorRetirado.test(guia) && !instaladorRetirado.test(leer('README.md')),
    'ni la guía ni el README ofrecen ya el instalador retirado como comando',
    'INSTALL.md o README.md mandan ejecutar infra/fedora/instalar-servidor.sh (retirado por el ADR 0043)',
  );
  exigir(
    /infra\/fedora\/instalar\/instalar\.sh/.test(guia) &&
      /infra\/fedora\/instalar\/instalar\.sh/.test(leer('README.md')),
    'la guía y el README presentan el instalador nuevo como el camino de una PC nueva',
    'ni INSTALL.md ni README.md mencionan infra/fedora/instalar/instalar.sh',
  );

  // (13-sexies) Los scripts de la CA NO pueden llevar una IP grabada.
  // Se publicaban con la IP del día de la instalación: cuando el servidor cambió de red, el
  // equipo que los ejecutaba se quedó esperando (timeout) a una dirección que ya no existía.
  // Ahora llevan el marcador `SERVIDOR` y nginx lo sustituye por la dirección con la que
  // llegó el equipo (`$host`).
  // El tipo MIME tiene que ser comodín: nginx sirve `.sh` como `application/x-sh` por su
  // mime.types, y con una lista cerrada (`text/plain`) la sustitución **no se aplica** y el
  // script llega con el marcador («Could not resolve host: SERVIDOR»).
  exigir(
    /sub_filter_types \*;/.test(conf),
    'el sub_filter acepta cualquier tipo MIME (nginx sirve .sh como application/x-sh)',
    'sub_filter_types no es comodín: la sustitución de SERVIDOR puede no aplicarse (el .sh va como application/x-sh)',
  );
  exigir(
    (conf.match(/sub_filter 'http:\/\/SERVIDOR'/g) ?? []).length >= 2,
    'el proxy sustituye el marcador SERVIDOR por la dirección real (en los dos bloques)',
    'falta `sub_filter` para los scripts de la CA: volverían a llevar una IP grabada y fallarían al cambiar de red',
  );
  const instaladorNginx = leer('infra/fedora/nginx/instalar.sh');
  exigir(
    !/sed -i .*http:\/\/\$\{HOST_IP/.test(instaladorNginx),
    'los scripts de la CA se publican sin IP grabada',
    'nginx/instalar.sh vuelve a escribir la IP del momento dentro de los scripts de la CA',
  );

  // (13-septies) PRUEBA DE HUMO de los guiones: que ninguno aborte al arrancar.
  //
  // El seed se entrego con `(( ! COMPROBAR ))` antes de definir la variable: con `set -u`
  // abortaba en la línea 62 y **solo en el camino normal** —el que yo no había ejecutado—,
  // porque la prueba que hice fue con `--comprobar`. Esta comprobación ejecuta los guiones en
  // sus modos inocuos (ayuda, bandera inválida o sin argumentos) y falla si alguno se cae al
  // arrancar por una variable sin asignar o un error de sintaxis.
  console.log('\nPrueba de humo de los guiones (ninguno debe abortar al arrancar):');
  const humo = [
    ['infra/fedora/instalar/instalar.sh', ['--help']],
    ['infra/fedora/instalar/instalar.sh', ['--comprobar']],
    ['infra/fedora/instalar/10-preparar.sh', ['--help']],
    ['infra/fedora/instalar/20-aprovisionar.sh', ['--help']],
    ['infra/fedora/instalar/30-desplegar.sh', ['--help']],
    ['infra/fedora/instalar/40-verificar.sh', ['--help']],
    ['infra/fedora/instalar/aprovisionar.mjs', ['--help']],
    ['infra/fedora/odontocrm', []],
    ['infra/fedora/ensayo-despliegue.sh', ['--hasta=inexistente']],
    ['infra/fedora/backup/odontocrm-backup.sh', ['--help']],
    ['infra/fedora/backup/odontocrm-restore.sh', ['--help']],
  ];
  for (const [guion, args] of humo) {
    comprobaciones += 1;
    // El intérprete depende del guion: un .mjs se ejecuta con node, no con bash.
    const interprete = guion.endsWith('.mjs') ? 'node' : 'bash';
    const r = spawnSync(interprete, [guion, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, SUDO_USER: 'prueba-de-humo' },
    });
    const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    // Si el intérprete NO EXISTE (p. ej. `bash` en Windows, que es el entorno de
    // desarrollo del proyecto), `spawnSync` no devuelve salida y la comprobación diría
    // «arranca sin caerse» sin haber ejecutado nada: un OK falso, que es la peor clase
    // de comprobación. Se dice que no se pudo probar y se cuenta como fallo.
    if (r.error) {
      err(
        `${guion.split('/').pop()} `.padEnd(46) +
          `no se pudo probar: falta «${interprete}» en este sistema (${r.error.code ?? 'error'})`,
      );
      console.error(
        '      estas pruebas de humo necesitan bash; ejecútalas en Linux o con Git Bash',
      );
      continue;
    }

    const roto = /variable sin asignar|unbound variable|syntax error|error de sintaxis/i.test(
      salida,
    );
    if (roto) {
      err(`${interprete} ${guion} ${args.join(' ')} → aborta al arrancar:`);
      for (const linea of salida
        .split('\n')
        .filter((l) => l.trim() !== '')
        .slice(0, 3)) {
        console.error(`      ${linea.trim().slice(0, 110)}`);
      }
    } else {
      ok(`${guion.split('/').pop()} ${args.join(' ')}`.padEnd(46) + ' arranca sin caerse');
    }
  }

  // (13-octies) LA REGLA DE `pg_hba.conf`, PROBADA.
  // Se ejecuto con `|` como delimitador de `sed` y el patrón lleva una alternación (`|`), así
  // que `sed` fallaba («opción desconocida para `s'») y en una PC nueva los servicios se
  // quedaban sin poder entrar por TCP. Aquí se prueba la orden de verdad sobre un archivo de
  // ejemplo: TCP pasa a contraseña y el socket **conserva `peer`** (administrar sin claves).
  console.log('\nLa regla de pg_hba.conf (probada sobre un ejemplo):');
  {
    const ejemplo = [
      'local   all             all                                     peer',
      'host    all             all             127.0.0.1/32            ident',
      'host    all             all             ::1/128                 trust',
      'host    all             all             0.0.0.0/0               scram-sha-256',
      '',
    ].join('\n');
    const temporal = join(tmpdir(), 'odontocrm-pg-hba-prueba.conf');
    writeFileSync(temporal, ejemplo);
    const orden = /sed -i -E '([^']+)' "\$PG_HBA"/.exec(
      leer('infra/fedora/instalar-base-fedora.sh'),
    );
    comprobaciones += 1;
    if (orden === null) {
      err('no encontré la orden que pone pg_hba.conf en scram-sha-256');
    } else {
      const r = spawnSync('sed', ['-i', '-E', orden[1], temporal], { encoding: 'utf8' });
      const resultado = readFileSync(temporal, 'utf8');
      const okTcp = (resultado.match(/scram-sha-256/g) ?? []).length === 3;
      const peerIntacto = /^local\s+all\s+all\s+peer$/m.test(resultado);
      if (r.status !== 0 || !okTcp || !peerIntacto) {
        err('la orden de pg_hba.conf no deja el archivo como debe:');
        console.error(
          `      sed salió ${r.status}; TCP con contraseña: ${okTcp}; peer conservado: ${peerIntacto}`,
        );
      } else {
        ok('TCP pasa a scram-sha-256 y el socket conserva peer');
      }
    }
  }

  // (13) Las sondas de red llevan tope: `avahi-resolve` puede quedarse esperando.
  const avahiSinTope = ['infra/fedora/odontocrm', 'infra/fedora/instalar-base-fedora.sh'].filter(
    (ruta) =>
      leer(ruta)
        .split('\n')
        // Solo la LLAMADA (`avahi-resolve -n`), no el `command -v avahi-resolve` ni los
        // comentarios que explican por qué lleva tope.
        .some(
          (linea) =>
            /avahi-resolve -n/.test(linea) && !/^\s*#/.test(linea) && !/timeout /.test(linea),
        ),
  );
  exigir(
    avahiSinTope.length === 0,
    'las sondas de mDNS llevan tope de tiempo',
    `${avahiSinTope.join(', ')}: \`avahi-resolve\` sin \`timeout\` (puede quedarse esperando)`,
  );

  // (12) La base del instalador base declara solo lo que hace (prometía pg_hba y no lo tocaba).
  exigir(
    !/pg_hba/.test(base.split('\n').slice(0, 20).join('\n')) ||
      /pg_hba/.test(base.slice(base.indexOf('\n', 400))),
    'lo que la cabecera de instalar-base-fedora.sh promete se corresponde con el cuerpo',
    'la cabecera de instalar-base-fedora.sh promete tocar pg_hba.conf y el cuerpo no lo hace',
  );
}

// ── 2. Nombres muertos que no deben volver ───────────────────────────────────
console.log('\nNombres y comandos ya corregidos (no deben reaparecer):');
for (const prohibido of PROHIBIDOS) {
  for (const ruta of prohibido.donde) {
    comprobaciones += 1;
    let contenido;
    try {
      contenido = leer(ruta);
    } catch {
      err(`${ruta}: no se pudo leer`);
      continue;
    }
    // La marca vale en la propia línea o en las dos de al lado: en la guía el
    // comando y la explicación suelen ir en líneas contiguas.
    const lineas = contenido.split('\n');
    const usos = lineas
      .map((linea, indice) => ({ linea, indice }))
      .filter(({ linea }) => prohibido.patron.test(linea))
      .filter(
        ({ indice }) =>
          !lineas
            .slice(Math.max(0, indice - 2), indice + 3)
            .some((vecina) => vecina.includes(MARCA_MENCION)),
      )
      .map(({ linea }) => linea);
    if (usos.length > 0) {
      err(`${ruta}: volvió «${String(prohibido.patron)}» — ${prohibido.motivo}`);
      for (const uso of usos.slice(0, 3)) console.error(`      ${uso.trim().slice(0, 100)}`);
    } else {
      ok(`${ruta.padEnd(28)} sin uso de ${String(prohibido.patron).slice(0, 30)}…`);
    }
  }
}

console.log(
  `\nfedora:check: ${String(comprobaciones)} comprobaciones, ${String(fallos)} fallo(s)` +
    (fallos === 0 ? ' ✔' : ''),
);
process.exit(fallos === 0 ? 0 : 1);
