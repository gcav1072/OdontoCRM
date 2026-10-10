import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { ReportingDb } from './db/client.js';
import {
  dimDayCapacity,
  dimPatient,
  factAppointment,
  factClinicalSession,
  factPrescription,
  factPrescriptionItem,
  factRequest,
  factToothFinding,
  patientProfiles,
  processedEvents,
} from './db/schema.js';
import type { MaterializedView } from './db/views.js';
import { refreshMaterializedViews, type RefreshResult } from './refresh.js';

/** Transacción de Drizzle: lo que reciben los proyectores. */
type Tx = Parameters<Parameters<ReportingDb['transaction']>[0]>[0];

/** Columnas de `fact_appointment` que solo escribe una transición concreta. */
type ExtrasCita = Partial<
  Pick<
    typeof factAppointment.$inferInsert,
    'clinicalSessionId' | 'forceAttendedReason' | 'noShowReason' | 'cancelledChannel'
  >
>;

/**
 * Proyección de eventos → read model ([ADR 0019](../../../../docs/adr/0019-reportes-y-kpis.md)).
 *
 * **Por qué un read model y no consultas directas:** los reportes cruzan datos de
 * cuatro servicios (agenda, pacientes, clínica y odontograma). Leerlos en vivo
 * obligaría a `reporting` a hablar con las cuatro bases operativas en cada gráfica;
 * aquí se proyecta una vez lo que ya viajó por los eventos.
 *
 * **Trampas que este archivo resuelve a propósito** (todas encontradas leyendo a los
 * publicadores, no adivinando):
 *
 *  - el bloque `appointment` **no trae `patientId`**: el paciente se saca del aviso
 *    de la agenda (`notification.patientId`, que siempre viaja) o, si no, de la
 *    solicitud que originó la cita;
 *  - el tópico `odontogram.finding.recorded` también se publica al **imprimir** el
 *    odontograma (`action: 'odontogram_printed'`) y ese evento no trae pieza: se
 *    ignora;
 *  - `clinical.prescription.annulled|reprinted` **no traen bloque `prescription`**
 *    (solo la carga de auditoría con `entityId`), así que solo pueden actualizar una
 *    fila que ya exista;
 *  - `patient.updated` de un cambio de estado **no trae el bloque `patient`**: el
 *    sexo y la fecha de nacimiento se quedan como estaban y solo se mueve el estado,
 *    que viaja en `after.status`;
 *  - `scheduling.capacity.changed` también se publica al tocar una **plantilla de
 *    franjas**: solo interesa cuando `entityType === 'day_capacity'`.
 *
 * **Idempotencia:** cada evento se reclama en `processed_events` (`insert … on
 * conflict do nothing`) dentro de la **misma transacción** que la escritura. Si la
 * escritura falla, la reclamación se deshace y la cola reintenta; si el evento llega
 * dos veces, la segunda no escribe nada.
 */

/* ── Qué eventos le importan a este servicio ───────────────────────────────── */

export const REPORTING_TOPICS: readonly string[] = [
  EVENT_TOPICS.patientCreated,
  EVENT_TOPICS.patientUpdated,
  EVENT_TOPICS.patientDeleted,
  EVENT_TOPICS.requestCreated,
  EVENT_TOPICS.requestCancelled,
  EVENT_TOPICS.capacityChanged,
  EVENT_TOPICS.appointmentScheduled,
  EVENT_TOPICS.appointmentRescheduled,
  EVENT_TOPICS.appointmentCancelled,
  EVENT_TOPICS.appointmentNotified,
  EVENT_TOPICS.appointmentConfirmed,
  EVENT_TOPICS.appointmentCheckedIn,
  EVENT_TOPICS.appointmentCalled,
  EVENT_TOPICS.appointmentInConsultation,
  EVENT_TOPICS.appointmentAttended,
  EVENT_TOPICS.appointmentNoShow,
  EVENT_TOPICS.recordCreated,
  EVENT_TOPICS.recordUpdated,
  EVENT_TOPICS.recordSigned,
  EVENT_TOPICS.sessionCreated,
  EVENT_TOPICS.sessionClosed,
  EVENT_TOPICS.prescriptionIssued,
  EVENT_TOPICS.prescriptionAnnulled,
  EVENT_TOPICS.prescriptionReprinted,
  EVENT_TOPICS.toothFindingRecorded,
  EVENT_TOPICS.toothFindingRemoved,
  EVENT_TOPICS.messageSent,
  EVENT_TOPICS.messageFailed,
];

export type ConsumeState = 'aplicado' | 'duplicado' | 'ignorado';

export interface ConsumeResult {
  eventId: string;
  topic: string;
  estado: ConsumeState;
  /** Vistas materializadas que el evento pudo cambiar. */
  vistas: MaterializedView[];
  /** Por qué se ignoró: `fuera_de_alcance`, `carga_invalida`, `impresion`… */
  motivo: string | null;
}

export interface ReportingDeps {
  db: ReportingDb;
}

/* ── Validación de cargas ──────────────────────────────────────────────────── */

const uuid = z.uuid();
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Se esperaba una fecha aaaa-mm-dd');
const instante = z.iso.datetime({ offset: true });

