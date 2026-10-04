/**
 * Lo que saben `dev:check`, `dev:stop` y `stack:*` sobre la pila del proyecto.
 *
 * Aquí está **la única tabla de puertos** y la única forma de averiguar quién los
 * ocupa: los tres comandos miran lo mismo, así que no pueden discrepar. Los puertos
 * son la fuente de verdad —no un archivo de candado, que se queda obsoleto si un
 * proceso muere de golpe—: si un puerto está tomado, hay una pila (o un intruso).
 */
import { execFileSync, execSync } from 'node:child_process';
import { createConnection } from 'node:net';

export const HOST = '127.0.0.1';

/**
 * Puertos de la pila, en el orden en que se comprueban (primero lo que se mira a
 * mano: la interfaz y la puerta).
 */
export const PUERTOS = [
  { puerto: 5173, servicio: 'web (Vite)', script: 'dev:web' },
  { puerto: 8090, servicio: 'gateway', script: 'dev:gateway' },
  { puerto: 4001, servicio: 'identity', script: 'dev:identity' },
  { puerto: 4002, servicio: 'patients', script: 'dev:patients' },
  { puerto: 4003, servicio: 'scheduling', script: 'dev:scheduling' },
  { puerto: 4004, servicio: 'notifications', script: 'dev:notifications' },
  { puerto: 4005, servicio: 'clinical', script: 'dev:clinical' },
  { puerto: 4006, servicio: 'odontogram', script: 'dev:odontogram' },
  { puerto: 4007, servicio: 'screens', script: 'dev:screens' },
  { puerto: 4008, servicio: 'reporting', script: 'dev:reporting' },
];

