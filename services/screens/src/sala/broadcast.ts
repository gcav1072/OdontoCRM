import {
  formatSseFrame,
  type ConsultationState,
  type LobbyState,
  type ScreenStreamEvent,
} from '@odontocrm/contracts';

/** Quién está mirando: la sala de espera o el consultorio. */
export type PantallaKind = Extract<ScreenStreamEvent, 'lobby' | 'consultorio'>;

interface Suscriptor {
  kind: PantallaKind;
  enviar: (trama: string) => void;
}

/**
 * Reparto de estado por **SSE** en el mismo proceso.
 *
 * Cuando la sala cambia (un llamado, un check-in, alguien que pasa al
 * consultorio), el servicio manda a cada pantalla conectada el estado completo:
 * el cliente solo reemplaza lo que pinta, así que una reconexión no necesita
 * reproducir eventos. El `id` de cada trama permite rastrear el último estado
 * recibido y el keepalive evita que el proxy cierre la conexión inactiva.
 */
export const createScreenBroadcaster = () => {
  const suscriptores = new Set<Suscriptor>();
  let secuencia = 0;

  return {
    /** Devuelve la función para darse de baja (al cerrar la conexión). */
    suscribir: (kind: PantallaKind, enviar: (trama: string) => void): (() => void) => {
      const suscriptor: Suscriptor = { kind, enviar };
      suscriptores.add(suscriptor);
      return () => {
        suscriptores.delete(suscriptor);
      };
    },

    /** Cuántas pantallas están conectadas (lo usa la administración). */
    conectadas: (kind?: PantallaKind): number =>
      [...suscriptores].filter((suscriptor) => kind === undefined || suscriptor.kind === kind)
        .length,

    /** Manda el estado a todas las pantallas de ese tipo. */
    publicar: (kind: PantallaKind, datos: LobbyState | ConsultationState): number => {
      secuencia += 1;
      const trama = formatSseFrame({
        id: `${kind}-${String(Date.now())}-${String(secuencia)}`,
        evento: kind,
        datos,
      });

      let enviados = 0;
      for (const suscriptor of [...suscriptores]) {
        if (suscriptor.kind !== kind) continue;
        try {
          suscriptor.enviar(trama);
          enviados += 1;
        } catch {
          // Una pantalla que se cayó a mitad de escritura se descarta.
          suscriptores.delete(suscriptor);
        }
      }
      return enviados;
    },
  };
};

export type ScreenBroadcaster = ReturnType<typeof createScreenBroadcaster>;