const requestPayloadSchema = z.object({
  requestId: uuid,
  ticketNumber: z.number().int().nullish(),
  channel: z.string().nullish(),
  patientId: uuid.nullish(),
  reason: z.string().nullish(),
  requestedAt: instante.nullish(),
  after: z.object({ status: z.string().optional() }).partial().nullish(),
});

const appointmentPayloadSchema = z.object({
  appointment: z.object({
    id: uuid,
    date: fechaIso,
    startTime: z.string().min(4),
    endTime: z.string().min(4),
    status: z.string(),
    requestId: uuid.nullish(),
    rescheduledFromId: uuid.nullish(),
    /** Consultorio y odontólogo (con su etiqueta resuelta): los reportes los rotulan. */
    chairId: uuid.nullish(),
    chairLabel: z.string().nullish(),
    dentistId: uuid.nullish(),
    dentistName: z.string().nullish(),
  }),
  notification: z.object({ patientId: uuid }).partial().nullish(),
  previousAppointmentId: uuid.nullish(),
  after: z
    .object({
      status: z.string().optional(),
      clinicalSessionId: uuid.nullish(),
      forceAttendedReason: z.string().nullish(),
      /** Canal por el que canceló el paciente (ADR 0053); nulo si la canceló la secretaría. */
      cancelledChannel: z.string().nullish(),
    })
    .partial()
    .nullish(),
  reason: z.string().nullish(),
});

const capacityPayloadSchema = z.object({
  entityType: z.string(),
  date: fechaIso,
  capacity: z.number().int().min(0),
});

const patientBlockSchema = z.object({
  patientId: uuid,
  document: z.string().nullish(),
  fullName: z.string().nullish(),
  sex: z.string().nullish(),
  birthDate: fechaIso.nullish(),
  status: z.string().nullish(),
  isFictitious: z.boolean().nullish(),
});

const patientPayloadSchema = z.object({
  patientId: uuid,
  document: z.string().nullish(),
  fullName: z.string().nullish(),
  action: z.string().nullish(),
  after: z
    .object({ status: z.string().nullish(), deleted_at: z.string().nullish() })
    .partial()
    .nullish(),
  patient: patientBlockSchema.nullish(),
});

const profilePayloadSchema = z.object({
  profile: z.object({
    patientId: uuid,
    recordId: uuid,
    recordStatus: z.string(),
    alertCodes: z.array(z.string()),
  }),
});

const sessionPayloadSchema = z.object({
  session: z.object({
    sessionId: uuid,
    patientId: uuid,
    appointmentId: uuid.nullish(),
    sessionNumber: z.number().int(),
    status: z.string(),
    openedAt: instante.nullish(),
    closedAt: instante.nullish(),
    procedureCodes: z.array(z.string()).nullish(),
    procedureCount: z.number().int().nullish(),
  }),
  after: z.object({ diagnostico: z.string().nullish() }).partial().nullish(),
});

const prescriptionPayloadSchema = z.object({
  entityId: uuid.nullish(),
  prescription: z
    .object({
      id: uuid,
      number: z.string().nullish(),
      sessionId: uuid.nullish(),
      patientId: uuid,
      issuedAt: instante,
      medications: z.array(z.string()),
    })
    .nullish(),
  after: z.object({ printCount: z.number().int().nullish() }).partial().nullish(),
});

const findingPayloadSchema = z.object({
  action: z.string(),
  patientId: uuid,
  toothNumber: z.number().int(),
  condition: z.string(),
  surface: z.string().nullish(),
  state: z.string().nullish(),
  resolved: z.boolean().nullish(),
});

const notificationPayloadSchema = z.object({
  notificationId: uuid,
  patientId: uuid.nullish(),
  appointmentId: uuid.nullish(),
});

/* ── Planificación (validar antes de reclamar) ─────────────────────────────── */

type Planificacion =
  | { tipo: 'aplicar'; aplicar: (tx: Tx) => Promise<MaterializedView[]> }
  | { tipo: 'ignorar'; motivo: string };

const ignorar = (motivo: string): Planificacion => ({ tipo: 'ignorar', motivo });

const planificar = (event: DomainEvent): Planificacion => {
  switch (event.eventType) {
    case EVENT_TOPICS.requestCreated:
    case EVENT_TOPICS.requestCancelled:
      return planificarSolicitud(event);
    case EVENT_TOPICS.appointmentScheduled:
    case EVENT_TOPICS.appointmentRescheduled:
    case EVENT_TOPICS.appointmentCancelled:
    case EVENT_TOPICS.appointmentNotified:
    case EVENT_TOPICS.appointmentConfirmed:
    case EVENT_TOPICS.appointmentCheckedIn:
    case EVENT_TOPICS.appointmentCalled:
    case EVENT_TOPICS.appointmentInConsultation:
    case EVENT_TOPICS.appointmentAttended:
    case EVENT_TOPICS.appointmentNoShow:
      return planificarCita(event);
    case EVENT_TOPICS.capacityChanged:
      return planificarCupo(event);
    case EVENT_TOPICS.patientCreated:
    case EVENT_TOPICS.patientUpdated:
    case EVENT_TOPICS.patientDeleted:
      return planificarPaciente(event);
    case EVENT_TOPICS.recordCreated:
    case EVENT_TOPICS.recordUpdated:
    case EVENT_TOPICS.recordSigned:
      return planificarPerfilClinico(event);
    case EVENT_TOPICS.sessionCreated:
    case EVENT_TOPICS.sessionClosed:
      return planificarSesion(event);
    case EVENT_TOPICS.prescriptionIssued:
    case EVENT_TOPICS.prescriptionAnnulled:
    case EVENT_TOPICS.prescriptionReprinted:
      return planificarRecipe(event);
    case EVENT_TOPICS.toothFindingRecorded:
    case EVENT_TOPICS.toothFindingRemoved:
      return planificarHallazgo(event);
    case EVENT_TOPICS.messageSent:
    case EVENT_TOPICS.messageFailed:
      return planificarAviso(event);
    default:
      return ignorar('fuera_de_alcance');
  }
};

