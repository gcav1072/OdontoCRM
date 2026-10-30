import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

import type { WhatsAppSessionState } from '@odontocrm/contracts';

import type { NotificationsDb } from '../../db/client.js';
import { whatsappSession } from '../../db/schema.js';

/**
 * Estado persistido de la sesión de WhatsApp (ADR 0073).
 *
 * El adaptador guarda aquí la máquina de estados, el número vinculado y el
 * contador del tope diario. El **estado Signal** (creds y claves) vive aparte,
 * en `whatsapp_auth` y cifrado; esta tabla solo tiene lo que se puede mostrar.
 */
export interface WhatsAppSessionStateSnapshot {
  sessionId: string;
  estado: WhatsAppSessionState;
  numero: string | null;
  nombre: string | null;
  vinculadoEn: Date | null;
  conectadoDesde: Date | null;
  ultimaDesconexion: Date | null;
  motivo: string | null;
  enviosHoy: number;
  enviosDia: string | null;
}

export interface WhatsAppSessionPatch {
  estado?: WhatsAppSessionState;
  numero?: string | null;
  nombre?: string | null;
  vinculadoEn?: Date | null;
  conectadoDesde?: Date | null;
  ultimaDesconexion?: Date | null;
  motivo?: string | null;
}

export interface WhatsAppSessionStore {
  load: () => Promise<WhatsAppSessionStateSnapshot | null>;
  save: (patch: WhatsAppSessionPatch) => Promise<void>;
  /**
   * Consume un envío del tope diario si queda cupo. Devuelve `true` si se
   * consumió; `false` si el día ya llegó al tope. El contador se reinicia solo
   * al cambiar el día del consultorio.
   */
  reservarEnvio: (now: Date, cap: number) => Promise<boolean>;
}

/** Día `AAAA-MM-DD` en la zona del consultorio (Venezuela, UTC−4). */
export const diaDelConsultorio = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(now);

/** Próxima medianoche del consultorio, para decir cuándo se libera el tope. */
export const siguienteMedianoche = (now: Date = new Date()): Date => {
  const hoy = diaDelConsultorio(now);
  const siguiente = new Date(new Date(`${hoy}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${siguiente}T00:00:00-04:00`);
};

const toSnapshot = (row: typeof whatsappSession.$inferSelect): WhatsAppSessionStateSnapshot => ({
  sessionId: row.sessionId,
  estado: row.estado as WhatsAppSessionState,
  numero: row.numero,
  nombre: row.nombre,
  vinculadoEn: row.vinculadoEn,
  conectadoDesde: row.conectadoDesde,
  ultimaDesconexion: row.ultimaDesconexion,
  motivo: row.motivo,
  enviosHoy: row.enviosHoy,
  enviosDia: row.enviosDia,
});

export const createWhatsAppSessionStore = (
  db: NotificationsDb,
  sessionId: string,
): WhatsAppSessionStore => ({
  load: async () => {
    const rows = await db
      .select()
      .from(whatsappSession)
      .where(eq(whatsappSession.sessionId, sessionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toSnapshot(row);
  },

  save: async (patch) => {
    const values = { ...patch, updatedAt: new Date() };
    await db
      .insert(whatsappSession)
      .values({ sessionId, ...values })
      .onConflictDoUpdate({
        target: whatsappSession.sessionId,
        set: values,
      });
  },

  reservarEnvio: async (now, cap) => {
    const dia = diaDelConsultorio(now);

    // La fila puede no existir antes del primer envío: se crea con el contador
    // ya consumido. El `onConflictDoNothing` deja intacta una sesión existente.
    const creada = await db
      .insert(whatsappSession)
      .values({ sessionId, enviosHoy: 1, enviosDia: dia, updatedAt: now })
      .onConflictDoNothing({ target: whatsappSession.sessionId })
      .returning({ id: whatsappSession.sessionId });
    if (creada.length > 0) return true;

    const actualizada = await db
      .update(whatsappSession)
      .set({
        enviosDia: dia,
        enviosHoy: sql`case when ${whatsappSession.enviosDia} is distinct from ${dia} then 1 else ${whatsappSession.enviosHoy} + 1 end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappSession.sessionId, sessionId),
          or(
            isNull(whatsappSession.enviosDia),
            ne(whatsappSession.enviosDia, dia),
            lt(whatsappSession.enviosHoy, cap),
          ),
        ),
      )
      .returning({ id: whatsappSession.sessionId });

    return actualizada.length > 0;
  },
});
