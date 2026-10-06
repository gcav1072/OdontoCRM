/**
 * Revisa que los `.env` de los servicios tengan las claves que su plantilla
 * (`.env.example`) declara como esperadas.
 *
 * Existe por un caso real: un corte de luz dejó los ocho `.env` con el tamaño de
 * antes y **el contenido a ceros**; al rehacerlos, las claves que no gestiona
 * `db:bootstrap` —el `TELEGRAM_BOT_TOKEN`, entre ellas— se quedaron por el camino y
 * el bot pasó a **modo simulado** sin que nadie se enterara hasta que dejó de
 * contestar. Comparar el `.env` con su plantilla convierte ese silencio en un
 * aviso con nombre y apellido.
 *
 * Regla: **las líneas sin comentar de `.env.example` son las claves esperadas**
 * (las comentadas son opcionales, con su valor por defecto en `config.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './mantenimiento.mjs';

/** Servicios con `.env` propio (el de `billing` llega con la Fase 11). */
export const SERVICIOS = [
  'identity',
  'patients',
  'scheduling',
  'notifications',
  'clinical',
  'odontogram',
  'screens',
  'reporting',
  'billing',
];

/**
 * Qué se pierde cuando falta cada clave importante. El aviso tiene que servir para
 * algo: «falta TELEGRAM_BOT_TOKEN» sin decir qué implica obliga a ir a buscar el
 * código.
 */
const CONSECUENCIA = {
  DATABASE_URL: 'el servicio no arranca: no tiene base a la que conectarse',
  EVENTS_DATABASE_URL: 'el servicio arranca sin cola de eventos compartida',
  INTERNAL_SERVICE_SECRET: 'las llamadas internas entre servicios responden 401',
  COOKIE_SECRET: 'al reiniciar, las sesiones abiertas dejan de valer',
  TELEGRAM_BOT_TOKEN: 'el bot queda en MODO SIMULADO: los mensajes NO salen a Telegram',
  TELEGRAM_BOT_USERNAME: 'no se pueden armar los enlaces t.me/<bot>?start=… ni el QR',
};

/**
 * Claves declaradas en un archivo: **solo las líneas sin comentar** (`CLAVE=…`). Las
 * comentadas son documentación (la plantilla explica ahí las opcionales, y el propio
 * `.env` puede llevar una línea de ayuda del tipo `# TELEGRAM_BOT_TOKEN=`), así que no
 * cuentan como «puesta»: contarlas haría que el aviso no saltara nunca.
 */
const leerClaves = (ruta) => {
  if (!existsSync(ruta)) return null;
  const claves = [];
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const coincidencia = /^([A-Z][A-Z0-9_]*)=/.exec(linea);
    if (coincidencia?.[1] !== undefined) claves.push(coincidencia[1]);
  }
  return claves;
};

/**
 * Devuelve lo que falta, por servicio. `sinPlantilla` avisa de los servicios cuyo
 * `.env` existe pero no tiene plantilla (así se ve que hay que escribirla).
 */
export const revisarEntornos = () => {
  const faltantes = [];
  const sinPlantilla = [];
  const sinEnv = [];

  for (const servicio of SERVICIOS) {
    const env = join(ROOT, 'services', servicio, '.env');
    const ejemplo = join(ROOT, 'services', servicio, '.env.example');

    if (!existsSync(ejemplo)) {
      sinPlantilla.push(servicio);
      continue;
    }
    if (!existsSync(env)) {
      sinEnv.push(servicio);
      continue;
    }

    const esperadas = leerClaves(ejemplo) ?? [];
    const presentes = new Set(leerClaves(env) ?? []);
    const faltan = esperadas.filter((clave) => !presentes.has(clave));

    if (faltan.length > 0) faltantes.push({ servicio, archivo: env, claves: faltan });
  }

  return { faltantes, sinPlantilla, sinEnv, consecuencia: CONSECUENCIA };
};