/* ── Utilidades de proyección ──────────────────────────────────────────────── */

const ocurridoDe = (event: DomainEvent): Date => new Date(event.occurredAt);

const fechaOpcional = (valor: string | null | undefined, porDefecto: Date | null): Date | null =>
  valor === null || valor === undefined ? porDefecto : new Date(valor);

/** `greatest(columna, instante)`: el «último evento aplicado» nunca retrocede. */
const masReciente = (columna: PgColumn, instanteEvento: Date): SQL =>
  sql`greatest(${columna}, ${instanteEvento})`;

/**
 * Quita las claves nulas de un objeto de actualización: en un `upsert` importa
 * distinguir «este evento no trae el dato» de «el dato es nulo». Pisar con `null` lo
 * que un evento anterior ya escribió sería perder información.
 *
 * El tipo devuelto es el del objeto **ya limpio** (sin `null`): una clave que quedó
 * fuera simplemente no viaja en el `set`, que es justo lo que se quiere.
 */
type Limpio<T> = { [K in keyof T]?: Exclude<T[K], null | undefined> };

const sinNulos = <T extends Record<string, unknown>>(valores: T): Limpio<T> =>
  Object.fromEntries(
    Object.entries(valores).filter(([, valor]) => valor !== null && valor !== undefined),
  ) as Limpio<T>;

const hayFilas = (filas: readonly unknown[]): boolean => filas.length > 0;

/** Violación de índice único (`23505`): otro lote insertó la fila a la vez. */
const esViolacionUnica = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === '23505';

const VISTAS_CITA: readonly MaterializedView[] = ['mv_daily_kpis', 'mv_funnel'];
const VISTAS_PACIENTE: readonly MaterializedView[] = ['mv_demographics'];
const VISTAS_AVISO: readonly MaterializedView[] = ['mv_daily_kpis'];
const VISTAS_RECETA: readonly MaterializedView[] = ['mv_daily_kpis', 'mv_prescriptions'];

interface SolicitudResumen {
  patientId: string | null;
  ticketNumber: number | null;
  requestedAt: Date | null;
  channel: string | null;
}

/** Datos de la solicitud que originó una cita (ticket, canal y a quién pertenece). */
const solicitudDe = async (tx: Tx, requestId: string): Promise<SolicitudResumen | null> => {
  const filas = await tx
    .select({
      patientId: factRequest.patientId,
      ticketNumber: factRequest.ticketNumber,
      requestedAt: factRequest.requestedAt,
      channel: factRequest.channel,
    })
    .from(factRequest)
    .where(eq(factRequest.requestId, requestId))
    .limit(1);
  return filas[0] ?? null;
};

/* ── Solicitudes ───────────────────────────────────────────────────────────── */

const planificarSolicitud = (event: DomainEvent): Planificacion => {
  const datos = requestPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const carga = datos.data;
  const ocurrido = ocurridoDe(event);
  const esAlta = event.eventType === EVENT_TOPICS.requestCreated;
  const solicitadaEn = fechaOpcional(carga.requestedAt, ocurrido) ?? ocurrido;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      if (esAlta) {
        await tx
          .insert(factRequest)
          .values({
            requestId: carga.requestId,
            ticketNumber: carga.ticketNumber ?? null,
            patientId: carga.patientId ?? null,
            channel: carga.channel ?? 'registro',
            status: 'en_espera_cita',
            reason: carga.reason ?? null,
            requestedAt: solicitadaEn,
            lastEventAt: ocurrido,
          })
          .onConflictDoUpdate({
            target: factRequest.requestId,
            set: {
              status: 'en_espera_cita',
              lastEventAt: masReciente(factRequest.lastEventAt, ocurrido),
              ...sinNulos({
                ticketNumber: carga.ticketNumber ?? null,
                patientId: carga.patientId ?? null,
                channel: carga.channel ?? null,
                reason: carga.reason ?? null,
                requestedAt: fechaOpcional(carga.requestedAt, null),
              }),
            },
          });
        return [...VISTAS_CITA];
      }

      // Cancelación: la fila la creó `request.created`. Si no existiera —una
      // solicitud anterior a este servicio— no hay nada que proyectar.
      const filas = await tx
        .update(factRequest)
        .set({
          status: 'cancelada',
          cancelledAt: ocurrido,
          lastEventAt: masReciente(factRequest.lastEventAt, ocurrido),
        })
        .where(eq(factRequest.requestId, carga.requestId))
        .returning({ requestId: factRequest.requestId });
      return hayFilas(filas) ? [...VISTAS_CITA] : [];
    },
  };
};

/* ── Citas ─────────────────────────────────────────────────────────────────── */

