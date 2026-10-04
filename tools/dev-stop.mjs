#!/usr/bin/env node
/**
 * Para lo que dejó vivo un `npm run dev` anterior (servicios sueltos y el Vite de
 * la interfaz) para poder volver a arrancar sin puertos ocupados.
 *
 *   npm run dev:stop
 *
 * Lo que **no** hace: tocar los procesos de PM2. Esos se paran con `pm2 stop all`
 * (matarlos por PID haría que PM2 los reintentara). Se informa de cuáles son.
 */
import { execFileSync, execSync } from 'node:child_process';
import { createConnection } from 'node:net';

const PUERTOS = [5173, 8090, 4001, 4002, 4003, 4004, 4005, 4006, 4007];
const HOST = '127.0.0.1';

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

const aplicacionesPm2 = () => {
  try {
    // `pm2` es un `.cmd` en Windows: hay que lanzarlo con shell (comando fijo).
    return JSON.parse(
      execSync('pm2 jlist', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
  } catch {
    return [];
  }
};

const matar = (pid) => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
};

const pm2 = aplicacionesPm2();
const dePm2 = new Map(pm2.map((app) => [app?.pid, String(app?.name ?? 'app')]));

const ocupados = [];
for (const puerto of PUERTOS) {
  if (await estaOcupado(puerto)) ocupados.push({ puerto, pid: pidDelPuerto(puerto) });
}

if (ocupados.length === 0) {
  console.log('dev:stop: no hay nada ocupando los puertos de desarrollo ✔');
  process.exit(0);
}

console.log('Parando lo que dejó el desarrollo anterior:\n');
let matados = 0;
const conPm2 = new Set();

for (const entrada of ocupados) {
  if (entrada.pid === null) {
    console.warn(`  ⚠ ${String(entrada.puerto)} ocupado, pero no se pudo saber por qué proceso`);
    continue;
  }

  const nombrePm2 = dePm2.get(entrada.pid);
  if (nombrePm2 !== undefined) {
    conPm2.add(nombrePm2);
    console.log(
      `  · ${String(entrada.puerto)} · ${nombrePm2} es de PM2: se deja (usa \`pm2 stop ${nombrePm2}\`)`,
    );
    continue;
  }

  const hecho = matar(entrada.pid);
  console.log(
    hecho
      ? `  ✔ ${String(entrada.puerto)} liberado (PID ${String(entrada.pid)})`
      : `  ✖ ${String(entrada.puerto)}: no se pudo terminar el PID ${String(entrada.pid)} (¿permisos?)`,
  );
  if (hecho) matados += 1;
}

if (conPm2.size > 0) {
  console.log(`\nServicios de PM2 en marcha: ${[...conPm2].join(', ')}`);
  console.log('  Para pararlos:  pm2 stop all   (o `pm2 stop <nombre>`)');
}

// Comprobación final: que los puertos que tocábamos estén de verdad libres.
const siguen = [];
for (const puerto of PUERTOS) {
  if (await estaOcupado(puerto)) siguen.push(puerto);
}

console.log(
  siguen.length === 0
    ? `\ndev:stop: ${String(matados)} proceso(s) terminado(s); puertos de desarrollo libres ✔`
    : `\ndev:stop: ${String(matados)} proceso(s) terminado(s); siguen ocupados: ${siguen.join(', ')}`,
);
process.exit(0);
