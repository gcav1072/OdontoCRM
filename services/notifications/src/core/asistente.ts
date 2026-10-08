import {
  BOT_CONFIRM_WINDOW_DAYS,
  BOT_STEP_LABELS,
  CANCELLABLE_STATUSES,
  CHANNEL_LABELS,
  botDraftSchema,
  cleanText,
  detectIntent,
  formatTicket,
  formatTime12h,
  isMinor,
  maskDocument,
  normalizeBotName,
  normalizeDocNumber,
  normalizePhone,
  parseBotDate,
  parseTicket,
  resolveNumberedOption,
  validateDocument,
  type AppointmentStatus,
  type AppointmentSummary,
  type BotDraft,
  type ChannelId,
  type DocType,
  type InboundMessage,
  type OutboundButton,
  type RequestSummary,
} from '@odontocrm/contracts';
import { botCommandsAsText } from '@odontocrm/contracts';
import { and, eq, gt } from 'drizzle-orm';

import { sendAdapted, type AdapterRegistry } from '../canales/adaptador.js';
import type { NotificationsConfig } from '../config.js';
import type { NotificationsDb } from '../db/client.js';
import {
  botConversations,
  patientChannels,
  processedUpdates,
  type BotConversationRow,
} from '../db/schema.js';
import type { InternalClients } from '../internal-client.js';
import { channelByDireccion, linkChat, renderMessageFor, todayInClinic } from '../messaging.js';

export interface AsistenteServices {
  db: NotificationsDb;
  config: NotificationsConfig;
  /** Adaptadores registrados: el núcleo no conoce Telegram ni WhatsApp (ADR 0029). */
  canales: AdapterRegistry;
  clients: InternalClients;
}

/** Identidad de la conversación: el canal y la dirección del interlocutor. */
export interface Conversacion {
  canal: ChannelId;
  direccion: string;
}

export interface InboundOutcome {
  canal: ChannelId;
  direccion: string;
  handled: boolean;
  action?: string;
}

const STATE_LABEL: Readonly<Record<string, string>> = {
  ...BOT_STEP_LABELS,
  inicio: 'Inicio',
  representante: 'Representante',
  esperando_confirmacion: 'Confirmación',
  listo: 'Listo',
};

export const stateLabel = (state: string): string => STATE_LABEL[state] ?? state;

const emptyDraft = (): BotDraft => botDraftSchema.parse({});

const toDraft = (row: BotConversationRow): BotDraft => botDraftSchema.parse(row.draft);

/** Paciente ya registrado: lo mínimo para reutilizar sus datos (caso duplicado). */
interface PatientLike {
  id: string;
  fullName: string;
  docType: string;
  docNumber: string;
  phone: string;
  birthDate: string;
  sex: string;
}

/** Documento con los datos del paciente ya registrado (para el caso duplicado). */
const draftFromPatient = (patient: PatientLike): BotDraft =>
  botDraftSchema.parse({
    fullName: patient.fullName,
    docType: patient.docType,
    docNumber: patient.docNumber,
    phone: patient.phone,
    birthDate: patient.birthDate,
    sex: patient.sex,
  });

/* ── Conversación ──────────────────────────────────────────────────────────── */

export const loadConversation = async (
  db: NotificationsDb,
  canal: ChannelId,
  direccion: string,
  usuario: string | null,
): Promise<BotConversationRow> => {
  const rows = await db
    .select()
    .from(botConversations)
    .where(and(eq(botConversations.canal, canal), eq(botConversations.direccion, direccion)))
    .limit(1);
  const existing = rows[0];
  if (existing !== undefined) {
    // El canal puede empezar sin nombre de usuario y mandarlo después.
    if (existing.usuario === null && usuario !== null) {
      await db
        .update(botConversations)
        .set({ usuario, updatedAt: new Date() })
        .where(and(eq(botConversations.canal, canal), eq(botConversations.direccion, direccion)));
      return { ...existing, usuario };
    }
    return existing;
  }

  const inserted = await db
    .insert(botConversations)
    .values({ canal, direccion, state: 'inicio', draft: {}, usuario })
    .onConflictDoNothing({ target: [botConversations.canal, botConversations.direccion] })
    .returning();

  const created = inserted[0];
  if (created !== undefined) return created;

  const again = await db
    .select()
    .from(botConversations)
    .where(and(eq(botConversations.canal, canal), eq(botConversations.direccion, direccion)))
    .limit(1);
  if (again[0] === undefined) throw new Error('No se pudo cargar la conversación');
  return again[0];
};

const saveConversation = async (
  db: NotificationsDb,
  conversacion: Conversacion,
  patch: {
    state?: string;
    draft?: BotDraft;
    patientId?: string | null;
    lastTicket?: number | null;
    opciones?: Record<string, string>;
  },
): Promise<void> => {
  await db
    .update(botConversations)
    .set({
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.draft === undefined ? {} : { draft: patch.draft }),
      ...(patch.patientId === undefined ? {} : { patientId: patch.patientId }),
      ...(patch.lastTicket === undefined ? {} : { lastTicket: patch.lastTicket }),
      ...(patch.opciones === undefined ? {} : { opciones: patch.opciones }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(botConversations.canal, conversacion.canal),
        eq(botConversations.direccion, conversacion.direccion),
      ),
    );
};