type MarcaTiempo =
  | 'scheduledAt'
  | 'notifiedAt'
  | 'confirmedAt'
  | 'checkedInAt'
  | 'calledAt'
  | 'startedAt'
  | 'finishedAt'
  | 'noShowAt'
  | 'cancelledAt';

/** Estado y sello de tiempo que deja cada transición de la máquina de estados. */
const TRANSICIONES_CITA: Readonly<Record<string, { estado: string; marca: MarcaTiempo }>> = {
  [EVENT_TOPICS.appointmentNotified]: { estado: 'notificada', marca: 'notifiedAt' },
  [EVENT_TOPICS.appointmentConfirmed]: { estado: 'confirmada', marca: 'confirmedAt' },
  [EVENT_TOPICS.appointmentCheckedIn]: { estado: 'en_sala_espera', marca: 'checkedInAt' },
  [EVENT_TOPICS.appointmentCalled]: { estado: 'llamado', marca: 'calledAt' },
  [EVENT_TOPICS.appointmentInConsultation]: { estado: 'en_consulta', marca: 'startedAt' },
  [EVENT_TOPICS.appointmentAttended]: { estado: 'atendido', marca: 'finishedAt' },
  [EVENT_TOPICS.appointmentNoShow]: { estado: 'no_asistio', marca: 'noShowAt' },
  [EVENT_TOPICS.appointmentCancelled]: { estado: 'cancelada', marca: 'cancelledAt' },
};

const planificarCita = (event: DomainEvent): Planificacion => {
  const datos = appointmentPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');

  const carga = datos.data;
  const esProgramacion =
    event.eventType === EVENT_TOPICS.appointmentScheduled ||
    event.eventType === EVENT_TOPICS.appointmentRescheduled;
  const transicion: { estado: string; marca: MarcaTiempo } | undefined = esProgramacion
    ? { estado: 'programada', marca: 'scheduledAt' }
    : TRANSICIONES_CITA[event.eventType];
  if (transicion === undefined) return ignorar('fuera_de_alcance');

  const ocurrido = ocurridoDe(event);
  const { appointment } = carga;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      const solicitud =
        appointment.requestId === null || appointment.requestId === undefined
          ? null
          : await solicitudDe(tx, appointment.requestId);
      const pacienteId = carga.notification?.patientId ?? solicitud?.patientId ?? null;
      const marca: Partial<Record<MarcaTiempo, Date>> = { [transicion.marca]: ocurrido };

      const extras: ExtrasCita = {};
      if (event.eventType === EVENT_TOPICS.appointmentAttended) {
        extras.clinicalSessionId = carga.after?.clinicalSessionId ?? null;
        extras.forceAttendedReason = carga.after?.forceAttendedReason ?? carga.reason ?? null;
      }
      if (event.eventType === EVENT_TOPICS.appointmentNoShow) {
        extras.noShowReason = carga.reason ?? null;
      }
      if (event.eventType === EVENT_TOPICS.appointmentCancelled) {
        // Por dónde se canceló: un canal de paciente (`telegram`/`whatsapp`) es lo que
        // distingue «la canceló el paciente» de «la canceló la secretaría» en el embudo.
        extras.cancelledChannel = carga.after?.cancelledChannel ?? null;
      }

      // 1) La transición. El `case` evita que un evento **viejo** (pg-boss no
      //    garantiza el orden entre lotes) devuelva la cita a un estado anterior.
      await tx
        .update(factAppointment)
        .set({
          status: sql`case when ${factAppointment.lastEventAt} <= ${ocurrido} then ${transicion.estado} else ${factAppointment.status} end`,
          ...marca,
          ...extras,
        })
        .where(eq(factAppointment.appointmentId, appointment.id));

      // 2) La fila existe (y se crea si el evento de programación se perdió).
      await tx
        .insert(factAppointment)
        .values({
          appointmentId: appointment.id,
          patientId: pacienteId,
          appointmentDate: appointment.date,
          startTime: appointment.startTime.slice(0, 5),
          endTime: appointment.endTime.slice(0, 5),
          status: transicion.estado,
          channel: solicitud?.channel ?? null,
          requestId: appointment.requestId ?? null,
          ticketNumber: solicitud?.ticketNumber ?? null,
          requestedAt: solicitud?.requestedAt ?? null,
          rescheduledFromId: appointment.rescheduledFromId ?? null,
          chairId: appointment.chairId ?? null,
          chairLabel: appointment.chairLabel ?? null,
          dentistId: appointment.dentistId ?? null,
          dentistName: appointment.dentistName ?? null,
          lastEventAt: ocurrido,
          ...marca,
          ...extras,
        })
        .onConflictDoUpdate({
          target: factAppointment.appointmentId,
          set: {
            appointmentDate: appointment.date,
            startTime: appointment.startTime.slice(0, 5),
            endTime: appointment.endTime.slice(0, 5),
            lastEventAt: masReciente(factAppointment.lastEventAt, ocurrido),
            ...sinNulos({
              patientId: pacienteId,
              channel: solicitud?.channel ?? null,
              requestId: appointment.requestId ?? null,
              rescheduledFromId: appointment.rescheduledFromId ?? null,
              ticketNumber: solicitud?.ticketNumber ?? null,
              requestedAt: solicitud?.requestedAt ?? null,
              chairId: appointment.chairId ?? null,
              chairLabel: appointment.chairLabel ?? null,
              dentistId: appointment.dentistId ?? null,
              dentistName: appointment.dentistName ?? null,
            }),
          },
        });

      // 3) Efectos colaterales de la transición, en el mismo evento.
      if (event.eventType === EVENT_TOPICS.appointmentRescheduled) {
        const anterior = carga.previousAppointmentId;
        if (anterior !== null && anterior !== undefined) {
          // La cita vieja queda `reprogramada`: libera su hueco y sale del cupo.
          await tx
            .update(factAppointment)
            .set({
              status: 'reprogramada',
              rescheduledAt: ocurrido,
              lastEventAt: masReciente(factAppointment.lastEventAt, ocurrido),
            })
            .where(eq(factAppointment.appointmentId, anterior));
        }
      }

      if (event.eventType === EVENT_TOPICS.appointmentCancelled) {
        const requestId = appointment.requestId;
        if (requestId !== null && requestId !== undefined) {
          // Cancelar la cita devuelve el ticket a la cola (lo hace la agenda): el
          // embudo tiene que verlo igual.
          await tx
            .update(factRequest)
            .set({
              status: 'en_espera_cita',
              cancelledAt: null,
              lastEventAt: masReciente(factRequest.lastEventAt, ocurrido),
            })
            .where(eq(factRequest.requestId, requestId));
        }
      }

      if (event.eventType === EVENT_TOPICS.appointmentAttended && pacienteId !== null) {
        await tx
          .update(dimPatient)
          .set({
            firstVisitAt: sql`coalesce(${dimPatient.firstVisitAt}, ${ocurrido})`,
            lastVisitAt: sql`greatest(coalesce(${dimPatient.lastVisitAt}, ${ocurrido}), ${ocurrido})`,
            updatedAt: new Date(),
          })
          .where(eq(dimPatient.patientId, pacienteId));
      }

      return [...VISTAS_CITA];
    },
  };
};

