#!/usr/bin/env node
/**
 * Gestión controlada de dependencias del monorepo (incluido `@whiskeysockets/baileys`).
 *
 * Principio: **las versiones se deciden y se prueban solo en desarrollo**.
 * El equipo instalado nunca resuelve versiones: instala exactamente lo que dice
 * `package-lock.json` mediante `npm ci` (`odontocrm actualizar`).
 *
 * Comandos:
 *   npm run deps                         # informa: seguras, mayores, Baileys y auditoría
 *   npm run deps:actualizar              # aplica menores/parche, corre verify y hace commit
 *   npm run deps:baileys [versión]       # fija Baileys exacto, alinea @hapi/boom y prueba WhatsApp
 *   npm run deps:mayor <paquete> [ver]   # sube una versión mayor de una en una y corre verify
 *
 * Opciones útiles (después de `--`):
 *   --en-rama      no crea rama `deps/AAAA-MM-DD`; trabaja sobre la rama actual
 *   --sin-commit   deja los cambios verificados en el árbol sin crear commit
 *   --forzar       permite ejecutar aunque haya cambios previos o la misma versión
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOTIF_PKG_REL = 'services/notifications/package.json';
const BAILEYS_PKG = '@whiskeysockets/baileys';
const BOOM_PKG = '@hapi/boom';
const BAILEYS_RELEASES_URL = 'https://github.com/WhiskeySockets/Baileys/releases';

const PATRON_PAQUETE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const PATRON_VERSION = /^[a-zA-Z0-9._+-]+$/;

export const esVersionExacta = (especificador) =>
  typeof especificador === 'string' &&
  especificador.trim() !== '' &&
  !/^[~^><=*]/.test(especificador.trim());

const parsearSemverBasico = (version) => {
  const limpio = String(version ?? '')
    .trim()
    .replace(/^[~^>=<v]+/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(limpio);
  if (match === null) return null;
  return {
    mayor: Number(match[1]),
    menor: Number(match[2]),
    parche: Number(match[3]),
  };
};

/**
 * Comprueba si la versión fijada de `@hapi/boom` en `notifications` sigue siendo
 * compatible con el rango que pide la versión objetivo de Baileys.
 */
export const evaluarCompatibilidadBoom = (rangoRequerido, versionActual) => {
  if (typeof rangoRequerido !== 'string' || rangoRequerido.trim() === '') {
    return { compatible: true, sugerida: null };
  }
  const req = parsearSemverBasico(rangoRequerido);
  const act = parsearSemverBasico(versionActual);
  if (req === null || act === null) {
    return { compatible: true, sugerida: null };
  }
  const mayorCoincide = act.mayor === req.mayor;
  const menorSuficiente =
    act.menor > req.menor || (act.menor === req.menor && act.parche >= req.parche);
  const compatible = mayorCoincide && menorSuficiente;
  return {
    compatible,
    sugerida: compatible ? null : `${String(req.mayor)}.${String(req.menor)}.${String(req.parche)}`,
  };
};

/**
 * Clasifica la salida de `npm outdated --workspaces --include-workspace-root --json`
 * separando Baileys (fijado exacto, con ciclo de release candidates propio),
 * actualizaciones seguras (dentro del rango `^`) y saltos mayores.
 */
