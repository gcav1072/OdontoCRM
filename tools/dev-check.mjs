#!/usr/bin/env node
/**
 * Preflight de `npm run dev`: comprueba que los puertos que va a necesitar estén
 * **libres** y, si no lo están, dice quién los ocupa, desde cuándo y cómo
 * liberarlos.
 *
 *   npm run dev:check          (se ejecuta solo antes de `npm run dev`)
 *   npm run dev:check -- --all (no falla: solo informa)
 *
 * Existe por un caso real: un servidor de Vite de una sesión anterior seguía
 * ocupando el 5173 con el grafo de módulos roto; `npm run dev` no podía tomar el
 * puerto (`strictPort`), `concurrently -k` mataba el resto y el navegador seguía
 * mirando el servidor viejo: pantalla en negro sin ningún mensaje.
 */
import { execFileSync, execSync } from 'node:child_process';
import { createConnection } from 'node:net';

/** Puertos que usa el arranque de desarrollo, en el orden en que se comprueban. */
const PUERTOS = [
  { puerto: 5173, servicio: 'web (Vite)', arranca: 'dev:web' },
  { puerto: 8090, servicio: 'gateway', arranca: 'dev:gateway' },
  { puerto: 4001, servicio: 'identity', arranca: 'dev:identity' },
  { puerto: 4002, servicio: 'patients', arranca: 'dev:patients' },
  { puerto: 4003, servicio: 'scheduling', arranca: 'dev:scheduling' },
  { puerto: 4004, servicio: 'notifications', arranca: 'dev:notifications' },
  { puerto: 4005, servicio: 'clinical', arranca: 'dev:clinical' },
  { puerto: 4007, servicio: 'screens', arranca: 'dev:screens' },
];

const soloInformar = process.argv.includes('--all');
const HOST = '127.0.0.1';

/** ¿Hay alguien escuchando en ese puerto? */
const estaOcupado = (puerto) =>
  new Promise((resolve) => {
    const socket = createConnection({ port: puerto, host: HOST });
    const terminar = (ocupado) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ocupado);
    };
    socket.setTimeout(700);
    socket.once('connect', () => terminar(true));
    socket.once('timeout', () => terminar(false));
    socket.once('error', () => terminar(false));
  });

/** PID que escucha en un puerto (Windows: netstat; Linux: ss). Best-effort. */
const pidDelPuerto = (puerto) => {
  try {
    if (process.platform === 'win32') {
      const salida = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      for (const linea of salida.split(/\r?\n/)) {
        const campos = linea.trim().split(/\s+/);
        if (
          campos.length >= 5 &&
          campos[1]?.endsWith(`:${String(puerto)}`) &&
          campos[3] === 'LISTENING'
        ) {
          return Number(campos[4]);
        }
      }
      return null;
    }

    const salida = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
    for (const linea of salida.split('\n')) {
      if (!linea.includes(`:${String(puerto)} `)) continue;
      const coincidencia = /pid=(\d+)/.exec(linea);
      if (coincidencia?.[1] !== undefined) return Number(coincidencia[1]);
    }
    return null;
  } catch {
    return null;
  }
};

/** Nombre del proceso y, si es de PM2, el nombre de la aplicación. */
const describirProceso = (pid) => {
  if (pid === null) return { nombre: 'desconocido', pm2: null };

  const aplicaciones = (() => {
    try {
      // `pm2` es un `.cmd` en Windows: hay que lanzarlo con shell (comando fijo,
      // sin nada del usuario) o Node lo rechaza.
      const crudo = execSync('pm2 jlist', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return JSON.parse(crudo);
    } catch {
      return [];
    }
  })();

  const dePm2 = aplicaciones.find((app) => app?.pid === pid);
  if (dePm2 !== undefined) {
    return { nombre: `PM2 · ${String(dePm2.name ?? 'app')}`, pm2: String(dePm2.name ?? '') };
  }

  try {
    if (process.platform === 'win32') {
      const salida = execFileSync(
        'tasklist',
        ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
        {
          encoding: 'utf8',
        },
      );
      const nombre = salida.split(',')[0]?.replace(/"/g, '').trim();
      return { nombre: nombre === undefined || nombre === '' ? 'desconocido' : nombre, pm2: null };
    }
    const salida = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return { nombre: salida.trim() || 'desconocido', pm2: null };
  } catch {
    return { nombre: 'desconocido', pm2: null };
  }
};

const ocupados = [];
for (const entrada of PUERTOS) {
  if (await estaOcupado(entrada.puerto)) {
    const pid = pidDelPuerto(entrada.puerto);
    ocupados.push({ ...entrada, pid, ...describirProceso(pid) });
  }
}

if (ocupados.length === 0) {
  console.log('dev:check: los puertos del desarrollo están libres ✔');
  process.exit(0);
}

console.error('dev:check: hay puertos ocupados y `npm run dev` los necesita todos:\n');
for (const entrada of ocupados) {
  const quien =
    entrada.pid === null ? entrada.nombre : `${entrada.nombre} (PID ${String(entrada.pid)})`;
  console.error(
    `  ✖ ${String(entrada.puerto).padStart(4)} · ${entrada.servicio.padEnd(14)} → ${quien}`,
  );
}

const conPm2 = ocupados.some((entrada) => entrada.pm2 !== null);

console.error('\nQué hacer:');
if (conPm2) {
  console.error(
    '  · Los servicios están arrancados con PM2, que ocupa los mismos puertos.\n' +
      '      Para trabajar en modo desarrollo:   pm2 stop all   y luego   npm run dev\n' +
      '      Para seguir con PM2 y solo la web:  npm run dev:web   (usa el 5173)',
  );
} else {
  console.error(
    '  · Suele ser un `npm run dev` o un Vite de una sesión anterior que quedó vivo.\n' +
      '      Pararlo:   npm run dev:stop        y luego   npm run dev',
  );
}
console.error('  · Ver solo el estado, sin fallar:   npm run dev:check -- --all\n');

process.exit(soloInformar ? 0 : 1);
