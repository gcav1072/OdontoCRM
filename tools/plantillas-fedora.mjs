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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (ruta) => readFileSync(resolve(ROOT, ruta), 'utf8');

const installSh = leer('infra/fedora/install.sh');

/**
 * Lo que el despliegue **pone** además de las plantillas. Son valores que genera
 * `npm run db:bootstrap` en el repositorio y que la guía traslada a `/etc/odontocrm`
 * (§8.6), más lo que añade la propia migración de `install.sh`.
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
    // `algo: z.string()...default('./…')` — el nombre y su valor relativo.
    const relativos = [
      ...contenido.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):[\s\S]*?default\('\.\//gm),
    ].map((m) => m[1]);
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
  const guiones = execFileSync('git', ['ls-files', 'infra/fedora'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((linea) => linea.endsWith('.sh') || linea === 'infra/fedora/odontocrm');
  for (const guion of guiones) {
    comprobaciones += 1;
    const contenido = leer(guion);
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
  const guiones = execFileSync('git', ['ls-files', 'infra/fedora'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (linea) =>
        linea.endsWith('.sh') || linea.endsWith('.mjs') || linea === 'infra/fedora/odontocrm',
    );
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