/** Anti-flood: devuelve `true` si hay que ignorar el mensaje. */
export const isFlooding = async (
  services: AsistenteServices,
  conversation: BotConversationRow,
): Promise<boolean> => {
  const now = new Date();
  const windowMs = services.config.ANTI_FLOOD_WINDOW_SECONDS * 1000;
  const started = conversation.windowStartedAt.getTime();
  const withinWindow = now.getTime() - started < windowMs;

  const count = withinWindow ? conversation.messageCount + 1 : 1;
  const windowStartedAt = withinWindow ? conversation.windowStartedAt : now;

  await services.db
    .update(botConversations)
    .set({ messageCount: count, windowStartedAt, updatedAt: now })
    .where(
      and(
        eq(botConversations.canal, conversation.canal),
        eq(botConversations.direccion, conversation.direccion),
      ),
    );

  return count > services.config.ANTI_FLOOD_MAX_MESSAGES;
};

/* ── Respuestas ────────────────────────────────────────────────────────────── */

/**
 * Manda un mensaje por el adaptador del canal, adaptándose a sus capacidades:
 * si no tiene botones, las opciones van **numeradas** dentro del texto y se
 * guardan en la conversación para entender el «2» que responda el paciente.
 */
const enviar = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  texto: string,
  botones?: readonly OutboundButton[],
): Promise<string | null> => {
  const adapter = services.canales.get(conversacion.canal);
  if (adapter === null) return null;

  const { resultado, opciones } = await sendAdapted(adapter, {
    direccion: conversacion.direccion,
    texto,
    ...(botones === undefined ? {} : { botones }),
  });

  await saveConversation(services.db, conversacion, { opciones: Object.fromEntries(opciones) });
  return resultado.idMensaje;
};

const reply = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  key: string,
  values: Readonly<Record<string, string | null>> = {},
  botones?: readonly OutboundButton[],
  opciones: { conMenu?: boolean } = {},
): Promise<void> => {
  const texto = await renderMessageFor(services.db, key, {
    clinica: services.config.CLINIC_NAME,
    lugar: services.config.CLINIC_ADDRESS,
    ...values,
  });

  // La ayuda termina con el menú de comandos, generado del catálogo del contrato:
  // así quien no descubra el menú de Telegram (o use WhatsApp, que no lo tiene) ve
  // igualmente lo que el asistente sabe hacer, y la lista no se queda desfasada.
  const capacidades = services.canales.get(conversacion.canal)?.capacidades;
  const conMenu = opciones.conMenu === true && capacidades?.comandos === true;
  await enviar(
    services,
    conversacion,
    conMenu ? `${texto}\n\n${botCommandsAsText()}` : texto,
    botones,
  );
};

const DOC_TYPE_EXAMPLE: Readonly<Record<DocType, string>> = {
  V: '12345678',
  E: '12345678',
  P: 'A123456',
  SC: '0042',
};

/** Botones de un paso: el núcleo los da; el canal decide si los manda o los numera. */
const stepButtons = (
  step: 'nombre' | 'documento' | 'telefono' | 'nacimiento' | 'sexo' | 'motivo',
) =>
  step === 'documento'
    ? (['V', 'E', 'P', 'SC'] as const).map((type) => ({
        etiqueta: type,
        accion: `doc:${type}`,
      }))
    : step === 'sexo'
      ? [
          { etiqueta: 'M', accion: 'sexo:M' },
          { etiqueta: 'F', accion: 'sexo:F' },
          { etiqueta: 'O', accion: 'sexo:O' },
        ]
      : undefined;

const askStep = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  step: 'nombre' | 'documento' | 'telefono' | 'nacimiento' | 'sexo' | 'motivo',
  values: Readonly<Record<string, string | null>> = {},
): Promise<void> => {
  await reply(services, conversacion, `pedir_${step}`, values, stepButtons(step));
};

const summaryOf = (draft: BotDraft): string => {
  const lines = [
    `Nombre: ${draft.fullName ?? '—'}`,
    `Documento: ${draft.docType ?? ''}-${draft.docNumber ?? ''}`,
    `Teléfono: ${draft.phone ?? '—'}`,
    `Fecha de nacimiento: ${draft.birthDate === null ? '—' : draft.birthDate.split('-').reverse().join('/')}`,
    `Sexo: ${draft.sex ?? '—'}`,
    `Motivo: ${draft.reason ?? '—'}`,
  ];
  if (draft.guardianName !== null) {
    lines.push(`Representante: ${draft.guardianName}`);
  }
  return lines.join('\n');
};

const DOC_TYPE_LABEL: Readonly<Record<DocType, string>> = {
  V: 'Venezolano',
  E: 'Extranjero',
  P: 'Pasaporte',
  SC: 'Menor sin cédula',
};

/* ── Estados de la cita ────────────────────────────────────────────────────── */

const estadoDe = (status: AppointmentStatus): string => {
  const labels: Partial<Record<AppointmentStatus, string>> = {
    en_espera_cita: 'EN ESPERA DE CITA',
    programada: 'PROGRAMADA',
    // «Avisada» y «confirmada» son dos hechos distintos (ADR 0052): antes de este
    // cambio, `notificada` se rotulaba «CONFIRMADA Y AVISADA», que era falso.
    notificada: 'AVISADA',
    confirmada: 'CONFIRMADA POR EL PACIENTE',
    en_sala_espera: 'EN SALA DE ESPERA',
    llamado: 'LLAMADO',
    en_consulta: 'EN CONSULTA',
    atendido: 'ATENDIDO',
    no_asistio: 'NO ASISTIÓ',
    cancelada: 'CANCELADA',
    reprogramada: 'REPROGRAMADA',
  };
  return labels[status] ?? status;
};