/* ── Cupos del día ─────────────────────────────────────────────────────────── */

const planificarCupo = (event: DomainEvent): Planificacion => {
  const datos = capacityPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  // El mismo tópico se publica al tocar una **plantilla de franjas**, que no es el
  // cupo de un día concreto: no hay nada que proyectar.
  if (datos.data.entityType !== 'day_capacity') return ignorar('plantilla_de_franjas');

  const carga = datos.data;
  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      await tx
        .insert(dimDayCapacity)
        .values({ date: carga.date, capacity: carga.capacity, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: dimDayCapacity.date,
          set: { capacity: carga.capacity, updatedAt: new Date() },
        });
      return ['mv_daily_kpis'];
    },
  };
};

/* ── Pacientes ─────────────────────────────────────────────────────────────── */

const planificarPaciente = (event: DomainEvent): Planificacion => {
  const datos = patientPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const carga = datos.data;
  const ocurrido = ocurridoDe(event);
  const bloque = carga.patient ?? null;
  const documento = bloque?.document ?? carga.document ?? '';
  const nombre = bloque?.fullName ?? carga.fullName ?? '';
  const esBorrado = event.eventType === EVENT_TOPICS.patientDeleted;
  const borradoEn = esBorrado ? fechaOpcional(carga.after?.deleted_at, ocurrido) : null;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      await tx
        .insert(dimPatient)
        .values({
          patientId: carga.patientId,
          document: documento,
          fullName: nombre,
          sex: bloque?.sex ?? null,
          birthDate: bloque?.birthDate ?? null,
          status: bloque?.status ?? carga.after?.status ?? 'en_espera_cita',
          isFictitious: bloque?.isFictitious ?? false,
          createdAt: ocurrido,
          deletedAt: borradoEn,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: dimPatient.patientId,
          // `created_at` no se toca: el alta se queda con la fecha del primer evento.
          set: {
            updatedAt: new Date(),
            ...sinNulos({
              document: documento === '' ? null : documento,
              fullName: nombre === '' ? null : nombre,
              sex: bloque?.sex ?? null,
              birthDate: bloque?.birthDate ?? null,
              status: bloque?.status ?? carga.after?.status ?? null,
            }),
          },
        });

      if (esBorrado) {
        // El borrado se marca aparte: `sinNulos` no distingue «no viene» de «viene
        // nulo» y aquí sí hay que poder escribir el `null` de una restauración.
        await tx
          .update(dimPatient)
          .set({ deletedAt: borradoEn, updatedAt: new Date() })
          .where(eq(dimPatient.patientId, carga.patientId));
      }

      // Si el perfil clínico llegó **antes** que el alta (dos servicios, dos
      // publicadores: el orden no está garantizado), se aplica ahora.
      await aplicarPerfilDiferido(tx, carga.patientId);

      return [...VISTAS_PACIENTE];
    },
  };
};

/* ── Perfil clínico (alertas de la historia) ───────────────────────────────── */

/**
 * Lleva el perfil clínico de paso (`patient_profiles`) a `dim_patient`.
 *
 * Se llama **después** de crear o actualizar un paciente y también al aplicar un
 * perfil nuevo, porque los dos flujos pueden llegar en cualquier orden: el alta
 * del paciente y el guardado de su anamnesis los publican dos servicios distintos.
 */