export const clasificarDesactualizadas = (
  outdatedObj,
  { baileysDeclarado, baileysLatest, boomDeclarado },
) => {
  const seguras = [];
  const mayores = [];

  for (const [paquete, crudo] of Object.entries(outdatedObj ?? {})) {
    if (paquete === BAILEYS_PKG) continue;
    const entradas = (Array.isArray(crudo) ? crudo : [crudo]).filter(
      (item) => item !== null && typeof item === 'object',
    );
    if (entradas.length === 0) continue;

    const primera = entradas[0];
    const dependientes = [
      ...new Set(entradas.map((item) => item.dependent).filter((dep) => typeof dep === 'string')),
    ].sort();

    const actual = primera.current ?? '—';
    const deseada = primera.wanted ?? actual;
    const ultima = primera.latest ?? deseada;

    if (
      typeof primera.current === 'string' &&
      typeof primera.wanted === 'string' &&
      primera.current !== primera.wanted
    ) {
      seguras.push({ paquete, actual, deseada, ultima, dependientes });
    }

    if (
      typeof primera.wanted === 'string' &&
      typeof primera.latest === 'string' &&
      primera.wanted !== primera.latest
    ) {
      mayores.push({ paquete, actual, deseada, ultima, dependientes });
    }
  }

  seguras.sort((a, b) => a.paquete.localeCompare(b.paquete));
  mayores.sort((a, b) => a.paquete.localeCompare(b.paquete));

  return {
    baileys: {
      actual: baileysDeclarado,
      latest: baileysLatest,
      exacto: esVersionExacta(baileysDeclarado),
      alDia: baileysLatest === null || baileysDeclarado.replace(/^[~^]/, '') === baileysLatest,
      boom: boomDeclarado,
      changelogUrl: BAILEYS_RELEASES_URL,
    },
    seguras,
    mayores,
  };
};

/**
 * Resume qué paquetes cambiaron en el `package-lock.json` de la raíz.
 */
export const resumirCambiosLock = (lockAntes, lockDespues, paquetesDirectos = new Set()) => {
  const pkgsAntes = lockAntes?.packages ?? {};
  const pkgsDespues = lockDespues?.packages ?? {};
  const cambios = [];

  for (const [clave, metaDespues] of Object.entries(pkgsDespues)) {
    if (!clave.startsWith('node_modules/')) continue;
    // Solo el primer nivel de node_modules para un resumen legible; los anidados cuentan aparte.
    const resto = clave.slice('node_modules/'.length);
    if (resto.includes('node_modules/')) continue;

    const versionDespues = metaDespues?.version;
    const versionAntes = pkgsAntes[clave]?.version;
    if (typeof versionDespues === 'string' && versionAntes !== versionDespues) {
      cambios.push({
        paquete: resto,
        antes: typeof versionAntes === 'string' ? versionAntes : null,
        despues: versionDespues,
        directo: paquetesDirectos.has(resto),
      });
    }
  }

  cambios.sort((a, b) => a.paquete.localeCompare(b.paquete));
  return cambios;
};

/* ── Utilidades de sistema (git, npm, lectura de workspaces) ───────────────── */

const resolverNpmCli = () => {
  const desdeEnv = process.env.npm_execpath;
  if (typeof desdeEnv === 'string' && desdeEnv.endsWith('.js') && existsSync(desdeEnv)) {
    return desdeEnv;
  }
  const candidatos = [
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return candidatos.find((ruta) => existsSync(ruta)) ?? null;
};

const NPM_CLI = resolverNpmCli();

const ejecutarNpm = (args, { heredar = false } = {}) => {
  // Entorno limpio:
  // 1) sin NODE_ENV=production ni omit=dev (nunca omitir devDependencies en desarrollo).
  // 2) sin filtros de workspace heredados del `npm run` padre (evita avisos falsos en npm 11).
  // 3) en Windows, caché en LOCALAPPDATA para no chocar con los permisos de Administrador
  //    de `C:\ProgramData\npm\npm-cache` si la máquina tiene también una instalación fija.
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_omit;
  delete env.npm_config_workspaces;
  delete env.npm_config_workspace;
  delete env.npm_config_include_workspace_root;
  if (process.platform === 'win32') {
    env.npm_config_cache =
      process.env.ODONTOCRM_NPM_CACHE ??
      resolve(process.env.LOCALAPPDATA ?? resolve(ROOT, 'tmp'), 'npm-cache');
  }

  if (NPM_CLI !== null) {
    return spawnSync(process.execPath, [NPM_CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: heredar ? 'inherit' : 'pipe',
      env,
    });
  }
  return spawnSync('npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: heredar ? 'inherit' : 'pipe',
    shell: process.platform === 'win32',
    env,
  });
};

