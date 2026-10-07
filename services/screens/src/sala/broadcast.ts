import {
  STAFF_CHANNEL,
  formatSseFrame,
  type ConsultationState,
  type LobbyState,
  type ScreenStreamEvent,
  type StaffSignal,
} from '@odontocrm/contracts';

/**
 * Canal de un flujo SSE. El nombre **es** el del evento que viaja en la trama: quien se
 * suscribe a `lobby` solo recibe las tramas `lobby`, y así un mismo servidor sostiene el
 * canal de las pantallas kiosko y el del personal sin que se mezclen.
 */
export type ScreenChannel = Extract<ScreenStreamEvent, 'lobby' | 'consultorio' | 'staff'>;

/** Lo que se puede repartir por un canal: estado de sala, de consultorio o un aviso. */
export type ChannelPayload = LobbyState | ConsultationState | StaffSignal;

/** Quién está mirando: la sala de espera o el consultorio (las pantallas kiosko). */
export type PantallaKind = Extract<ScreenChannel, 'lobby' | 'consultorio'>;

interface Suscriptor {
  canal: ScreenChannel;
  enviar: (trama: string) => void;
}

/**
 * Reparto por **SSE** en el mismo proceso.
 *
 * Hay dos clases de suscriptor y las dos caben aquí:
 *
 *  - las **pantallas kiosko** (`lobby`, `consultorio`) reciben el **estado completo** cada
 *    vez que la sala cambia —un llamado, un check-in, alguien que pasa al consultorio—,
 *    de modo que el cliente solo reemplaza lo que pinta y una reconexión no necesita
 *    reproducir eventos;
 *  - el **personal** (`staff`, recepción y caja) recibe **avisos** de qué cambió para
 *    volver a pedir los datos: tienen la pantalla llena de información y solo les falta
 *    enterarse de que algo la dejó vieja.
 *
 * El `id` de cada trama permite rastrear el último estado recibido y el keepalive evita
 * que el proxy cierre la conexión inactiva.
 */
export const createScreenBroadcaster = () => {
  const suscriptores = new Set<Suscriptor>();
  let secuencia = 0;

  return {
    /** Devuelve la función para darse de baja (al cerrar la conexión). */
    suscribir: (canal: ScreenChannel, enviar: (trama: string) => void): (() => void) => {
      const suscriptor: Suscriptor = { canal, enviar };
      suscriptores.add(suscriptor);
      return () => {
        suscriptores.delete(suscriptor);
      };
    },

    /** Cuántas pantallas están conectadas (lo usa la administración). */
    conectadas: (canal?: ScreenChannel): number =>
      [...suscriptores].filter((suscriptor) => canal === undefined || suscriptor.canal === canal)
        .length,

    /** Manda un estado (o un aviso) a todos los suscriptores de ese canal. */
    publicar: (canal: ScreenChannel, datos: ChannelPayload): number => {
      secuencia += 1;
      const trama = formatSseFrame({
        id: `${canal}-${String(Date.now())}-${String(secuencia)}`,
        evento: canal,
        datos,
      });

      let enviados = 0;
      for (const suscriptor of [...suscriptores]) {
        if (suscriptor.canal !== canal) continue;
        try {
          suscriptor.enviar(trama);
          enviados += 1;
        } catch {
          // Un cliente que se cayó a mitad de escritura se descarta.
          suscriptores.delete(suscriptor);
        }
      }
      return enviados;
    },
  };
};

export type ScreenBroadcaster = ReturnType<typeof createScreenBroadcaster>;

/** El canal del personal, para no repetir el literal por el servicio. */
export const STAFF = STAFF_CHANNEL;