const aplicarPerfilDiferido = async (tx: Tx, patientId: string): Promise<void> => {
  await tx.execute(sql`
    update "dim_patient" as d
       set "profile_alerts" = p."alert_codes",
           "record_status" = p."record_status",
           "record_signed_at" = coalesce(d."record_signed_at", p."record_signed_at"),
           "updated_at" = now()
      from "patient_profiles" as p
     where p."patient_id" = d."patient_id"
       and d."patient_id" = ${patientId}
  `);
};

const planificarPerfilClinico = (event: DomainEvent): Planificacion => {
  const datos = profilePayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const perfil = datos.data.profile;
  const ocurrido = ocurridoDe(event);
  const firmada =
    perfil.recordStatus === 'firmada' || event.eventType === EVENT_TOPICS.recordSigned;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      // 1) El perfil se guarda **siempre** en su tabla de paso: así no se pierde
      //    aunque el alta del paciente llegue después (orden no garantizado entre
      //    los outbox de dos servicios; se midió en la prueba de humo).
      await tx
        .insert(patientProfiles)
        .values({
          patientId: perfil.patientId,
          alertCodes: perfil.alertCodes,
          recordStatus: perfil.recordStatus,
          recordSignedAt: firmada ? ocurrido : null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: patientProfiles.patientId,
          set: {
            alertCodes: perfil.alertCodes,
            recordStatus: perfil.recordStatus,
            updatedAt: new Date(),
            ...(firmada
              ? {
                  recordSignedAt: sql`coalesce(${patientProfiles.recordSignedAt}, ${ocurrido})`,
                }
              : {}),
          },
        });

      // 2) Y se aplica a la ficha si ya existe (el camino normal).
      await aplicarPerfilDiferido(tx, perfil.patientId);
      // Sin vista materializada que refrescar: el perfil clínico agregado se lee de
      // `dim_patient` (no hay un pre-agregado de alertas que mantener).
      return [];
    },
  };
};

/* ── Sesiones clínicas ─────────────────────────────────────────────────────── */

const planificarSesion = (event: DomainEvent): Planificacion => {
  const datos = sessionPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const sesion = datos.data.session;
  const diagnostico = datos.data.after?.diagnostico ?? null;
  const ocurrido = ocurridoDe(event);
  const abiertaEn = fechaOpcional(sesion.openedAt, ocurrido) ?? ocurrido;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      const procedimientos = sesion.procedureCodes ?? [];
      await tx
        .insert(factClinicalSession)
        .values({
          sessionId: sesion.sessionId,
          patientId: sesion.patientId,
          appointmentId: sesion.appointmentId ?? null,
          sessionNumber: sesion.sessionNumber,
          status: sesion.status,
          openedAt: abiertaEn,
          closedAt: fechaOpcional(sesion.closedAt, null),
          diagnosisText: diagnostico,
          procedureCodes: procedimientos,
          procedureCount: sesion.procedureCount ?? procedimientos.length,
          lastEventAt: ocurrido,
        })
        .onConflictDoUpdate({
          target: factClinicalSession.sessionId,
          set: {
            sessionNumber: sesion.sessionNumber,
            status: sesion.status,
            lastEventAt: masReciente(factClinicalSession.lastEventAt, ocurrido),
            ...sinNulos({
              appointmentId: sesion.appointmentId ?? null,
              openedAt: fechaOpcional(sesion.openedAt, null),
              closedAt: fechaOpcional(sesion.closedAt, null),
              diagnosisText: diagnostico,
            }),
            // La sesión se abre sin procedimientos y se cierran con ellos: solo se
            // escriben cuando el evento los trae (el `closed` los trae en código).
            ...(procedimientos.length === 0
              ? {}
              : {
                  procedureCodes: procedimientos,
                  procedureCount: sesion.procedureCount ?? procedimientos.length,
                }),
          },
        });

      if (sesion.appointmentId !== null && sesion.appointmentId !== undefined) {
        await tx
          .update(factAppointment)
          .set({ clinicalSessionId: sesion.sessionId })
          .where(eq(factAppointment.appointmentId, sesion.appointmentId));
      }

      await tx
        .update(dimPatient)
        .set({
          firstVisitAt: sql`coalesce(${dimPatient.firstVisitAt}, ${ocurrido})`,
          lastVisitAt: sql`greatest(coalesce(${dimPatient.lastVisitAt}, ${ocurrido}), ${ocurrido})`,
          updatedAt: new Date(),
        })
        .where(eq(dimPatient.patientId, sesion.patientId));

      return ['mv_daily_kpis'];
    },
  };
};

/* ── Récipes ───────────────────────────────────────────────────────────────── */