const describeRequest = (request: RequestSummary): string =>
  request.appointmentDate === null
    ? 'Todavía estamos buscándole fecha y hora; te avisaremos por aquí.'
    : `Tu cita es el ${request.appointmentDate.split('-').reverse().join('/')} a las ${request.appointmentTime ?? ''}.`;

const showStatus = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  ticket: string | null,
): Promise<void> => {
  const parsed = ticket === null ? null : parseTicket(ticket);
  if (parsed === null) {
    await reply(services, conversacion, 'sin_solicitud');
    return;
  }

  const found = await services.clients.findRequestByTicket(parsed.value);
  if (found === null) {
    await reply(services, conversacion, 'sin_solicitud');
    return;
  }

  await reply(services, conversacion, 'estado_solicitud', {
    ticket: found.ticket,
    estado: estadoDe(found.status),
    cita: describeRequest(found),
  });
};

const cancelRequest = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  ticket: string | null,
): Promise<void> => {
  const parsed = ticket === null ? null : parseTicket(ticket);
  const found = parsed === null ? null : await services.clients.findRequestByTicket(parsed.value);

  if (found === null) {
    await reply(services, conversacion, 'sin_solicitud');
    return;
  }

  if (found.status === 'cancelada') {
    await reply(services, conversacion, 'estado_solicitud', {
      ticket: found.ticket,
      estado: estadoDe(found.status),
      cita: 'Ya estaba anulada.',
    });
    return;
  }

  if (found.status !== 'en_espera_cita') {
    await reply(services, conversacion, 'estado_solicitud', {
      ticket: found.ticket,
      estado: estadoDe(found.status),
      cita: 'Esta solicitud ya tiene cita asignada: llama al consultorio para cambiarla.',
    });
    return;
  }

  const cancelled = await services.clients.cancelRequest(
    found.id,
    `el paciente la anuló por ${CHANNEL_LABELS[conversacion.canal]}`,
  );
  await reply(services, conversacion, 'estado_solicitud', {
    ticket: cancelled.ticket,
    estado: estadoDe(cancelled.status),
    cita: 'Tu solicitud quedó anulada. Cuando quieras otra, escríbeme «nueva».',
  });
};

/* ── Pasos del asistente ───────────────────────────────────────────────────── */

/* ── Confirmar la cita (ADR 0052) ──────────────────────────────────────────── */

/** Fecha `AAAA-MM-DD` como `dd/mm/aaaa`, que es como se lee y se dicta aquí. */
const fechaVe = (date: string): string => date.split('-').reverse().join('/');

/**
 * Ventana de citas que el asistente mira para confirmar o cancelar: de hoy a 60 días
 * (`BOT_CONFIRM_WINDOW_DAYS`). Sin tope, un paciente con muchas citas recibiría una
 * lista interminable de opciones.
 */
const ventanaDeCitas = (now: Date = new Date()): { from: string; to: string } => {
  const from = todayInClinic(now);
  const tope = new Date(
    new Date(`${from}T00:00:00Z`).getTime() + BOT_CONFIRM_WINDOW_DAYS * 86_400_000,
  );
  return { from, to: tope.toISOString().slice(0, 10) };
};

const responderConfirmada = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
): Promise<void> => {
  await reply(services, conversacion, 'cita_confirmada_paciente', {
    paciente: cita.patientName,
    fecha: fechaVe(cita.date),
    hora: formatTime12h(cita.startTime),
    lugar: services.config.CLINIC_ADDRESS,
  });
};

/** Confirma de verdad y responde. Devuelve `false` si la cita ya estaba confirmada. */
const confirmarYResponder = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
): Promise<boolean> => {
  if (cita.status === 'confirmada') {
    // Volver a confirmar no es un error: se le recuerda lo que ya dijo.
    await responderConfirmada(services, conversacion, cita);
    return false;
  }

  const confirmada = await services.clients.confirmAppointment(cita.id, {
    channel: conversacion.canal,
    note: null,
  });
  await responderConfirmada(services, conversacion, confirmada);
  return true;
};

export type ResultadoConfirmar = 'confirmada' | 'ya_estaba' | 'elegir' | 'sin_citas' | 'no_es_suya';

/**
 * El paciente dice que sí. Es la mitad conversacional de la confirmación (ADR 0052):
 * el asistente busca **sus** citas próximas y confirma la que corresponda.
 *
 * Reglas:
 *  - si viene un `id` (de un botón o de una opción numerada), se comprueba que esa
 *    cita sea **suya** antes de tocar nada: el identificador viaja por el chat y
 *    nadie debería poder confirmar la cita de otro con un botón ajeno;
 *  - con **una** cita pendiente se confirma directamente;
 *  - con **varias** se le ofrecen numeradas (o como botones, si el canal los tiene);
 *  - sin ninguna pendiente, si ya tenía una confirmada se le recuerda —confirmar dos
 *    veces no es un error— y si no hay nada, se le dice que no hay nada que confirmar.
 */
