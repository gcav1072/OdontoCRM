import type { WhatsAppSessionStore } from './estado-store.js';
import { siguienteMedianoche } from './estado-store.js';

/**
 * Ritmo de los envíos de Baileys (D9), la mitigación anti-bloqueo que depende
 * del código: una cola **serial**, una espera aleatoria entre el mínimo y el
 * máximo configurados, «escribiendo…» proporcional al texto y un tope diario.
 *
 * El tope se persiste en `whatsapp_session`; si se alcanza o no hay conexión,
 * el aviso **se difiere sin gastar intentos** (lo hace la cola de envíos al
 * reconocer los errores de este módulo).
 */

export class CanalNoDisponibleError extends Error {
  readonly reintentarEn: Date;

  constructor(mensaje: string, reintentarEn: Date) {
    super(mensaje);
    this.name = 'CanalNoDisponibleError';
    this.reintentarEn = reintentarEn;
  }
}

export class CanalSaturadoError extends Error {
  readonly reintentarEn: Date;

  constructor(mensaje: string, reintentarEn: Date) {
    super(mensaje);
    this.name = 'CanalSaturadoError';
    this.reintentarEn = reintentarEn;
  }
}

export interface LimitadorOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  dailyCap: number;
  typing: boolean;
  store: WhatsAppSessionStore;
  /** `true` cuando el socket está abierto; si no, el aviso se difiere. */
  conectado: () => boolean;
  /** «escribiendo…» / «pausado»; un fallo aquí no puede tumbar el envío. */
  presencia?: (estado: 'composing' | 'paused') => Promise<void>;
  /** Inyectables para las pruebas con temporizadores falsos. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Espera base del «escribiendo…» (se suma al texto). */
  typingBaseMs?: number;
  typingPerCharMs?: number;
  typingMaxMs?: number;
  /** Cuánto se difiere un aviso si el socket no está conectado. */
  sinConexionReintentarMs?: number;
}

export interface Limitador {
  /**
   * Espera su turno, consume cupo y ejecuta el envío real. La presencia es por
   * envío (el JID cambia en cada uno); si se omite, se usa la de las opciones.
   */
  programar: <T>(
    texto: string,
    ejecutar: () => Promise<T>,
    presencia?: (estado: 'composing' | 'paused') => Promise<void>,
  ) => Promise<T>;
}

export const createLimitador = (options: LimitadorOptions): Limitador => {
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const typingBase = options.typingBaseMs ?? 700;
  const typingPerChar = options.typingPerCharMs ?? 20;
  const typingMax = options.typingMaxMs ?? 4_000;
  const sinConexionMs = options.sinConexionReintentarMs ?? 60_000;

  let ultimoEnvio: number | null = null;
  let cola: Promise<unknown> = Promise.resolve();

  const esperaAleatoria = (): number => {
    const min = Math.min(options.minIntervalMs, options.maxIntervalMs);
    const max = Math.max(options.minIntervalMs, options.maxIntervalMs);
    return Math.round(min + random() * (max - min));
  };

  const tarea = async <T>(
    texto: string,
    ejecutar: () => Promise<T>,
    presenciaPorEnvio?: (estado: 'composing' | 'paused') => Promise<void>,
  ): Promise<T> => {
    const presencia = presenciaPorEnvio ?? options.presencia;
    if (!options.conectado()) {
      throw new CanalNoDisponibleError(
        'WhatsApp no está conectado',
        new Date(now().getTime() + sinConexionMs),
      );
    }

    if (ultimoEnvio !== null) {
      const espera = ultimoEnvio + esperaAleatoria() - now().getTime();
      if (espera > 0) await sleep(espera);
    }

    const consumido = await options.store.reservarEnvio(now(), options.dailyCap);
    if (!consumido) {
      throw new CanalSaturadoError(
        `Se alcanzó el tope diario de ${String(options.dailyCap)} mensajes de WhatsApp`,
        siguienteMedianoche(now()),
      );
    }

    if (options.typing && presencia !== undefined) {
      await presencia('composing').catch(() => undefined);
      const pausa = Math.min(typingMax, typingBase + texto.length * typingPerChar);
      if (pausa > 0) await sleep(pausa);
    }

    try {
      const resultado = await ejecutar();
      return resultado;
    } finally {
      ultimoEnvio = now().getTime();
      if (options.typing && presencia !== undefined) {
        await presencia('paused').catch(() => undefined);
      }
    }
  };

  return {
    programar: <T>(
      texto: string,
      ejecutar: () => Promise<T>,
      presencia?: (estado: 'composing' | 'paused') => Promise<void>,
    ): Promise<T> => {
      const siguiente = cola.then(() => tarea(texto, ejecutar, presencia));
      // La cola sigue aunque una tarea falle: el error se propaga a quien
      // llamó, pero no bloquea los envíos siguientes.
      cola = siguiente.then(
        () => undefined,
        () => undefined,
      );
      return siguiente;
    },
  };
};