const planificarRecipe = (event: DomainEvent): Planificacion => {
  const datos = prescriptionPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const carga = datos.data;
  const ocurrido = ocurridoDe(event);

  // `issued` trae el bloque rico; `annulled` y `reprinted` solo el id en `entityId`.
  const recetaId = carga.prescription?.id ?? carga.entityId ?? null;
  if (recetaId === null) return ignorar('carga_invalida');

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      const receta = carga.prescription ?? null;

      if (event.eventType === EVENT_TOPICS.prescriptionIssued && receta !== null) {
        const emitidaEn = new Date(receta.issuedAt);
        await tx
          .insert(factPrescription)
          .values({
            prescriptionId: receta.id,
            number: receta.number ?? null,
            patientId: receta.patientId,
            sessionId: receta.sessionId ?? null,
            status: 'emitida',
            issuedAt: emitidaEn,
            itemCount: receta.medications.length,
            lastEventAt: ocurrido,
          })
          .onConflictDoUpdate({
            target: factPrescription.prescriptionId,
            set: {
              status: 'emitida',
              itemCount: receta.medications.length,
              lastEventAt: masReciente(factPrescription.lastEventAt, ocurrido),
              ...sinNulos({
                number: receta.number ?? null,
                patientId: receta.patientId,
                sessionId: receta.sessionId ?? null,
                issuedAt: emitidaEn,
              }),
            },
          });

        // Los renglones se rehacen enteros: así un `issued` reproyectado no duplica
        // medicamentos (los eventos ya procesados no vuelven, pero un reenvío manual
        // sí podría).
        await tx
          .delete(factPrescriptionItem)
          .where(eq(factPrescriptionItem.prescriptionId, receta.id));
        const medicamentos = receta.medications
          .map((medicamento) => medicamento.trim())
          .filter((medicamento) => medicamento !== '');
        if (medicamentos.length > 0) {
          await tx.insert(factPrescriptionItem).values(
            medicamentos.map((medicamento) => ({
              prescriptionId: receta.id,
              patientId: receta.patientId,
              medicationName: medicamento,
              issuedAt: emitidaEn,
            })),
          );
        }

        await tx
          .update(dimPatient)
          .set({
            firstVisitAt: sql`coalesce(${dimPatient.firstVisitAt}, ${emitidaEn})`,
            lastVisitAt: sql`greatest(coalesce(${dimPatient.lastVisitAt}, ${emitidaEn}), ${emitidaEn})`,
            updatedAt: new Date(),
          })
          .where(eq(dimPatient.patientId, receta.patientId));

        return [...VISTAS_RECETA];
      }

      if (event.eventType === EVENT_TOPICS.prescriptionAnnulled) {
        const filas = await tx
          .update(factPrescription)
          .set({
            status: 'anulada',
            annulledAt: ocurrido,
            lastEventAt: masReciente(factPrescription.lastEventAt, ocurrido),
          })
          .where(eq(factPrescription.prescriptionId, recetaId))
          .returning({ prescriptionId: factPrescription.prescriptionId });
        return hayFilas(filas) ? [...VISTAS_RECETA] : [];
      }

      // Reimpresión: solo el contador de copias (no cambia ningún KPI del día).
      const filas = await tx
        .update(factPrescription)
        .set({
          lastEventAt: masReciente(factPrescription.lastEventAt, ocurrido),
          ...sinNulos({ reprintCount: carga.after?.printCount ?? null }),
        })
        .where(eq(factPrescription.prescriptionId, recetaId))
        .returning({ prescriptionId: factPrescription.prescriptionId });
      return hayFilas(filas) ? ['mv_prescriptions'] : [];
    },
  };
};

/* ── Odontograma ───────────────────────────────────────────────────────────── */

const planificarHallazgo = (event: DomainEvent): Planificacion => {
  const datos = findingPayloadSchema.safeParse(event.payload);
  if (!datos.success) {
    // La impresión del odontograma se publica con el tópico de «registrado» pero sin
    // pieza: no es un hallazgo y se descarta sin ruido.
    const accion = event.payload['action'];
    return ignorar(
      accion === 'odontogram_printed' ? 'impresion_del_odontograma' : 'carga_invalida',
    );
  }

  const carga = datos.data;
  const ocurrido = ocurridoDe(event);
  const superficie = carga.surface ?? null;
  const condicion = carga.condition;
  const esSuperado = carga.resolved === true || carga.action === 'tooth_finding_superseded';

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      // Clave natural del hallazgo: la misma con la que el odontograma decide si ya
      // existe (pieza, cara y condición). Sin `coalesce`, la pieza completa —cara
      // nula— no colisionaría consigo misma.
      const clave = and(
        eq(factToothFinding.patientId, carga.patientId),
        eq(factToothFinding.toothNumber, carga.toothNumber),
        eq(factToothFinding.condition, condicion),
        superficie === null
          ? isNull(factToothFinding.surface)
          : eq(factToothFinding.surface, superficie),
      );

      if (event.eventType === EVENT_TOPICS.toothFindingRemoved) {
        const filas = esSuperado
          ? await tx
              .update(factToothFinding)
              .set({ resolvedAt: ocurrido, lastEventAt: ocurrido })
              .where(clave)
              .returning({ id: factToothFinding.id })
          : await tx.delete(factToothFinding).where(clave).returning({ id: factToothFinding.id });
        return hayFilas(filas) ? ['mv_oral_health'] : [];
      }

      // `tooth_finding_recorded` y `tooth_finding_updated` son el mismo upsert por
      // clave natural: el hallazgo ya existe y solo cambia de estado (o vuelve a
      // estar vigente).
      //
      // No se usa `on conflict do update` porque la clave natural incluye una
      // **expresión** (`coalesce(surface, '')`) y esta versión de Drizzle solo sabe
      // conflictuar contra columnas: el `target` se construye con los nombres de las
      // columnas y una expresión se colaría como si fuera una.
      const valores = {
        patientId: carga.patientId,
        toothNumber: carga.toothNumber,
        condition: condicion,
        surface: superficie,
        state: carga.state ?? null,
        recordedAt: ocurrido,
      };
      const actualizar = async (): Promise<boolean> =>
        hayFilas(
          await tx
            .update(factToothFinding)
            .set({
              state: valores.state,
              resolvedAt: null,
              lastEventAt: masReciente(factToothFinding.lastEventAt, ocurrido),
            })
            .where(clave)
            .returning({ id: factToothFinding.id }),
        );

      if (!(await actualizar())) {
        try {
          await tx
            .insert(factToothFinding)
            .values({ ...valores, resolvedAt: null, lastEventAt: ocurrido });
        } catch (error) {
          // Carrera con otro lote que insertó el mismo hallazgo: la clave natural ya
          // está, así que el reintento es la actualización.
          if (!esViolacionUnica(error)) throw error;
          await actualizar();
        }
      }

      return ['mv_oral_health'];
    },
  };
};