const confirmarCita = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  id: string | null,
): Promise<ResultadoConfirmar> => {
  // El paciente se identifica por la dirección del canal, no por el `patientId` de la
  // conversación: quien escribió «confirmar» puede tener el chat vinculado hace tiempo.
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  if (vinculado === null) {
    await reply(services, conversacion, 'sin_citas');
    return 'sin_citas';
  }

  const { from, to } = ventanaDeCitas();
  const pagina = await services.clients.listAppointments({
    patientId: vinculado.patientId,
    from,
    to,
    pageSize: 20,
  });
  const citas = pagina.items;

  if (id !== null) {
    const suya = citas.find((cita) => cita.id === id);
    if (suya === undefined) {
      await reply(services, conversacion, 'sin_citas');
      return 'no_es_suya';
    }
    return (await confirmarYResponder(services, conversacion, suya)) ? 'confirmada' : 'ya_estaba';
  }

  // Las que esperan respuesta: `confirmada` ya la tiene, y de `en_sala_espera` en
  // adelante el paciente está en el consultorio (o ya pasó).
  const pendientes = citas.filter(
    (cita) => cita.status === 'programada' || cita.status === 'notificada',
  );

  if (pendientes.length === 0) {
    const yaConfirmada = citas.find((cita) => cita.status === 'confirmada');
    if (yaConfirmada !== undefined) {
      await responderConfirmada(services, conversacion, yaConfirmada);
      return 'ya_estaba';
    }
    await reply(services, conversacion, 'sin_citas');
    return 'sin_citas';
  }

  if (pendientes.length === 1) {
    const unica = pendientes[0];
    if (unica !== undefined) {
      return (await confirmarYResponder(services, conversacion, unica))
        ? 'confirmada'
        : 'ya_estaba';
    }
  }

  await enviar(
    services,
    conversacion,
    'Tienes varias citas próximas. Dime cuál quieres confirmar.',
    pendientes.map((cita) => ({
      etiqueta: `${fechaVe(cita.date)} · ${formatTime12h(cita.startTime)}`,
      accion: `confirmar_cita:${cita.id}`,
    })),
  );
  return 'elegir';
};

/* ── Cancelar la cita (ADR 0053) ───────────────────────────────────────────── */

const responderCancelada = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
): Promise<void> => {
  await reply(services, conversacion, 'cita_cancelada_paciente', {
    paciente: cita.patientName,
    fecha: fechaVe(cita.date),
    hora: formatTime12h(cita.startTime),
  });
};

/** Cancela de verdad y responde. Devuelve `false` si la cita ya estaba cancelada. */
const cancelarYResponder = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
): Promise<boolean> => {
  if (cita.status === 'cancelada') {
    // Volver a cancelar no es un error: se le recuerda lo que ya hizo.
    await responderCancelada(services, conversacion, cita);
    return false;
  }

  const cancelada = await services.clients.cancelAppointment(cita.id, {
    channel: conversacion.canal,
    reason: null,
  });
  await responderCancelada(services, conversacion, cancelada);
  return true;
};

export type ResultadoCancelar =
  'cancelada' | 'ya_estaba' | 'elegir' | 'sin_citas' | 'no_es_suya' | 'no_cancelable';

/**
 * El paciente dice que no puede asistir. Es la mitad conversacional de la cancelación
 * (ADR 0053), hermana de `confirmarCita`: el asistente busca **sus** citas próximas y
 * cancela la que corresponda; la agenda libera la franja y devuelve su ticket a la cola.
 *
 * Reglas:
 *  - si viene un `id` (de un botón o de una opción numerada), se comprueba que esa cita
 *    sea **suya** antes de tocar nada: el identificador viaja por el chat y nadie debe
 *    poder cancelar la cita de otro con un botón ajeno;
 *  - con **una** cita cancelable se cancela directamente; con **varias** se ofrecen
 *    numeradas (o como botones, si el canal los tiene);
 *  - sin ninguna, si ya tenía una cancelada se le recuerda —cancelar dos veces no es un
 *    error— y si no hay nada, se le dice que no hay nada que cancelar;
 *  - si la cita ya está en sala, llamada o en consulta, se le dice que por aquí ya no se
 *    puede cancelar.
 *
 * `avisarSinCitas: false` deja que el llamador (el comando «cancelar» sin argumento)
 * caiga a la cancelación de la **solicitud** sin mandar antes un «no tienes citas».
 */