const git = (args, { permitirFallo = false } = {}) => {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (permitirFallo) return '';
    throw error;
  }
};

const leerJson = (rutaRelativa) => JSON.parse(readFileSync(resolve(ROOT, rutaRelativa), 'utf8'));

const escribirJson = (rutaRelativa, objeto) => {
  writeFileSync(resolve(ROOT, rutaRelativa), `${JSON.stringify(objeto, null, 2)}\n`, 'utf8');
};

const rutasPackageJson = () => {
  const raizPkg = leerJson('package.json');
  const workspaces = Array.isArray(raizPkg.workspaces) ? raizPkg.workspaces : [];
  return ['package.json', ...workspaces.map((ws) => `${ws}/package.json`)].filter((ruta) =>
    existsSync(resolve(ROOT, ruta)),
  );
};

const recolectarPaquetesDirectos = () => {
  const directos = new Set();
  for (const ruta of rutasPackageJson()) {
    const pkg = leerJson(ruta);
    for (const campo of ['dependencies', 'devDependencies']) {
      for (const nombre of Object.keys(pkg[campo] ?? {})) {
        if (!nombre.startsWith('@odontocrm/')) directos.add(nombre);
      }
    }
  }
  return directos;
};

const capturarFijadosExactos = () => {
  const exactos = [];
  for (const ruta of rutasPackageJson()) {
    const pkg = leerJson(ruta);
    for (const campo of ['dependencies', 'devDependencies']) {
      for (const [nombre, spec] of Object.entries(pkg[campo] ?? {})) {
        if (!nombre.startsWith('@odontocrm/') && esVersionExacta(spec)) {
          exactos.push({ ruta, campo, nombre, spec });
        }
      }
    }
  }
  return exactos;
};

const restaurarFijadosExactos = (exactos) => {
  let restaurados = false;
  for (const { ruta, campo, nombre, spec } of exactos) {
    const pkg = leerJson(ruta);
    if (pkg[campo]?.[nombre] !== undefined && pkg[campo][nombre] !== spec) {
      pkg[campo][nombre] = spec;
      escribirJson(ruta, pkg);
      restaurados = true;
    }
  }
  return restaurados;
};

