import type { PatientChannel } from '@odontocrm/contracts';

import type { NotificationsDb } from './db/client.js';
import type { InternalClients } from './internal-client.js';
import { listChannels, maskDireccion } from './messaging.js';

/**
 * Los **canales vinculados** de la bandeja (`/notificaciones`), con el nombre del
 * paciente resuelto.
 *
 * El nombre vive en el servicio de pacientes, no aquí, así que se compone **en el
 * servicio** —como hace `appointmentsInInbox` con las citas—: cruzar dos consultas
 * con una paginación que no encaja sería peor en el navegador. Se resuelve en un
 * **solo lote** por identificador, así que el coste no depende del número de filas.
 *
 * El nombre es informativo: si el servicio de pacientes no responde, las filas salen
 * con `patientName: null` en vez de romper la pantalla (y la interfaz ya sabe mostrar
 * «Sin dato»).
 */
export const channelsInInbox = async (
  db: NotificationsDb,
  clients: InternalClients,
  patientId?: string,
): Promise<{ items: PatientChannel[]; total: number }> => {
  const canales = await listChannels(db, patientId);

  const ids = [...new Set(canales.map((canal) => canal.patientId))];
  const nombres = new Map<string, string>();
  if (ids.length > 0) {
    const resumenes = await clients.listPatientSummaries(ids).catch(() => []);
    for (const resumen of resumenes) nombres.set(resumen.id, resumen.fullName);
  }

  const items: PatientChannel[] = canales.map((canal) => ({
    patientId: canal.patientId,
    patientName: nombres.get(canal.patientId) ?? null,
    channel: canal.canal,
    direccionMasked: maskDireccion(canal.direccion),
    usuario: canal.usuario,
    linkedAt: canal.linkedAt.toISOString(),
    isBlocked: canal.isBlocked,
  }));

  return { items, total: items.length };
};