/** ¿Hay alguien escuchando en ese puerto? */
export const estaOcupado = (puerto) =>
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
export const pidDelPuerto = (puerto) => {
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

/** Aplicaciones que PM2 tiene registradas (vacío si PM2 no está o no responde). */
export const aplicacionesPm2 = () => {
  try {
    // `pm2` es un `.cmd` en Windows: hay que lanzarlo con shell (comando fijo, sin
    // nada del usuario) o Node lo rechaza.
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

/**
 * Nombre, línea de comandos y hora de arranque de uno o varios procesos.
 *
 * Se piden **todos de una vez** (una sola llamada al sistema) porque en Windows cada
 * consulta cuesta ~200 ms y con nueve puertos se nota.
 */
export const detallesDeProcesos = (pids) => {
  const buscados = pids.filter((pid) => pid !== null);
  const detalles = new Map();
  if (buscados.length === 0) return detalles;

  try {
    if (process.platform === 'win32') {
      const filtro = buscados.map((pid) => `ProcessId = ${String(pid)}`).join(' or ');
      const crudo = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "${filtro}" | ` +
            'Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const lista = JSON.parse(crudo.trim() === '' ? '[]' : crudo);
      for (const fila of Array.isArray(lista) ? lista : [lista]) {
        detalles.set(Number(fila.ProcessId), {
          comando: String(fila.CommandLine ?? ''),
          padre: Number(fila.ParentProcessId ?? 0),
          // `/Date(1759600214000)/` → ISO
          desde: (() => {
            const milisegundos = /\/Date\((\d+)\)\//.exec(String(fila.CreationDate ?? ''));
            return milisegundos?.[1] === undefined
              ? null
              : new Date(Number(milisegundos[1])).toISOString();
          })(),
        });
      }
      return detalles;
    }

    for (const pid of buscados) {
      try {
        const comando = execFileSync('cat', [`/proc/${String(pid)}/cmdline`], { encoding: 'utf8' })
          .split('\0')
          .filter((parte) => parte !== '')
          .join(' ');
        const desde = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim();
        detalles.set(pid, { comando, padre: 0, desde });
      } catch {
        // El proceso desapareció entre la comprobación y la consulta.
      }
    }
  } catch {
    // Sin detalles: los comandos siguen funcionando con el nombre del proceso.
  }

  return detalles;
};

/** Nombre del ejecutable de un proceso (Windows: tasklist; Linux: ps). */
export const nombreDeProceso = (pid) => {
  if (pid === null) return 'desconocido';
  try {
    if (process.platform === 'win32') {
      const salida = execFileSync(
        'tasklist',
        ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' },
      );
      const nombre = salida.split(',')[0]?.replace(/"/g, '').trim();
      return nombre === undefined || nombre === '' ? 'desconocido' : nombre;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  } catch {
    return 'desconocido';
  }
};

/** Mata un proceso y su árbol. Devuelve si lo consiguió. */
export const matar = (pid) => {
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

/**
 * Espera a que un puerto quede libre de verdad.
 *
 * Es lo único que decide si un proceso se paró: `taskkill` puede devolver error
 * porque el proceso ya había muerto (o porque su padre se lo llevó por delante) y el
 * puerto queda libre igual. Mirar el código de salida daría un «no se pudo» falso.
 */
export const esperarLibre = async (puerto, intentos = 12) => {
  for (let intento = 0; intento < intentos; intento += 1) {
    if (!(await estaOcupado(puerto))) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
};

/**
 * ¿Este proceso es de los nuestros? Se comprueba **antes de matar nada**: si un
 * puerto de la lista lo ocupa un programa ajeno, se avisa y no se toca.
 */
export const esDeLaPila = (detalle, nombre) => {
  if (detalle === undefined) return nombre === 'node.exe' || nombre === 'node';
  const comando = detalle.comando.toLowerCase();
  return (
    comando.includes('odontocrm') ||
    comando.includes('services/') ||
    comando.includes('apps/gateway') ||
    comando.includes('vite')
  );
};

/**
 * Retrato de la pila ahora mismo: qué puertos están tomados, por quién y de qué
 * tipo es lo que está corriendo.
 *
 * Los modos: `dev` (procesos con `--watch`), `fijo` (procesos sueltos o de PM2, sin
 * recarga) y `mixta` cuando hay de los dos. `libre` cuando no hay nada.
 */
export const retratoDeLaPila = async () => {
  const ocupados = [];
  for (const entrada of PUERTOS) {
    if (await estaOcupado(entrada.puerto)) {
      ocupados.push({ ...entrada, pid: pidDelPuerto(entrada.puerto) });
    }
  }

  const detalles = detallesDeProcesos(ocupados.map((entrada) => entrada.pid));
  const registradas = aplicacionesPm2();
  const pm2 = registradas.filter((app) => app?.pm2_env?.status === 'online');
  const pidsPm2 = new Map(pm2.map((app) => [Number(app.pid), String(app.name ?? 'app')]));

  for (const entrada of ocupados) {
    const detalle = entrada.pid === null ? undefined : detalles.get(entrada.pid);
    const dePm2 = entrada.pid === null ? undefined : pidsPm2.get(entrada.pid);
    entrada.nombre = dePm2 === undefined ? nombreDeProceso(entrada.pid) : `PM2 · ${dePm2}`;
    entrada.pm2 = dePm2 ?? null;
    entrada.comando = detalle?.comando ?? '';
    entrada.desde = detalle?.desde ?? null;
    entrada.conWatch = entrada.comando.includes('--watch');
    entrada.nuestra = esDeLaPila(detalle, entrada.nombre);
  }

  /**
   * El modo lo deciden los **servicios** (4001-4008 y la puerta), no la interfaz:
   * Vite sirve igual en los dos modos y su línea de comandos nunca dice `--watch`.
   * Así, «dev» es una pila de servicios con recarga y «fijo» una sin ella.
   */
  const servicios = ocupados.filter((entrada) => entrada.puerto !== 5173);
  const hayWatch = servicios.some((entrada) => entrada.conWatch);
  const hayFijos = servicios.some((entrada) => !entrada.conWatch);
  const modo =
    servicios.length === 0
      ? ocupados.length === 0
        ? 'libre'
        : 'solo-web'
      : hayWatch && hayFijos
        ? 'mixta'
        : hayWatch
          ? 'dev'
          : 'fijo';

  return { ocupados, modo, aplicacionesPm2: pm2, aplicacionesRegistradas: registradas };
};

/** Hora legible y corta (solo la hora si es de hoy). */
export const cuando = (iso) => {
  if (iso === null) return 'sin dato';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return 'sin dato';
  const hoy = new Date();
  const mismoDia = fecha.toDateString() === hoy.toDateString();
  return mismoDia
    ? fecha.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
    : fecha.toLocaleString('es-VE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
};
