#!/usr/bin/env node
/**
 * La pila del proyecto, en un solo comando: **una sola instancia a la vez**.
 *
 *   npm run stack:status     ¿quién está corriendo, en qué puerto y desde cuándo?
 *   npm run stack:down       para la pila (PM2 incluido) y deja los puertos libres
 *   npm run stack:dev        para lo que haya y arranca el desarrollo con recarga
 *   npm run stack:fijo       para lo que haya, compila y arranca con PM2 (sin recarga)
 *
 * El problema que resuelve es concreto y ya pasó: se abrió una pila sin recarga
 * (procesos sueltos o PM2 huérfano) mientras `npm run dev` seguía reintentando sus
 * puertos; `npm run dev` se negaba a arrancar por el preflight, PM2 acumulaba
 * reinicios y, al final, nadie sabía quién servía la aplicación. Aquí los puertos
 * son la fuente de verdad: si están tomados, hay una pila, y este comando dice cuál
 * es y la cambia de modo sin dejar dos vivas.
 *
 * Para lo que **no** hace: matar un programa ajeno que ocupe un puerto de la lista
 * (se avisa y se deja en paz), ni tocar la base de datos.
 */
import { spawn, spawnSync } from 'node:child_process';

import { bloqueoVigente } from './lib/mantenimiento.mjs';
import { PUERTOS, cuando, esperarLibre, matar, retratoDeLaPila } from './lib/stack.mjs';

const accion = process.argv[2] ?? 'status';
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const linea = (texto) => console.log(texto);

/**
 * No se arranca nada mientras haya una operación de mantenimiento en curso
 * (`db:reset`): los servicios que apunten a una base que ya no existe se caen al
 * conectar. Parar (`down`) y consultar el estado (`status`) sí se permiten.
 */
const bloquearSiHayMantenimiento = () => {
  const bloqueo = bloqueoVigente();
  if (bloqueo === null || !bloqueo.vivo) return false;

  console.error(
    `stack: hay una operación de mantenimiento en curso (${bloqueo.tarea}, PID ${String(bloqueo.pid)}).\n` +
      '  No se arranca la pila hasta que termine: los servicios que apunten a una base\n' +
      '  que ya no existe se caen al conectar.\n\n' +
      '  · Espérala.\n' +
      '  · Si ese proceso ya no existe:  npm run dev:check   (limpia el bloqueo caducado)\n',
  );
  process.exit(1);
};

const pintaEstado = (retrato) => {
  if (retrato.ocupados.length === 0) {
    linea('stack: no hay nada corriendo; los puertos están libres ✔');
    return;
  }

  const comoSeDice = {
    dev: 'desarrollo, con recarga',
    fijo: 'fija, sin recarga',
    mixta: 'mezclada (parte con recarga y parte sin ella)',
    'solo-web': 'solo la interfaz',
  };
  const modo = comoSeDice[retrato.modo] ?? retrato.modo;

  linea(
    `stack: hay una pila «${modo}» con ${String(retrato.ocupados.length)} de ` +
      `${String(PUERTOS.length)} puertos ocupados:\n`,
  );
  for (const entrada of retrato.ocupados) {
    const quien =
      entrada.pid === null ? entrada.nombre : `${entrada.nombre} (PID ${String(entrada.pid)})`;
    linea(
      `  ${String(entrada.puerto).padStart(4)} · ${entrada.servicio.padEnd(14)} → ${quien}` +
        `  desde ${cuando(entrada.desde)}${entrada.conWatch ? ' · con recarga' : ''}`,
    );
  }
  if (retrato.aplicacionesPm2.length > 0) {
    linea(`\n  PM2 tiene ${String(retrato.aplicacionesPm2.length)} aplicación(es) en marcha.`);
  } else if (retrato.aplicacionesRegistradas.length > 0) {
    linea(
      `\n  PM2 tiene ${String(retrato.aplicacionesRegistradas.length)} aplicación(es) registradas pero detenidas.`,
    );
  }
  const libres = PUERTOS.filter(
    (entrada) => !retrato.ocupados.some((ocupado) => ocupado.puerto === entrada.puerto),
  );
  if (libres.length > 0) {
    linea(`  Libres: ${libres.map((entrada) => String(entrada.puerto)).join(', ')}`);
  }
};

/** Para la pila entera: primero PM2 (si tiene apps) y luego quien tome los puertos. */
const parar = async () => {
  const retrato = await retratoDeLaPila();

  if (retrato.ocupados.length === 0 && retrato.aplicacionesRegistradas.length === 0) {
    linea('stack: no había nada que parar ✔');
    return true;
  }

  if (retrato.aplicacionesPm2.length > 0) {
    linea(`stack: parando ${String(retrato.aplicacionesPm2.length)} aplicación(es) de PM2…`);
    // Comando en una sola cadena: con `shell` y una lista de argumentos, Node avisa
    // (DEP0190) de que no los escapa.
    spawnSync('pm2 stop all', { stdio: 'inherit', shell: true });
  }

  let parados = 0;
  let ajenos = 0;
  for (const entrada of retrato.ocupados) {
    if (entrada.pid === null) {
      console.warn(`  ⚠ ${String(entrada.puerto)} ocupado, pero no se pudo saber por qué proceso`);
      continue;
    }
    if (!entrada.nuestra) {
      console.warn(
        `  ⚠ ${String(entrada.puerto)} lo ocupa ${entrada.nombre}, que no es de la pila: se deja`,
      );
      ajenos += 1;
      continue;
    }

    matar(entrada.pid);
    // Lo que decide es el puerto, no el código de salida de `taskkill`.
    const libre = await esperarLibre(entrada.puerto);
    linea(
      libre
        ? `  ✔ ${String(entrada.puerto)} liberado (${entrada.nombre}, PID ${String(entrada.pid)})`
        : `  ✖ ${String(entrada.puerto)} sigue ocupado (${entrada.nombre}, PID ${String(entrada.pid)}): ¿permisos?`,
    );
    if (libre) parados += 1;
  }

  // Los puertos mandan: si alguno sigue tomado, la pila no se puede levantar.
  for (let intento = 0; intento < 10; intento += 1) {
    const despues = await retratoDeLaPila();
    if (despues.ocupados.length === 0) {
      linea(`\nstack: ${String(parados)} proceso(s) terminado(s); puertos libres ✔`);
      return true;
    }
    if (intento === 9) {
      linea(
        `\nstack: siguen ocupados ${despues.ocupados.map((entrada) => String(entrada.puerto)).join(', ')}` +
          (ajenos > 0 ? ` (${String(ajenos)} ajeno(s) a la pila)` : ''),
      );
      return despues.ocupados.every((entrada) => !entrada.nuestra);
    }
    await esperar(400);
  }
  return false;
};