const consultarDistTagsNpm = (paquete) => {
  if (!PATRON_PAQUETE.test(paquete)) throw new Error(`Nombre de paquete inválido: ${paquete}`);
  const r = ejecutarNpm(['view', paquete, 'dist-tags', '--json']);
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const consultarDependenciasRemotas = (paquete, version) => {
  const r = ejecutarNpm(['view', `${paquete}@${version}`, 'dependencies', '--json']);
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const asegurarArbolLimpio = (forzar) => {
  const estado = git(['status', '--porcelain']);
  if (estado !== '' && !forzar) {
    console.error(
      'deps: el árbol de git tiene cambios sin confirmar.\n' +
        '  Confírmalos o guárdalos antes de actualizar dependencias, para poder\n' +
        '  revertir limpio si `npm run verify` falla (o pasa `-- --forzar`).\n',
    );
    process.exit(1);
  }
};

const pararPila = () => {
  console.log('deps: deteniendo la pila local (evita archivos bloqueados en node_modules)…');
  spawnSync(process.execPath, [resolve(ROOT, 'tools/stack.mjs'), 'down'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
};

const prepararRama = (prefijo, enRama) => {
  const ramaOrigen = git(['rev-parse', '--abbrev-ref', 'HEAD'], { permitirFallo: true }) || 'main';
  if (enRama || ramaOrigen.startsWith('deps/')) {
    return { ramaOrigen, ramaTrabajo: ramaOrigen, creada: false };
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const base = `deps/${prefijo === '' ? hoy : `${prefijo}-${hoy}`}`;
  let candidata = base;
  let sufijo = 2;
  while (git(['rev-parse', '--verify', candidata], { permitirFallo: true }) !== '') {
    candidata = `${base}-${String(sufijo)}`;
    sufijo += 1;
  }
  git(['checkout', '-b', candidata]);
  console.log(`deps: creada la rama ${candidata} (desde ${ramaOrigen})`);
  return { ramaOrigen, ramaTrabajo: candidata, creada: true };
};

const revertirIntento = ({ ramaOrigen, ramaTrabajo, creada }) => {
  console.error('\ndeps: restaurando package.json, package-lock.json y node_modules…');
  git(['checkout', '--', '.'], { permitirFallo: true });
  if (creada) {
    git(['checkout', ramaOrigen], { permitirFallo: true });
    git(['branch', '-D', ramaTrabajo], { permitirFallo: true });
  }
  ejecutarNpm(['ci', '--silent'], { heredar: true });
};

const confirmarCambios = (
  titulo,
  lineasDetalle,
  { ramaOrigen, ramaTrabajo, creada, sinCommit },
) => {
  const estado = git([
    'status',
    '--porcelain',
    '--',
    'package.json',
    'package-lock.json',
    'apps',
    'packages',
    'services',
  ]);
  if (estado === '') {
    console.log('\ndeps: no hubo cambios en package-lock.json ni en package.json ✔');
    if (creada) {
      git(['checkout', ramaOrigen], { permitirFallo: true });
      git(['branch', '-D', ramaTrabajo], { permitirFallo: true });
    }
    return;
  }

  if (sinCommit) {
    console.log('\ndeps: verificación completada (--sin-commit: cambios listos en el árbol) ✔');
    return;
  }

  const rutasTocadas = ['package.json', 'package-lock.json', ...rutasPackageJson()];
  git(['add', '--', ...new Set(rutasTocadas)]);

  const argsCommit = ['commit', '-m', titulo];
  if (lineasDetalle.length > 0) {
    argsCommit.push('-m', lineasDetalle.join('\n'));
  }
  git(argsCommit);
  const hash = git(['rev-parse', '--short', 'HEAD']);
  console.log(`\ndeps: commit creado en ${ramaTrabajo} (${hash}): ${titulo} ✔`);
  if (creada) {
    console.log(
      `\nPara llevarlo a tu rama (${ramaOrigen}):\n` +
        `  git checkout ${ramaOrigen} && git merge --ff-only ${ramaTrabajo}\n`,
    );
  }
};

/* ── Comandos ──────────────────────────────────────────────────────────────── */

const comandoRevisar = () => {
  console.log('deps: consultando el estado de las dependencias…\n');
  const notifPkg = leerJson(NOTIF_PKG_REL);
  const baileysDeclarado = notifPkg.dependencies?.[BAILEYS_PKG] ?? 'no instalado';
  const boomDeclarado = notifPkg.dependencies?.[BOOM_PKG] ?? '—';

  const distTagsBaileys = consultarDistTagsNpm(BAILEYS_PKG);
  const baileysLatest = typeof distTagsBaileys?.latest === 'string' ? distTagsBaileys.latest : null;

  const rOutdated = ejecutarNpm(['outdated', '--workspaces', '--include-workspace-root', '--json']);
  let outdatedObj = {};
  if (rOutdated.stdout && rOutdated.stdout.trim() !== '') {
    try {
      outdatedObj = JSON.parse(rOutdated.stdout);
    } catch {
      outdatedObj = {};
    }
  }

  const { baileys, seguras, mayores } = clasificarDesactualizadas(outdatedObj, {
    baileysDeclarado,
    baileysLatest,
    boomDeclarado,
  });

  // 1. Baileys
  console.log('── WhatsApp (Baileys) ──────────────────────────────────────────────────');
  console.log(
    `  Instalada en notifications:  ${baileys.actual}` +
      (baileys.exacto ? ' (fijada exacta ✔)' : ' (⚠ tiene rango; debería ir exacta)'),
  );
  console.log(`  Última en npm (latest):      ${baileys.latest ?? '(sin red para consultar)'}`);
  console.log(`  @hapi/boom fijado:           ${baileys.boom}`);
  console.log(`  Notas de versión:            ${baileys.changelogUrl}`);
  if (!baileys.alDia && baileys.latest !== null) {
    console.log(`  → Hay versión nueva disponible. Ejecuta:  npm run deps:baileys`);
  } else if (baileys.latest !== null) {
    console.log('  → Baileys está al día ✔');
  }

  // 2. Seguras (parche y menor dentro del rango)
  console.log(
    `\n── Seguras (parche / menor dentro del rango ^): ${String(seguras.length)} ─────────────────────`,
  );
  if (seguras.length === 0) {
    console.log('  Todas las dependencias dentro de rango están al día ✔');
  } else {
    for (const item of seguras) {
      const donde =
        item.dependientes.slice(0, 3).join(', ') +
        (item.dependientes.length > 3 ? ` (+${String(item.dependientes.length - 3)})` : '');
      console.log(
        `  · ${item.paquete.padEnd(26)} ${item.actual.padEnd(10)} → ${item.deseada.padEnd(10)} (${donde})`,
      );
    }
    console.log('\n  Para aplicarlas y verificar:  npm run deps:actualizar');
  }

  // 3. Mayores
  console.log(
    `\n── Mayores o fuera del rango fijado: ${String(mayores.length)} ────────────────────────────────`,
  );
  if (mayores.length === 0) {
    console.log('  Ninguna pendiente ✔');
  } else {
    for (const item of mayores) {
      const donde =
        item.dependientes.slice(0, 3).join(', ') +
        (item.dependientes.length > 3 ? ` (+${String(item.dependientes.length - 3)})` : '');
      console.log(
        `  · ${item.paquete.padEnd(26)} ${item.actual.padEnd(10)} → ${item.ultima.padEnd(10)} (${donde})`,
      );
    }
    console.log('\n  Las mayores se suben de una en una:  npm run deps:mayor -- <paquete>');
  }

  // 4. Auditoría rápida
  console.log('\n── Auditoría de seguridad (npm audit) ──────────────────────────────────');
  const rAudit = ejecutarNpm(['audit', '--json']);
  if (rAudit.stdout) {
    try {
      const audit = JSON.parse(rAudit.stdout);
      const vulns = audit?.metadata?.vulnerabilities ?? {};
      const total = Number(vulns.total ?? 0);
      if (total === 0) {
        console.log('  0 vulnerabilidades conocidas ✔\n');
      } else {
        console.log(
          `  ⚠ ${String(total)} vulnerabilidad(es): ` +
            `críticas=${String(vulns.critical ?? 0)}, altas=${String(vulns.high ?? 0)}, ` +
            `moderadas=${String(vulns.moderate ?? 0)}, bajas=${String(vulns.low ?? 0)}\n`,
        );
      }
    } catch {
      console.log('  (no se pudo leer el resumen de npm audit)\n');
    }
  } else {
    console.log('  (sin conexión al registro de auditoría)\n');
  }
};

const comandoActualizar = (opciones) => {
  asegurarArbolLimpio(opciones.forzar);
  pararPila();

  const exactos = capturarFijadosExactos();
  const directos = recolectarPaquetesDirectos();
  const lockAntes = leerJson('package-lock.json');
  const contextoRama = prepararRama('', opciones.enRama);

  console.log('\ndeps: actualizando dependencias dentro de sus rangos semver…');
  const rUpdate = ejecutarNpm(['update', '--save'], {
    heredar: true,
  });
  if (rUpdate.status !== 0) {
    console.error('deps: falló `npm update`.');
    revertirIntento(contextoRama);
    process.exit(1);
  }

  // Garantiza que ningún pin exacto (como Baileys o @hapi/boom) haya ganado un `^`.
  if (restaurarFijadosExactos(exactos)) {
    ejecutarNpm(['install', '--package-lock-only', '--ignore-scripts'], { heredar: false });
  }

  const lockDespues = leerJson('package-lock.json');
  const cambios = resumirCambiosLock(lockAntes, lockDespues, directos);
  if (cambios.length === 0) {
    confirmarCambios('chore(deps): actualizar dependencias', [], {
      ...contextoRama,
      sinCommit: opciones.sinCommit,
    });
    return;
  }

  console.log(
    `\ndeps: cambiaron ${String(cambios.length)} paquete(s) en el lockfile; ejecutando verify…\n`,
  );
  ejecutarNpm(['exec', '--', 'prettier', '--write', ...rutasPackageJson()], { heredar: false });
  const rVerify = ejecutarNpm(['run', 'verify'], { heredar: true });
  if (rVerify.status !== 0) {
    console.error('\ndeps: `npm run verify` falló tras actualizar. Se deshacen los cambios.');
    revertirIntento(contextoRama);
    process.exit(1);
  }

  const cambiosDirectos = cambios.filter((c) => c.directo);
  const mostrados = (cambiosDirectos.length > 0 ? cambiosDirectos : cambios).slice(0, 25);
  const lineasDetalle = mostrados.map(
    (c) => `- ${c.paquete}: ${c.antes ?? 'nuevo'} -> ${c.despues}`,
  );
  if (cambios.length > mostrados.length) {
    lineasDetalle.push(
      `- (+${String(cambios.length - mostrados.length)} dependencias transitivas)`,
    );
  }

  confirmarCambios(
    `chore(deps): actualizar ${String(cambiosDirectos.length || cambios.length)} dependencia(s) dentro de rango`,
    lineasDetalle,
    { ...contextoRama, sinCommit: opciones.sinCommit },
  );
};

const imprimirChecklistBaileys = (version) => {
  console.log(
    `\n── Lista de comprobación manual para Baileys ${version} ───────────────────\n` +
      '  Las pruebas con socket falso ya pasaron; antes de desplegar en la clínica\n' +
      '  comprueba contra WhatsApp real:\n\n' +
      '  1. Arranca la pila:       npm run stack:dev\n' +
      '  2. Mira la sesión:        npm run whatsapp:estado\n' +
      '     → debe conectar con la sesión existente (sin pedir escanear QR de nuevo)\n' +
      '     → verifica que `baileysVersion` muestre ' +
      version +
      '\n' +
      '  3. Envía un aviso de prueba a un número propio y responde desde el teléfono\n' +
      '     para confirmar tanto salida como mensajes entrantes.\n' +
      '  4. En el servidor instalado:  odontocrm actualizar\n' +
      '     (si algo saliera mal:      odontocrm revertir)\n',
  );
};

const comandoBaileys = (versionArg, opciones) => {
  const notifPkg = leerJson(NOTIF_PKG_REL);
  const actual = notifPkg.dependencies?.[BAILEYS_PKG] ?? '';
  let objetivo = versionArg ?? null;

  if (objetivo === null) {
    const tags = consultarDistTagsNpm(BAILEYS_PKG);
    if (typeof tags?.latest !== 'string') {
      console.error('deps: no pude consultar la última versión de Baileys en npm.');
      process.exit(1);
    }
    objetivo = tags.latest;
  }

  if (!PATRON_VERSION.test(objetivo)) {
    console.error(`deps: versión inválida: "${objetivo}"`);
    process.exit(1);
  }

  if (actual === objetivo && !opciones.forzar) {
    console.log(`deps: ${BAILEYS_PKG} ya está fijado exactamente en ${objetivo} ✔`);
    imprimirChecklistBaileys(objetivo);
    return;
  }

  asegurarArbolLimpio(opciones.forzar);
  pararPila();

  const contextoRama = prepararRama(`baileys-${objetivo}`, opciones.enRama);

  // Comprobar si la nueva versión de Baileys exige otro @hapi/boom.
  const depsRemotas = consultarDependenciasRemotas(BAILEYS_PKG, objetivo);
  const rangoBoom = depsRemotas?.[BOOM_PKG];
  const boomActual = notifPkg.dependencies?.[BOOM_PKG] ?? '';
  const compatBoom = evaluarCompatibilidadBoom(rangoBoom, boomActual);

  const paquetesAInstalar = [`${BAILEYS_PKG}@${objetivo}`];
  if (!compatBoom.compatible && compatBoom.sugerida !== null) {
    console.log(
      `deps: Baileys ${objetivo} pide ${BOOM_PKG} (${String(rangoBoom)}); ` +
        `alineando ${BOOM_PKG} de ${boomActual} a ${compatBoom.sugerida}…`,
    );
    paquetesAInstalar.push(`${BOOM_PKG}@${compatBoom.sugerida}`);
  }

  console.log(`\ndeps: instalando ${paquetesAInstalar.join(' ')} (--save-exact) en notifications…`);
  const rInstall = ejecutarNpm(
    ['install', '--save-exact', '-w', '@odontocrm/notifications', ...paquetesAInstalar],
    { heredar: true },
  );
  if (rInstall.status !== 0) {
    console.error('deps: falló la instalación de Baileys.');
    revertirIntento(contextoRama);
    process.exit(1);
  }

  // Asegurar que la versión quedó escrita exacta (sin ^ ni ~).
  const notifDespues = leerJson(NOTIF_PKG_REL);
  const escrita = notifDespues.dependencies?.[BAILEYS_PKG] ?? '';
  if (!esVersionExacta(escrita)) {
    notifDespues.dependencies[BAILEYS_PKG] = objetivo;
    escribirJson(NOTIF_PKG_REL, notifDespues);
  }

  console.log('\ndeps: ejecutando pruebas focalizadas del canal WhatsApp…');
  const rTestWa = ejecutarNpm(
    ['exec', '--', 'vitest', 'run', 'services/notifications/src/canales'],
    { heredar: true },
  );
  if (rTestWa.status !== 0) {
    console.error(
      '\ndeps: fallaron las pruebas de canales/whatsapp con la nueva versión de Baileys.',
    );
    revertirIntento(contextoRama);
    process.exit(1);
  }

  console.log('\ndeps: ejecutando verificación completa del proyecto (`npm run verify`)…');
  ejecutarNpm(['exec', '--', 'prettier', '--write', ...rutasPackageJson()], { heredar: false });
  const rVerify = ejecutarNpm(['run', 'verify'], { heredar: true });
  if (rVerify.status !== 0) {
    console.error('\ndeps: `npm run verify` falló. Se restaura la versión anterior de Baileys.');
    revertirIntento(contextoRama);
    process.exit(1);
  }

  const detalle = [`- ${BAILEYS_PKG}: ${actual || 'ninguna'} -> ${objetivo}`];
  if (paquetesAInstalar.length > 1 && compatBoom.sugerida !== null) {
    detalle.push(`- ${BOOM_PKG}: ${boomActual} -> ${compatBoom.sugerida}`);
  }

  confirmarCambios(`chore(whatsapp): actualizar ${BAILEYS_PKG} a ${objetivo}`, detalle, {
    ...contextoRama,
    sinCommit: opciones.sinCommit,
  });
  imprimirChecklistBaileys(objetivo);
};

const comandoMayor = (paquete, versionArg, opciones) => {
  if (!paquete || !PATRON_PAQUETE.test(paquete)) {
    console.error('uso: npm run deps:mayor -- <paquete> [versión]');
    process.exit(2);
  }
  if (paquete === BAILEYS_PKG) {
    comandoBaileys(versionArg, opciones);
    return;
  }

  const apariciones = [];
  for (const ruta of rutasPackageJson()) {
    const pkg = leerJson(ruta);
    for (const campo of ['dependencies', 'devDependencies']) {
      const spec = pkg[campo]?.[paquete];
      if (typeof spec === 'string') {
        apariciones.push({ ruta, campo, spec });
      }
    }
  }

  if (apariciones.length === 0) {
    console.error(`deps: el paquete "${paquete}" no figura en ningún package.json del monorepo.`);
    process.exit(1);
  }

  let objetivo = versionArg ?? null;
  if (objetivo === null) {
    const tags = consultarDistTagsNpm(paquete);
    if (typeof tags?.latest !== 'string') {
      console.error(`deps: no pude consultar la última versión de ${paquete} en npm.`);
      process.exit(1);
    }
    objetivo = tags.latest;
  }

  if (!PATRON_VERSION.test(objetivo)) {
    console.error(`deps: versión inválida: "${objetivo}"`);
    process.exit(1);
  }

  asegurarArbolLimpio(opciones.forzar);
  pararPila();

  const nombreRama = paquete.replace(/^@/, '').replace(/\//g, '-');
  const contextoRama = prepararRama(`${nombreRama}-${objetivo}`, opciones.enRama);

  for (const { ruta, campo, spec } of apariciones) {
    const pkg = leerJson(ruta);
    const prefijo = esVersionExacta(spec) ? '' : '^';
    pkg[campo][paquete] = `${prefijo}${objetivo}`;
    escribirJson(ruta, pkg);
  }

  console.log(
    `\ndeps: instalando ${paquete}@${objetivo} en ${String(apariciones.length)} package.json…`,
  );
  const rInstall = ejecutarNpm(['install'], { heredar: true });
  if (rInstall.status !== 0) {
    console.error(`deps: falló \`npm install\` al subir ${paquete} a ${objetivo}.`);
    revertirIntento(contextoRama);
    process.exit(1);
  }

  console.log('\ndeps: ejecutando `npm run verify`…');
  ejecutarNpm(['exec', '--', 'prettier', '--write', ...rutasPackageJson()], { heredar: false });
  const rVerify = ejecutarNpm(['run', 'verify'], { heredar: true });
  if (rVerify.status !== 0) {
    console.error(
      `\ndeps: ${paquete}@${objetivo} rompió la verificación (mira los errores arriba).\n` +
        '  Se deshace el cambio; si requiere adaptar código, hazlo en una rama dedicada.',
    );
    revertirIntento(contextoRama);
    process.exit(1);
  }

  const antes = apariciones[0]?.spec ?? '—';
  confirmarCambios(
    `chore(deps): actualizar ${paquete} a ${objetivo}`,
    [`- ${paquete}: ${antes} -> ${objetivo}`],
    { ...contextoRama, sinCommit: opciones.sinCommit },
  );
};

const mostrarAyuda = () => {
  console.log(
    'uso: node tools/deps.mjs <orden> [argumentos] [--en-rama] [--sin-commit] [--forzar]\n\n' +
      '  npm run deps                           Estado de librerías (seguras, mayores, Baileys, audit)\n' +
      '  npm run deps:actualizar                Actualiza menores/parche, verifica y hace commit\n' +
      '  npm run deps:baileys [-- <versión>]    Actualiza Baileys exacto y prueba el canal WhatsApp\n' +
      '  npm run deps:mayor -- <paquete> [ver]  Actualiza una versión mayor de una en una\n',
  );
};

const main = () => {
  const crudos = process.argv.slice(2);
  const banderas = new Set(crudos.filter((arg) => arg.startsWith('-')));
  const posicionales = crudos.filter((arg) => !arg.startsWith('-'));

  if (banderas.has('--help') || banderas.has('-h')) {
    mostrarAyuda();
    return;
  }

  const orden = posicionales[0] ?? 'revisar';
  const opciones = {
    enRama: banderas.has('--en-rama'),
    sinCommit: banderas.has('--sin-commit'),
    forzar: banderas.has('--forzar'),
  };

  switch (orden) {
    case 'revisar':
    case 'estado':
    case 'status':
      comandoRevisar();
      break;
    case 'actualizar':
    case 'update':
      comandoActualizar(opciones);
      break;
    case 'baileys':
      comandoBaileys(posicionales[1], opciones);
      break;
    case 'mayor':
    case 'major':
      comandoMayor(posicionales[1], posicionales[2], opciones);
      break;
    case 'ayuda':
    case 'help':
      mostrarAyuda();
      break;
    default:
      console.error(`deps: orden desconocida "${orden}"`);
      mostrarAyuda();
      process.exit(2);
  }
};

const esEjecucionDirecta =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (esEjecucionDirecta) {
  main();
}