const cancelarCita = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  id: string | null,
  options: { avisarSinCitas?: boolean } = {},
): Promise<ResultadoCancelar> => {
  const avisarSinCitas = options.avisarSinCitas !== false;
  const sinNada = async (): Promise<ResultadoCancelar> => {
    if (avisarSinCitas) await reply(services, conversacion, 'sin_citas');
    return 'sin_citas';
  };

  // El paciente se identifica por la dirección del canal, no por el `patientId` de la
  // conversación: quien escribió «cancelar» puede tener el chat vinculado hace tiempo.
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  if (vinculado === null) return sinNada();

  const { from, to } = ventanaDeCitas();
  const pagina = await services.clients.listAppointments({
    patientId: vinculado.patientId,
    from,
    to,
    pageSize: 20,
  });
  const citas = pagina.items;

  if (id !== null) {
    const suya = citas.find((cita) => cita.id === id);
    if (suya === undefined) {
      await reply(services, conversacion, 'sin_citas');
      return 'no_es_suya';
    }
    if (!CANCELLABLE_STATUSES.includes(suya.status)) {
      await reply(services, conversacion, 'cita_no_cancelable', {
        estado: estadoDe(suya.status),
      });
      return 'no_cancelable';
    }
    return (await cancelarYResponder(services, conversacion, suya)) ? 'cancelada' : 'ya_estaba';
  }

  // Las que el paciente todavía puede cancelar por aquí: las que no han llegado al
  // consultorio. La lista es **la misma** que aplica la agenda (`CANCELLABLE_STATUSES`).
  const cancelables = citas.filter((cita) => CANCELLABLE_STATUSES.includes(cita.status));

  if (cancelables.length === 0) {
    const yaCancelada = citas.find((cita) => cita.status === 'cancelada');
    if (yaCancelada !== undefined) {
      await responderCancelada(services, conversacion, yaCancelada);
      return 'ya_estaba';
    }
    return sinNada();
  }

  if (cancelables.length === 1) {
    const unica = cancelables[0];
    if (unica !== undefined) {
      return (await cancelarYResponder(services, conversacion, unica)) ? 'cancelada' : 'ya_estaba';
    }
  }

  await enviar(
    services,
    conversacion,
    'Tienes varias citas próximas. Dime cuál quieres cancelar.',
    cancelables.map((cita) => ({
      etiqueta: `${fechaVe(cita.date)} · ${formatTime12h(cita.startTime)}`,
      accion: `cancelar_cita:${cita.id}`,
    })),
  );
  return 'elegir';
};

/* ── Pasos del asistente ───────────────────────────────────────────────────── */

const handleName = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const name = normalizeBotName(text);
  if (!name.ok) {
    await enviar(services, conversacion, name.message ?? 'Escribe tu nombre completo.');
    await askStep(services, conversacion, 'nombre');
    return;
  }

  const next = { ...draft, fullName: name.value };
  await saveConversation(services.db, conversacion, { state: 'documento', draft: next });
  await askStep(services, conversacion, 'documento');
};

const handleDocument = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  // Acepta «V-12345678», «v 12.345.678» o solo el número (con el tipo ya elegido).
  const cleaned = text.normalize('NFKC').trim().toUpperCase();
  const match = /^(?<type>V|E|P|SC)?[\s.\-/]*(?<number>[A-Z0-9.\-\s]+)$/.exec(cleaned);
  const type = (match?.groups?.['type'] as DocType | undefined) ?? draft.docType ?? null;
  const number = normalizeDocNumber(match?.groups?.['number'] ?? cleaned);

  if (type === null) {
    await enviar(
      services,
      conversacion,
      'Primero elige el tipo de documento (V, E, P o SC) y luego me escribes el número.',
    );
    await askStep(services, conversacion, 'documento');
    return;
  }

  const validation = validateDocument(type, number);
  if (!validation.ok) {
    await enviar(services, conversacion, validation.message ?? 'Revisa el documento.');
    await askStep(services, conversacion, 'documento');
    return;
  }

  const next = { ...draft, docType: type, docNumber: number };

  // ¿Ya existe? El plan pide confirmar con los datos enmascarados antes de seguir.
  const existing = await services.clients.findPatientByDocument(type, number);
  if (existing !== null) {
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...draftFromPatient(existing), reason: null },
      patientId: existing.id,
    });
    await reply(
      services,
      conversacion,
      'documento_duplicado',
      {
        paciente: existing.fullName,
        documento: maskDocument(existing.docType, existing.docNumber),
      },
      [
        { etiqueta: 'Sí, soy yo', accion: 'duplicado:si' },
        { etiqueta: 'No, corregir', accion: 'duplicado:no' },
      ],
    );
    return;
  }

  await saveConversation(services.db, conversacion, { state: 'telefono', draft: next });
  await askStep(services, conversacion, 'telefono');
};

const handlePhone = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const phone = normalizePhone(text);
  if (!/^\+58\d{10}$/.test(phone)) {
    await enviar(
      services,
      conversacion,
      'Ese teléfono no me sirve: escríbelo con 11 dígitos, por ejemplo 0412-1234567.',
    );
    await askStep(services, conversacion, 'telefono');
    return;
  }

  await saveConversation(services.db, conversacion, {
    state: 'nacimiento',
    draft: { ...draft, phone },
  });
  await askStep(services, conversacion, 'nacimiento');
};

const handleBirthDate = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const parsed = parseBotDate(text);
  if (!parsed.ok || parsed.value === undefined) {
    await enviar(services, conversacion, parsed.message ?? 'Revisa la fecha.');
    await askStep(services, conversacion, 'nacimiento');
    return;
  }

  const next = { ...draft, birthDate: parsed.value };
  if (isMinor(parsed.value)) {
    await saveConversation(services.db, conversacion, { state: 'representante', draft: next });
    await reply(services, conversacion, 'pedir_representante', { paciente: next.fullName });
    return;
  }

  await saveConversation(services.db, conversacion, { state: 'sexo', draft: next });
  await askStep(services, conversacion, 'sexo');
};

const handleGuardian = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const name = normalizeBotName(text);
  if (!name.ok) {
    await enviar(services, conversacion, name.message ?? 'Escribe el nombre del representante.');
    await reply(services, conversacion, 'pedir_representante', { paciente: draft.fullName });
    return;
  }

  await saveConversation(services.db, conversacion, {
    state: 'sexo',
    draft: { ...draft, guardianName: name.value },
  });
  await askStep(services, conversacion, 'sexo');
};

