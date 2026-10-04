#!/usr/bin/env node
/**
 * Para lo que dejó vivo un `npm run dev` anterior (servicios sueltos y el Vite de
 * la interfaz) para poder volver a arrancar sin puertos ocupados.
 *
 *   npm run dev:stop
 *
 * Es el caso «sueltos» de `npm run stack:down`: aquel además para las aplicaciones
 * de PM2. Aquí, si un puerto lo tiene PM2, **no se mata por PID** (PM2 lo
 * reintentaría): se dice qué aplicación es y cómo pararla.
 */
import {
  PUERTOS,
  matar,
  nombreDeProceso,
  pidDelPuerto,
  estaOcupado,
  aplicacionesPm2,
} from './lib/stack.mjs';

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pm2 = aplicacionesPm2();
const dePm2 = new Map(pm2.map((app) => [Number(app.pid), String(app.name ?? 'app')]));

const ocupados = [];
for (const puerto of PUERTOS) {
  if (await estaOcupado(puerto.puerto)) {
    ocupados.push({ ...puerto, pid: pidDelPuerto(puerto.puerto) });
  }
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

  matar(entrada.pid);
  // Lo que decide es el puerto: `taskkill` falla si el proceso ya murió o si su
  // padre se lo llevó por delante, y en los dos casos el puerto queda libre igual.
  let libre = false;
  for (let intento = 0; intento < 12 && !libre; intento += 1) {
    libre = !(await estaOcupado(entrada.puerto));
    if (!libre) await esperar(300);
  }
  console.log(
    libre
      ? `  ✔ ${String(entrada.puerto)} liberado (${nombreDeProceso(entrada.pid)}, PID ${String(entrada.pid)})`
      : `  ✖ ${String(entrada.puerto)} sigue ocupado (PID ${String(entrada.pid)}): ¿permisos?`,
  );
  if (libre) matados += 1;
}

if (conPm2.size > 0) {
  console.log(`\nServicios de PM2 en marcha: ${[...conPm2].join(', ')}`);
  console.log('  Para pararlos:  npm run stack:down   (o `pm2 stop all`)');
}

// Comprobación final: que los puertos que tocábamos estén de verdad libres.
const siguen = [];
for (const puerto of PUERTOS) {
  if (await estaOcupado(puerto.puerto)) siguen.push(puerto.puerto);
}

console.log(
  siguen.length === 0
    ? `\ndev:stop: ${String(matados)} proceso(s) terminado(s); puertos de desarrollo libres ✔`
    : `\ndev:stop: ${String(matados)} proceso(s) terminado(s); siguen ocupados: ${siguen.join(', ')}`,
);
process.exit(0);