/** Guardia de arranque: falla si ya hay una pila (lo usan `predev` y `prestart:*`). */
const guardia = async () => {
  const puerto = process.argv.includes('--puerto')
    ? Number(process.argv[process.argv.indexOf('--puerto') + 1])
    : null;
  const retrato = await retratoDeLaPila();
  const choque =
    puerto === null
      ? retrato.ocupados
      : retrato.ocupados.filter((entrada) => entrada.puerto === puerto);

  if (choque.length === 0) {
    linea(
      puerto === null
        ? 'stack: puertos libres; puedes arrancar ✔'
        : `stack: el puerto ${String(puerto)} está libre ✔`,
    );
    return 0;
  }

  console.error('stack: ya hay una pila corriendo y solo puede haber una:\n');
  pintaEstado({ ...retrato, ocupados: choque });
  console.error(
    '\nQué hacer:' +
      '\n  · Ver el estado completo:   npm run stack:status' +
      '\n  · Pararla y arrancar esto:  npm run stack:down  y luego este comando' +
      '\n  · Cambiar de modo:          npm run stack:dev   (con recarga)' +
      '\n                              npm run stack:fijo  (sin recarga, con PM2)\n',
  );
  return 1;
};

const esperarSalud = async (intentos = 30) => {
  for (let intento = 0; intento < intentos; intento += 1) {
    try {
      const respuesta = await fetch('http://127.0.0.1:8090/health');
      if (respuesta.ok) return true;
    } catch {
      // Todavía no responde.
    }
    await esperar(1_000);
  }
  return false;
};

/** Arranca el desarrollo con recarga, en primer plano (los registros se ven aquí). */
const arrancarDev = () => {
  const hijo = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: true });
  hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
};

/** Compila y deja la pila con PM2 (sin recarga), que sobrevive a esta terminal. */
const arrancarFijo = async () => {
  linea('stack: compilando (tsc -b)…');
  const compilado = spawnSync('npm run build:node', { stdio: 'inherit', shell: true });
  if (compilado.status !== 0) {
    console.error('stack: la compilación falló; no se arranca nada');
    process.exit(1);
  }

  // Se borran las aplicaciones registradas para que el arranque sea determinista:
  // si quedaran detenidas, PM2 podría reutilizar la definición vieja o negarse a
  // relanzarlas. Ya están paradas (lo hizo `parar()`), así que no se pierde nada.
  if ((await retratoDeLaPila()).aplicacionesRegistradas.length > 0) {
    spawnSync('pm2 delete all', { stdio: 'inherit', shell: true });
  }

  linea('stack: arrancando con PM2…');
  const arrancado = spawnSync('pm2 start infra/windows/ecosystem.config.cjs', {
    stdio: 'inherit',
    shell: true,
  });
  if (arrancado.status !== 0) {
    console.error('stack: PM2 no pudo arrancar la pila (¿está instalado? `npm i -g pm2`)');
    process.exit(1);
  }

  if (await esperarSalud()) {
    linea('\nstack: la puerta responde en http://127.0.0.1:8090/health ✔');
  } else {
    console.error('\nstack: el gateway no respondió a tiempo; mira `pm2 logs odontocrm-gateway`');
  }
  pintaEstado(await retratoDeLaPila());
  linea('\n  Registros:  pm2 logs odontocrm-clinical     (o `npm run stack:status`)');
  linea('  Pararla:    npm run stack:down');
  linea('  La interfaz va incluida: http://127.0.0.1:5173\n');
};

switch (accion) {
  case 'status': {
    pintaEstado(await retratoDeLaPila());
    break;
  }
  case 'down': {
    const libre = await parar();
    process.exit(libre ? 0 : 1);
    break;
  }
  case 'guard': {
    process.exit(await guardia());
    break;
  }
  case 'dev': {
    bloquearSiHayMantenimiento();
    if (!(await parar())) {
      console.error('stack: no se pudieron liberar los puertos; no se arranca');
      process.exit(1);
    }
    arrancarDev();
    break;
  }
  case 'fijo': {
    bloquearSiHayMantenimiento();
    if (!(await parar())) {
      console.error('stack: no se pudieron liberar los puertos; no se arranca');
      process.exit(1);
    }
    await arrancarFijo();
    break;
  }
  default: {
    console.error(
      `stack: acción desconocida «${accion}».\n` +
        '  Usa: status · down · dev · fijo · guard [--puerto 4005]',
    );
    process.exit(1);
  }
}