const handleReason = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const reason = cleanText(text);
  if (reason.length < 5 || reason.length > 500) {
    await enviar(
      services,
      conversacion,
      'Cuéntame un poco más (entre 5 y 500 caracteres) para que el consultorio sepa qué necesitas.',
    );
    await askStep(services, conversacion, 'motivo');
    return;
  }

  const next = { ...draft, reason };
  await saveConversation(services.db, conversacion, { state: 'confirmacion', draft: next });
  await reply(services, conversacion, 'confirmar', { resumen: summaryOf(next) }, [
    { etiqueta: 'Confirmar', accion: 'confirmar:si' },
    { etiqueta: 'Corregir', accion: 'confirmar:no' },
  ]);
};

/** Crea (o reutiliza) el paciente y su solicitud, y responde con el ticket. */
const finalize = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  patientId: string | null,
): Promise<void> => {
  if (
    draft.fullName === null ||
    draft.docType === null ||
    draft.docNumber === null ||
    draft.phone === null ||
    draft.birthDate === null ||
    draft.sex === null ||
    draft.reason === null
  ) {
    await enviar(services, conversacion, 'Me falta algún dato. Escribamos la solicitud otra vez.');
    await saveConversation(services.db, conversacion, { state: 'nombre', draft: emptyDraft() });
    await askStep(services, conversacion, 'nombre');
    return;
  }

  const sex = draft.sex as 'M' | 'F' | 'O';
  const canal = conversacion.canal;

  const patient =
    patientId === null
      ? await services.clients.upsertPatient({
          docType: draft.docType,
          docNumber: draft.docNumber,
          fullName: draft.fullName,
          birthDate: draft.birthDate,
          sex,
          phone: draft.phone,
          guardian:
            draft.guardianName === null
              ? undefined
              : { fullName: draft.guardianName, relationship: 'Representante', phone: draft.phone },
          channel: canal,
          reason: `alta desde el asistente de ${CHANNEL_LABELS[canal]}`,
        })
      : {
          created: false,
          patient: {
            id: patientId,
            fullName: draft.fullName,
            document: `${draft.docType}-${draft.docNumber}`,
          },
        };

  const summary = await services.clients.createRequest({
    patientId: patient.patient.id,
    patientName: draft.fullName,
    patientDocument: `${draft.docType}-${draft.docNumber}`,
    patientPhone: draft.phone,
    channel: canal,
    reason: draft.reason,
    notes: `Solicitud tomada por el asistente (${canal})`,
  });

  await saveConversation(services.db, conversacion, {
    state: 'inicio',
    draft: emptyDraft(),
    patientId: patient.patient.id,
    lastTicket: summary.ticketNumber,
  });

  // El canal queda vinculado al paciente: sus avisos de cita ya tienen destino.
  await linkChat(services.db, {
    patientId: patient.patient.id,
    canal,
    direccion: conversacion.direccion,
  });

  await reply(services, conversacion, 'solicitud_recibida', {
    paciente: draft.fullName,
    ticket: summary.ticket,
  });
};

/* ── Entrada de mensajes ───────────────────────────────────────────────────── */

/**
 * Procesa un mensaje entrante ya normalizado (ADR 0029).
 *
 * Todo el guion del plan §7 está aquí: intenciones, vinculación por código, pasos
 * con validación, confirmación final y anti-flood. Es **idempotente** por
 * `(canal, eventoId)`: el mismo `update_id` o `wamid` no crea dos tickets. La
 * conversación se puede retomar en cualquier momento porque el estado vive en la
 * base, y las respuestas salen por el adaptador del canal (con las opciones
 * numeradas guardadas cuando el canal no tiene botones).
 */