/* ── Avisos enviados (contadores del tablero) ──────────────────────────────── */

const planificarAviso = (event: DomainEvent): Planificacion => {
  const datos = notificationPayloadSchema.safeParse(event.payload);
  if (!datos.success) return ignorar('carga_invalida');
  const dia = event.occurredAt.slice(0, 10);
  const esEnvio = event.eventType === EVENT_TOPICS.messageSent;

  return {
    tipo: 'aplicar',
    aplicar: async (tx) => {
      // Los contadores viven en `dim_day_capacity` (el read model no tiene hechos de
      // notificaciones) y se suman en SQL para que dos lotes a la vez no se pisen.
      await tx
        .insert(dimDayCapacity)
        .values({
          date: dia,
          notificationsSent: esEnvio ? 1 : 0,
          notificationsFailed: esEnvio ? 0 : 1,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: dimDayCapacity.date,
          set: {
            updatedAt: new Date(),
            ...(esEnvio
              ? { notificationsSent: sql`${dimDayCapacity.notificationsSent} + 1` }
              : { notificationsFailed: sql`${dimDayCapacity.notificationsFailed} + 1` }),
          },
        });
      return [...VISTAS_AVISO];
    },
  };
};

/* ── Aplicación y lote ─────────────────────────────────────────────────────── */

/** Marca el evento como procesado. `false` = ya estaba (reintento de la cola). */
const claim = async (tx: Tx, event: DomainEvent): Promise<boolean> => {
  const marcador = await tx
    .insert(processedEvents)
    .values({ eventId: event.eventId, eventType: event.eventType, producer: event.producer })
    .onConflictDoNothing()
    .returning({ eventId: processedEvents.eventId });
  return marcador.length > 0;
};

/**
 * Aplica **un** evento. La reclamación y la escritura van en la misma transacción:
 * o queda todo (evento marcado y read model actualizado) o no queda nada y la cola
 * reintenta.
 */
export const applyDomainEvent = async (
  deps: ReportingDeps,
  event: DomainEvent,
): Promise<ConsumeResult> => {
  const base = { eventId: event.eventId, topic: event.eventType, vistas: [] as MaterializedView[] };
  const plan = planificar(event);

  if (plan.tipo === 'ignorar') {
    return { ...base, estado: 'ignorado', motivo: plan.motivo };
  }

  return deps.db.transaction(async (tx) => {
    if (!(await claim(tx, event))) {
      return { ...base, estado: 'duplicado', motivo: null };
    }
    const vistas = await plan.aplicar(tx);
    return { ...base, estado: 'aplicado', motivo: null, vistas };
  });
};

/** Ordena el lote por hora (y por id, para que sea estable), como hace `screens`. */
export const ordenarLote = (events: readonly DomainEvent[]): DomainEvent[] =>
  [...events].sort((izquierda, derecha) => {
    const porHora = izquierda.occurredAt.localeCompare(derecha.occurredAt);
    return porHora !== 0 ? porHora : izquierda.eventId.localeCompare(derecha.eventId);
  });

export interface BatchResult {
  resultados: ConsumeResult[];
  aplicados: number;
  duplicados: number;
  ignorados: number;
  refresh: RefreshResult | null;
}

/**
 * Aplica el lote completo y, **si algo cambió**, refresca las vistas materializadas
 * que esos eventos pudieron tocar (una vez por lote, no una por evento) y deja la
 * fila de traza en `report_refreshes`.
 */
export const handleDomainEvents = async (
  deps: ReportingDeps,
  events: readonly DomainEvent[],
): Promise<BatchResult> => {
  const resultados: ConsumeResult[] = [];
  const vistas = new Set<MaterializedView>();

  for (const event of ordenarLote(events)) {
    const resultado = await applyDomainEvent(deps, event);
    resultados.push(resultado);
    if (resultado.estado === 'aplicado') {
      for (const vista of resultado.vistas) vistas.add(vista);
    }
  }

  const refresh =
    vistas.size > 0
      ? await refreshMaterializedViews(deps.db, { views: [...vistas], trigger: 'evento' })
      : null;

  return {
    resultados,
    aplicados: resultados.filter((resultado) => resultado.estado === 'aplicado').length,
    duplicados: resultados.filter((resultado) => resultado.estado === 'duplicado').length,
    ignorados: resultados.filter((resultado) => resultado.estado === 'ignorado').length,
    refresh,
  };
};
