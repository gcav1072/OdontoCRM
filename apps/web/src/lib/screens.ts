import { abbreviateName, type CallEvent, type CriticalFlag } from '@odontocrm/contracts';

import { formatTime } from './format';
import type { KioskKind } from './kiosko';

/**
 * Piezas puras de las pantallas de la Fase 5: claves de consulta, orden de los
 * datos críticos y el enlace del kiosko. Lo que se puede calcular sin React vive
 * aquí para poder probarlo.
 */

export const screenKeys = {
  /** Pantallas registradas (administración). */
  devices: ['pantallas', 'dispositivos'] as const,
  /** Cuántas pantallas están conectadas en vivo. */
  conectadas: ['pantallas', 'conectadas'] as const,
  /** Ficha de la pantalla kiosko que está abierta (con sus ajustes). */
  dispositivo: ['pantallas', 'dispositivo'] as const,
  /** Estado de la sala de espera. */
  lobby: ['pantallas', 'lobby'] as const,
  /** Paciente en el consultorio. */
  consultorio: ['pantallas', 'consultorio'] as const,
};

/** Refresco del estado mientras la pantalla está abierta (por si el SSE cae). */
export const SCREEN_REFRESH_MS = 20_000;

/**
 * Enlace para configurar una pantalla en su equipo. Lleva el token en la
 * consulta porque el kiosko no tiene sesión: al abrirlo, la pantalla lo guarda y
 * lo borra de la barra de direcciones.
 */
export const kioskUrl = (kind: KioskKind, token: string): string =>
  `${window.location.origin}/pantalla/${kind}?token=${encodeURIComponent(token)}`;

/** Orden de gravedad de los datos críticos: primero lo que mata. */
const SEVERIDAD_ORDEN: Readonly<Record<CriticalFlag['severidad'], number>> = {
  alto: 0,
  medio: 1,
  info: 2,
};

export const ordenarCriticos = (flags: readonly CriticalFlag[]): CriticalFlag[] =>
  [...flags].sort(
    (izquierda, derecha) =>
      SEVERIDAD_ORDEN[izquierda.severidad] - SEVERIDAD_ORDEN[derecha.severidad],
  );

/** Etiqueta legible del turno: `#000123` o `—` si la cita no tenía solicitud. */
export const turnoLabel = (call: CallEvent): string => call.ticket ?? '—';

/** Hora del llamado, en 12 h (formato de la clínica). */
export const horaLabel = (iso: string): string => formatTime(iso);

/**
 * ¿El llamado sigue dentro de su ventana de resalte? El displaylobby lo usa para
 * animar el nombre y decidir si el 2.º llamado se pinta en rojo.
 */
export const llamadoVigente = (
  call: CallEvent,
  resalteSegundos: number,
  ahora: number = Date.now(),
): boolean => ahora - new Date(call.calledAt).getTime() < resalteSegundos * 1000;

export { abbreviateName };