export const handleInbound = async (
  services: AsistenteServices,
  entrante: InboundMessage,
): Promise<InboundOutcome> => {
  const conversacion: Conversacion = {
    canal: entrante.canal,
    direccion: entrante.direccion,
  };

  const texto = (entrante.texto ?? '').trim();
  const accion = (entrante.accion ?? '').trim();
  if (texto === '' && accion === '') {
    return { ...conversacion, handled: false };
  }

  // Idempotencia por evento del canal, antes de tocar nada más.
  const claimed = await services.db
    .insert(processedUpdates)
    .values({ canal: entrante.canal, eventoId: entrante.eventoId, direccion: entrante.direccion })
    .onConflictDoNothing({ target: [processedUpdates.canal, processedUpdates.eventoId] })
    .returning({ eventoId: processedUpdates.eventoId });

  if (claimed.length === 0) {
    return { ...conversacion, handled: false, action: 'duplicado' };
  }

  const conversation = await loadConversation(
    services.db,
    entrante.canal,
    entrante.direccion,
    entrante.usuario,
  );
  if (await isFlooding(services, conversation)) {
    return { ...conversacion, handled: false, action: 'anti_flood' };
  }

  const adapter = services.canales.get(entrante.canal);
  const capacidades = adapter?.capacidades ?? {
    botones: false,
    documentos: false,
    comandos: false,
    plantillasAprobadas: false,
  };
  const draft = toDraft(conversation);

  // Botón pulsado o número que responde a las opciones numeradas del último paso.
  const elegida =
    accion !== ''
      ? accion
      : resolveNumberedOption(texto, new Map(Object.entries(conversation.opciones)));

  if (elegida !== null) {
    const [kind = '', value = ''] = elegida.split(':');

    if (kind === 'doc') {
      const type = value as DocType;
      if (!['V', 'E', 'P', 'SC'].includes(type)) return { ...conversacion, handled: false };
      await saveConversation(services.db, conversacion, { draft: { ...draft, docType: type } });
      await enviar(
        services,
        conversacion,
        `${DOC_TYPE_LABEL[type]} (${type}): escríbeme el número, por ejemplo ${DOC_TYPE_EXAMPLE[type]}.`,
      );
      return { ...conversacion, handled: true, action: 'documento_tipo' };
    }

    if (kind === 'sexo') {
      if (!['M', 'F', 'O'].includes(value)) return { ...conversacion, handled: false };
      const next = { ...draft, sex: value };
      await saveConversation(services.db, conversacion, { state: 'motivo', draft: next });
      await askStep(services, conversacion, 'motivo');
      return { ...conversacion, handled: true, action: 'sexo' };
    }

    if (kind === 'duplicado') {
      if (value === 'si') {
        await saveConversation(services.db, conversacion, {
          state: 'motivo',
          draft,
          patientId: conversation.patientId,
        });
        await askStep(services, conversacion, 'motivo');
        return { ...conversacion, handled: true, action: 'duplicado_si' };
      }
      await saveConversation(services.db, conversacion, {
        state: 'nombre',
        draft: emptyDraft(),
        patientId: null,
      });
      await askStep(services, conversacion, 'nombre');
      return { ...conversacion, handled: true, action: 'duplicado_no' };
    }

    if (kind === 'confirmar_cita') {
      const resultado = await confirmarCita(services, conversacion, value === '' ? null : value);
      return { ...conversacion, handled: true, action: `confirmar_${resultado}` };
    }

    if (kind === 'cancelar_cita') {
      const resultado = await cancelarCita(services, conversacion, value === '' ? null : value);
      return { ...conversacion, handled: true, action: `cancelar_cita_${resultado}` };
    }

    if (kind === 'confirmar') {
      if (value === 'si') {
        await finalize(services, conversacion, draft, conversation.patientId);
        return { ...conversacion, handled: true, action: 'solicitud_creada' };
      }
      await saveConversation(services.db, conversacion, { state: 'nombre', draft: emptyDraft() });
      await askStep(services, conversacion, 'nombre');
      return { ...conversacion, handled: true, action: 'corregir' };
    }

    return { ...conversacion, handled: false };
  }

  // Intenciones: comandos con barra (Telegram) o frases naturales (WhatsApp).
  const detectada = detectIntent(texto, { comandos: capacidades.comandos });

  if (detectada.intencion !== null) {
    switch (detectada.intencion) {
      case 'start': {
        if (detectada.argumento !== '') {
          const linked = await linkByCode(
            services,
            conversacion,
            detectada.argumento,
            entrante.usuario,
          );
          return {
            ...conversacion,
            handled: true,
            action: linked ? 'vinculado' : 'codigo_invalido',
          };
        }
        await saveConversation(services.db, conversacion, { state: 'inicio', draft: emptyDraft() });
        await reply(services, conversacion, 'bienvenida');
        return { ...conversacion, handled: true, action: 'start' };
      }
      case 'ayuda': {
        await reply(services, conversacion, 'ayuda', {}, undefined, { conMenu: true });
        return { ...conversacion, handled: true, action: 'ayuda' };
      }
      case 'estado': {
        const ticket =
          detectada.argumento !== ''
            ? detectada.argumento
            : conversation.lastTicket === null
              ? null
              : formatTicket(conversation.lastTicket).value;
        await showStatus(services, conversacion, ticket);
        return { ...conversacion, handled: true, action: 'estado' };
      }
      case 'mi_ticket': {
        const ticket =
          conversation.lastTicket === null ? null : formatTicket(conversation.lastTicket).value;
        await showStatus(services, conversacion, ticket);
        return { ...conversacion, handled: true, action: 'mi_ticket' };
      }
      case 'cancelar': {
        // Con un ticket detrás (`/cancelar #000123`) se conserva el comportamiento de
        // siempre: anular la **solicitud**. Sin argumento, primero se intenta cancelar
        // la **cita** ya asignada (ADR 0053) y, si el paciente no tiene ninguna, se cae
        // a la solicitud, que es lo que hacía antes.
        if (detectada.argumento !== '') {
          await cancelRequest(services, conversacion, detectada.argumento);
          return { ...conversacion, handled: true, action: 'cancelar' };
        }

        const resultado = await cancelarCita(services, conversacion, null, {
          avisarSinCitas: false,
        });
        if (resultado !== 'sin_citas') {
          return { ...conversacion, handled: true, action: `cancelar_cita_${resultado}` };
        }

        const ticket =
          conversation.lastTicket === null ? null : formatTicket(conversation.lastTicket).value;
        await cancelRequest(services, conversacion, ticket);
        return { ...conversacion, handled: true, action: 'cancelar' };
      }
      case 'confirmar': {
        // La misma acción que el botón del aviso, para quien responde escribiendo.
        const resultado = await confirmarCita(services, conversacion, null);
        return { ...conversacion, handled: true, action: `confirmar_${resultado}` };
      }
      case 'nueva': {
        const blocked = await hasActiveRequest(services, conversation);
        if (blocked !== null) {
          await reply(services, conversacion, 'solicitud_en_curso', { ticket: blocked });
          return { ...conversacion, handled: true, action: 'solicitud_en_curso' };
        }
        await saveConversation(services.db, conversacion, { state: 'nombre', draft: emptyDraft() });
        await askStep(services, conversacion, 'nombre');
        return { ...conversacion, handled: true, action: 'nueva' };
      }
    }
  }

  // Un comando que no existe: se ofrece la ayuda con el menú (solo en canales con comandos).
  if (detectada.comando) {
    await reply(services, conversacion, 'ayuda', {}, undefined, { conMenu: true });
    return { ...conversacion, handled: true, action: 'comando_desconocido' };
  }

  // Texto libre: si parece un ticket, se consulta su estado; si no, sigue el paso.
  const maybeTicket = parseTicket(texto);
  if (maybeTicket !== null && conversation.state === 'inicio') {
    await showStatus(services, conversacion, maybeTicket.value);
    return { ...conversacion, handled: true, action: 'estado_por_texto' };
  }

  switch (conversation.state) {
    case 'nombre':
      await handleName(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_nombre' };
    case 'documento':
      await handleDocument(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_documento' };
    case 'telefono':
      await handlePhone(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_telefono' };
    case 'nacimiento':
      await handleBirthDate(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_nacimiento' };
    case 'representante':
      await handleGuardian(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_representante' };
    case 'motivo':
      await handleReason(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_motivo' };
    default: {
      await reply(services, conversacion, 'bienvenida');
      return { ...conversacion, handled: true, action: 'bienvenida' };
    }
  }
};

/** ¿Tiene ya una solicitud en curso? Devuelve el ticket si la tiene. */ const hasActiveRequest =
  async (services: AsistenteServices, conversation: BotConversationRow): Promise<string | null> => {
    if (conversation.lastTicket === null) return null;
    const ticket = formatTicket(conversation.lastTicket).value;
    const found = await services.clients.findRequestByTicket(ticket);
    if (found === null) return null;
    if (
      found.status === 'cancelada' ||
      found.status === 'atendido' ||
      found.status === 'no_asistio'
    ) {
      return null;
    }
    return found.ticket;
  };

/** Vinculación por código: `t.me/<bot>?start=<código>` en Telegram. */
const linkByCode = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  code: string,
  usuario: string | null,
): Promise<boolean> => {
  const rows = await services.db
    .select()
    .from(patientChannels)
    .where(
      and(eq(patientChannels.linkCode, code), gt(patientChannels.linkCodeExpiresAt, new Date())),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    await enviar(
      services,
      conversacion,
      'Ese enlace ya no sirve (caducó). Pídele al consultorio uno nuevo, por favor.',
    );
    return false;
  }

  await linkChat(services.db, {
    patientId: row.patientId,
    canal: conversacion.canal,
    direccion: conversacion.direccion,
    usuario,
    viaCode: code,
  });
  await saveConversation(services.db, conversacion, {
    state: 'inicio',
    patientId: row.patientId,
  });

  await reply(services, conversacion, 'bienvenida');
  await enviar(
    services,
    conversacion,
    'Listo: quedaste vinculado con tu ficha del consultorio. Te avisaré por aquí cuando tu cita esté confirmada.',
  );
  return true;
};

/* ── Cuando algo de fuera falla ────────────────────────────────────────────── */

/** Pasos del guion que se pueden volver a pedir tal cual. */
const PASOS_REPETIBLES = new Set([
  'nombre',
  'documento',
  'telefono',
  'nacimiento',
  'sexo',
  'motivo',
]);

/**
 * El paciente **nunca se queda sin respuesta**.
 *
 * El asistente habla con otros servicios (pacientes y agenda) y con la base; si uno
 * falla —un servicio reiniciándose, por ejemplo— el error subía hasta el bucle del
 * canal y ahí se quedaba: el mensaje se registraba en el log y la persona no recibía
 * nada, sin saber si esperar o volver a escribir. Pasó de verdad el 2026-10-04, con
 * `ECONNREFUSED 127.0.0.1:4002` a mitad del paso del documento.
 *
 * Ahora se avisa y se repite el paso: la conversación está en la base y el mensaje
 * se puede reenviar tal cual. El error sigue subiendo (el llamador lo registra) para
 * que nadie lo confunda con un éxito.
 */
export const avisarFalloAlPaciente = async (
  services: AsistenteServices,
  entrante: InboundMessage,
): Promise<void> => {
  const conversacion: Conversacion = { canal: entrante.canal, direccion: entrante.direccion };

  const conversation = await loadConversation(
    services.db,
    entrante.canal,
    entrante.direccion,
    entrante.usuario,
  );

  await reply(services, conversacion, 'servicio_no_disponible');

  // Si estaba rellenando un paso, se le vuelve a pedir para que sepa qué escribir.
  if (PASOS_REPETIBLES.has(conversation.state)) {
    await askStep(
      services,
      conversacion,
      conversation.state as 'nombre' | 'documento' | 'telefono' | 'nacimiento' | 'sexo' | 'motivo',
    );
  }
};
