import {
  BOT_CONFIRM_WINDOW_DAYS,
  BOT_STEP_LABELS,
  CANCELLABLE_STATUSES,
  CHANNEL_LABELS,
  botDraftSchema,
  cleanText,
  detectFlowNavigation,
  detectIntent,
  formatTicket,
  formatTime12h,
  isMinor,
  maskDocument,
  normalizeBotName,
  normalizePhrase,
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
  type FlowNavigation,
  type InboundMessage,
  type OutboundButton,
  type PatientSummary,
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
import {
  channelByDireccion,
  linkChat,
  renderMessageFor,
  todayInClinic,
  touchInbound,
  unlinkChatByDireccion,
} from '../messaging.js';
import { getNotificationSettings } from '../settings.js';

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
  /** v1.2: verificación ligera antes de vincular un segundo chat a una ficha. */
  verificar_identidad: 'Verificar identidad',
  /** v1.2: menú de corrección en un solo salto desde el resumen. */
  corregir_menu: 'Corregir datos',
  /** v1.2: confirmación antes de desvincular este chat. */
  confirmar_desvinculacion: 'Confirmar desvinculación',
  esperando_confirmacion: 'Confirmación',
  listo: 'Listo',
};

export const stateLabel = (state: string): string => STATE_LABEL[state] ?? state;

const emptyDraft = (): BotDraft => botDraftSchema.parse({});

const toDraft = (row: BotConversationRow): BotDraft => botDraftSchema.parse(row.draft);

/** Paso del alta que se responde con texto libre (y que se puede repetir tal cual). */
type PasoTipado = 'documento' | 'nombre' | 'telefono' | 'nacimiento' | 'sexo' | 'motivo';

/**
 * Borrador con la intención con la que arranca el alta (v1.2): `nueva` pide cita y
 * `vincular` solo enlaza el chat. `verificar_identidad` lo necesita para saber si,
 * tras verificar, debe seguir al Paso 6 (motivo) o terminar en `inicio`.
 */
const draftParaFlujo = (flow: 'nueva' | 'vincular'): BotDraft => ({
  ...emptyDraft(),
  flow,
});

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

/**
 * Nombre **abreviado** para no soltar datos completos antes de verificar la
 * identidad (v1.2): «María Pérez» → «María P.». Se queda la primera palabra y la
 * inicial del segundo apellido; con una sola palabra se devuelve tal cual.
 */
export const abbreviateName = (fullName: string): string => {
  const partes = fullName
    .trim()
    .split(/\s+/)
    .filter((parte) => parte !== '');
  const [nombre, segundo] = partes;
  if (nombre === undefined) return fullName.trim();
  if (segundo === undefined) return nombre;
  return `${nombre} ${segundo.charAt(0).toUpperCase()}.`;
};

/**
 * ¿El texto que escribe el paciente coincide con la **fecha de nacimiento** o con
 * los **últimos 4 dígitos** de su teléfono registrado? Es la prueba de identidad
 * ligera del 2.º chat (v1.2, §4.2 del plan): no se vincula una ficha con solo
 * conocer una cédula pública.
 */
export const coincideVerificacion = (
  texto: string,
  candidato: { birthDate: string | null; phone: string | null },
): boolean => {
  const fecha = parseBotDate(texto);
  if (fecha.ok && fecha.value !== undefined && candidato.birthDate !== null) {
    if (candidato.birthDate.slice(0, 10) === fecha.value) return true;
  }
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length !== 4 || candidato.phone === null) return false;
  return candidato.phone.replace(/\D/g, '').endsWith(digitos);
};

/**
 * Datos del paciente por id (el nombre, la fecha de nacimiento y el teléfono viven
 * en el servicio de pacientes, no en esta base). `null` cuando el servicio no
 * responde o no encuentra la ficha: el llamador decide si avisar
 * (`servicio_no_disponible`) o continuar sin el dato.
 */
const resumenPaciente = async (
  services: AsistenteServices,
  patientId: string,
): Promise<PatientSummary | null> => {
  try {
    const resumenes = await services.clients.listPatientSummaries([patientId]);
    return resumenes[0] ?? null;
  } catch {
    return null;
  }
};

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
  opciones: { conMenu?: boolean; sufijo?: string } = {},
): Promise<void> => {
  const texto = await renderMessageFor(services.db, key, {
    clinica: services.config.CLINIC_NAME ?? '',
    lugar: services.config.CLINIC_ADDRESS ?? '',
    ...values,
  });

  // La ayuda termina con el menú de comandos, generado del catálogo del contrato:
  // así quien no descubra el menú de Telegram (o use WhatsApp, que no lo tiene) ve
  // igualmente lo que el asistente sabe hacer, y la lista no se queda desfasada.
  const capacidades = services.canales.get(conversacion.canal)?.capacidades;
  const conMenu = opciones.conMenu === true && capacidades?.comandos === true;
  const partes = [texto];
  if (opciones.sufijo !== undefined) partes.push(opciones.sufijo);
  if (conMenu) partes.push(botCommandsAsText());
  await enviar(services, conversacion, partes.join('\n\n'), botones);
};

const DOC_TYPE_EXAMPLE: Readonly<Record<DocType, string>> = {
  V: '12345678',
  E: '12345678',
  P: 'A123456',
  SC: '0042',
};

/** Botones de un paso: el núcleo los da; el canal decide si los manda o los numera. */
const stepButtons = (step: PasoTipado) =>
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

/**
 * Pide un paso del alta. `motivo` (v1.2) es el error de la validación anterior y
 * viaja en la **misma burbuja** que la pregunta: en WhatsApp Baileys cada mensaje
 * extra cuesta segundos del limitador y cuota diaria.
 */
const askStep = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  step: PasoTipado,
  opciones: { motivo?: string; values?: Readonly<Record<string, string | null>> } = {},
): Promise<void> => {
  const texto = await renderMessageFor(services.db, `pedir_${step}`, {
    clinica: services.config.CLINIC_NAME ?? '',
    lugar: services.config.CLINIC_ADDRESS ?? '',
    ...(opciones.values ?? {}),
  });
  const cuerpo = opciones.motivo === undefined ? texto : `${opciones.motivo}\n\n${texto}`;
  await enviar(services, conversacion, cuerpo, stepButtons(step));
};

/** Pide el nombre del representante (sub-paso de `nacimiento` cuando es menor). */
const askRepresentante = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  motivo?: string,
): Promise<void> => {
  const texto = await renderMessageFor(services.db, 'pedir_representante', {
    clinica: services.config.CLINIC_NAME ?? '',
    lugar: services.config.CLINIC_ADDRESS ?? '',
    paciente: draft.fullName ?? '',
  });
  await enviar(services, conversacion, motivo === undefined ? texto : `${motivo}\n\n${texto}`);
};

/**
 * Resumen del borrador para el paso de confirmación. En v1.2 el **documento va
 * primero**, igual que el guion del alta.
 */
const summaryOf = (draft: BotDraft): string => {
  const lines = [
    `Documento: ${draft.docType ?? ''}-${draft.docNumber ?? ''}`,
    `Nombre: ${draft.fullName ?? '—'}`,
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

/** Enseña el resumen final («Paso 7 de 7») con sus dos opciones. */
const mostrarResumen = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
): Promise<void> => {
  await reply(services, conversacion, 'confirmar', { resumen: summaryOf(draft) }, [
    { etiqueta: 'Confirmar', accion: 'confirmar:si' },
    { etiqueta: 'Corregir', accion: 'confirmar:no' },
  ]);
};

/**
 * Pista de navegación que se añade **desde el asistente** al final de la ayuda
 * (v1.2): en cualquier paso se puede escribir «volver» o «salir».
 */
const AYUDA_NAVEGACION =
  'En cualquier momento escribe «volver» para retroceder o «salir» para cancelar el proceso.';

/** Menú rápido de la bienvenida y la ayuda (v1.2, §2.3 del plan). */
export const menuRapidoButtons = (vinculado: boolean): OutboundButton[] => [
  { etiqueta: 'Pedir una cita', accion: 'menu:nueva' },
  { etiqueta: 'Ver estado de mi cita', accion: 'menu:estado' },
  { etiqueta: 'Confirmar asistencia', accion: 'menu:confirmar' },
  { etiqueta: 'Cancelar cita o solicitud', accion: 'menu:cancelar' },
  ...(vinculado ? [{ etiqueta: 'Cambiar de paciente', accion: 'menu:desvincular' }] : []),
];

/* ── Corrección granular (v1.2) ────────────────────────────────────────────── */

/** Campo del alta que el menú de corrección permite volver a escribir. */
type CampoCorreccion =
  | 'documento'
  | 'nombre'
  | 'telefono'
  | 'nacimiento'
  | 'representante'
  | 'sexo'
  | 'motivo'
  | 'todo'
  | 'volver';

const CAMPO_CORRECCION_POR_TEXTO: Readonly<Record<string, CampoCorreccion>> = {
  documento: 'documento',
  cedula: 'documento',
  ci: 'documento',
  'cedula de identidad': 'documento',
  nombre: 'nombre',
  telefono: 'telefono',
  fecha: 'nacimiento',
  nacimiento: 'nacimiento',
  'fecha de nacimiento': 'nacimiento',
  representante: 'representante',
  sexo: 'sexo',
  motivo: 'motivo',
  todo: 'todo',
  'corregir todo': 'todo',
  'todo desde el inicio': 'todo',
  reiniciar: 'todo',
  'empezar de nuevo': 'todo',
  volver: 'volver',
  atras: 'volver',
};

/**
 * Traduce lo que el paciente escribe en `corregir_menu` (v1.2). Un paciente ya
 * registrado solo puede cambiar el motivo o empezar de nuevo con otra cédula: el
 * resto de datos vive en su ficha clínica y no se reescribe desde el chat.
 */
export const corregirCampoDesdeTexto = (
  texto: string,
  pacienteExistente: boolean,
): CampoCorreccion | null => {
  const campo = CAMPO_CORRECCION_POR_TEXTO[normalizePhrase(texto)] ?? null;
  if (campo === null || !pacienteExistente) return campo;
  switch (campo) {
    case 'motivo':
    case 'todo':
    case 'volver':
      return campo;
    case 'documento':
      return 'todo';
    default:
      return null;
  }
};

/**
 * Paso anterior en el orden v1.2, para «volver» a mitad del formulario. Se conserva
 * el borrador entero: retroceder no borra lo ya escrito.
 */
export const estadoAnterior = (
  estado: string,
  draft: BotDraft,
): PasoTipado | 'representante' | null => {
  switch (estado) {
    case 'documento':
      // El Paso 1 no tiene anterior: se vuelve a preguntar el documento.
      return 'documento';
    case 'nombre':
      return 'documento';
    case 'telefono':
      return 'nombre';
    case 'nacimiento':
      return 'telefono';
    case 'representante':
      return 'nacimiento';
    case 'sexo':
      return draft.guardianName !== null ? 'representante' : 'nacimiento';
    case 'motivo':
      return 'sexo';
    default:
      return null;
  }
};

/** Estados en los que «volver»/«salir» se atienden antes que cualquier intención. */
const ESTADOS_NAVEGABLES: ReadonlySet<string> = new Set([
  'documento',
  'nombre',
  'telefono',
  'nacimiento',
  'representante',
  'sexo',
  'motivo',
  'corregir_menu',
  'confirmacion',
  'verificar_identidad',
  'confirmar_desvinculacion',
]);

/* ── Solicitudes activas y deduplicación entre chats (v1.2) ────────────────── */

const esSolicitudActiva = (solicitud: RequestSummary): boolean =>
  solicitud.status !== 'cancelada' &&
  solicitud.status !== 'atendido' &&
  solicitud.status !== 'no_asistio';

/** Una solicitud en espera **sin cita vigente** se puede reutilizar (ADR 0028). */
const esSolicitudReutilizable = (solicitud: RequestSummary): boolean =>
  solicitud.status === 'en_espera_cita' && solicitud.appointmentDate === null;

/**
 * Solicitud activa del paciente, mirando **todos** sus chats (v1.2): el ticket no
 * puede depender de en qué chat se creó. Devuelve la reutilizable si la hay.
 */
const solicitudActivaDePaciente = async (
  services: AsistenteServices,
  patientId: string,
): Promise<RequestSummary | null> => {
  const solicitudes = await services.clients.listRequestsByPatient(patientId);
  const activas = solicitudes.filter(esSolicitudActiva);
  return activas.find(esSolicitudReutilizable) ?? activas[0] ?? null;
};

/** Solicitud en espera sin cita del paciente, para reutilizarla al finalizar el alta. */
const solicitudReutilizableDePaciente = async (
  services: AsistenteServices,
  patientId: string,
): Promise<RequestSummary | null> => {
  const solicitudes = await services.clients.listRequestsByPatient(patientId);
  return solicitudes.find(esSolicitudReutilizable) ?? null;
};

const DOC_TYPE_LABEL: Readonly<Record<DocType, string>> = {
  V: 'Venezolano',
  E: 'Extranjero',
  P: 'Pasaporte',
  SC: 'Menor sin cédula',
};

/* ── Flujo v1.2: navegación, corrección, identidad y cambio de paciente ────── */

/** Ticket guardado en la conversación, como texto (`#000123`). */
const ticketDe = (conversation: BotConversationRow): string | null =>
  conversation.lastTicket === null ? null : formatTicket(conversation.lastTicket).value;

/** Bienvenida con el menú rápido (v1.2). El botón de cambiar de paciente solo sale vinculado. */
const mostrarBienvenida = async (
  services: AsistenteServices,
  conversacion: Conversacion,
): Promise<void> => {
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  await reply(services, conversacion, 'bienvenida', {}, menuRapidoButtons(vinculado !== null));
};

/** Ayuda: menú rápido + pista de navegación (v1.2) + catálogo de comandos si el canal los tiene. */
const mostrarAyuda = async (
  services: AsistenteServices,
  conversacion: Conversacion,
): Promise<void> => {
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  await reply(services, conversacion, 'ayuda', {}, menuRapidoButtons(vinculado !== null), {
    conMenu: true,
    sufijo: AYUDA_NAVEGACION,
  });
};

/**
 * Intención `nueva` (v1.2). En un chat vinculado primero se pregunta **para quién**
 * es la cita: si es para otra persona hay que desvincular este chat y registrar a
 * la otra (un paciente activo por chat, Opción B del plan).
 */
const iniciarNueva = async (
  services: AsistenteServices,
  conversacion: Conversacion,
): Promise<string> => {
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  if (vinculado === null) {
    await saveConversation(services.db, conversacion, {
      state: 'documento',
      draft: draftParaFlujo('nueva'),
      patientId: null,
      lastTicket: null,
    });
    await askStep(services, conversacion, 'documento');
    return 'nueva';
  }

  const resumen = await resumenPaciente(services, vinculado.patientId);
  await saveConversation(services.db, conversacion, {
    state: 'inicio',
    draft: draftParaFlujo('nueva'),
    patientId: vinculado.patientId,
  });
  await reply(
    services,
    conversacion,
    'cita_para',
    { paciente: resumen?.fullName ?? 'este paciente' },
    [
      { etiqueta: 'Para mí', accion: 'cita_para:yo' },
      { etiqueta: 'Para otra persona', accion: 'cita_para:otro' },
    ],
  );
  return 'nueva';
};

/** «La cita es para mí»: dedupe de la solicitud activa del paciente y paso 6. */
const citaParaYo = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
): Promise<string> => {
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  if (vinculado === null) return iniciarNueva(services, conversacion);

  const resumen = await resumenPaciente(services, vinculado.patientId);
  if (resumen === null) {
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: vinculado.patientId,
    });
    await reply(services, conversacion, 'servicio_no_disponible');
    return 'servicio_no_disponible';
  }

  // v1.2: la solicitud activa se busca por **paciente**, no por el ticket de este chat.
  const activa = await solicitudActivaDePaciente(services, vinculado.patientId);
  const reutilizable = activa !== null && esSolicitudReutilizable(activa);
  if (activa !== null && !reutilizable) {
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: vinculado.patientId,
      lastTicket: activa.ticketNumber,
    });
    await reply(services, conversacion, 'solicitud_en_curso', { ticket: activa.ticket });
    return 'solicitud_en_curso';
  }

  await saveConversation(services.db, conversacion, {
    state: 'motivo',
    draft: { ...draftFromPatient(resumen), flow: draft.flow },
    patientId: vinculado.patientId,
    lastTicket: reutilizable && activa !== null ? activa.ticketNumber : conversation.lastTicket,
  });
  await askStep(services, conversacion, 'motivo');
  return 'cita_para_yo';
};

/** «La cita es para otra persona»: hay que confirmar la desvinculación de este chat. */
const citaParaOtro = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
): Promise<string> => {
  await saveConversation(services.db, conversacion, {
    state: 'confirmar_desvinculacion',
    draft: { ...draft, pendingUnlink: 'desvincular_y_nueva' },
  });
  await reply(services, conversacion, 'desvincular_y_nueva', {}, [
    { etiqueta: 'Sí, desvincular y registrar', accion: 'desvincular_y_nueva:si' },
    { etiqueta: 'No, mantener vínculo', accion: 'desvincular_y_nueva:no' },
  ]);
  return 'cita_para_otro';
};

/**
 * Intención `desvincular`: si el chat no está vinculado se dice sin más; si lo está
 * se pide confirmación con el nombre y el documento **enmascarado**.
 */
const preguntarDesvinculacion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
): Promise<string> => {
  const vinculado = await channelByDireccion(
    services.db,
    conversacion.canal,
    conversacion.direccion,
  );
  if (vinculado === null) {
    await saveConversation(services.db, conversacion, { state: 'inicio', draft: emptyDraft() });
    await reply(services, conversacion, 'desvincular_no_vinculado');
    return 'desvincular_sin_vinculo';
  }

  const resumen = await resumenPaciente(services, vinculado.patientId);
  await saveConversation(services.db, conversacion, {
    state: 'confirmar_desvinculacion',
    draft: { ...emptyDraft(), pendingUnlink: 'desvincular' },
    patientId: vinculado.patientId,
  });
  await reply(
    services,
    conversacion,
    'confirmar_desvinculacion',
    {
      paciente: resumen?.fullName ?? 'el paciente vinculado',
      documento: resumen === null ? '••••' : maskDocument(resumen.docType, resumen.docNumber),
    },
    [
      { etiqueta: 'Sí, desvincular este chat', accion: 'desvincular:si' },
      { etiqueta: 'No, mantener vínculo', accion: 'desvincular:no' },
    ],
  );
  return 'desvincular';
};

/** «No» a la desvinculación: se sigue con el paciente de siempre (no se toca nada). */
const mantenerVinculo = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
): Promise<void> => {
  const resumen =
    conversation.patientId === null
      ? null
      : await resumenPaciente(services, conversation.patientId);
  await saveConversation(services.db, conversacion, {
    state: 'inicio',
    draft: emptyDraft(),
    patientId: conversation.patientId,
  });
  await reply(services, conversacion, 'desvinculacion_cancelada', {
    paciente: resumen?.fullName ?? 'tu ficha',
  });
};

/**
 * Desvincula **solo este chat** y, si venía de «otra persona», en la misma burbuja
 * arranca el alta del nuevo paciente con el Paso 1. Los demás chats del paciente
 * anterior no se tocan (`unlinkChatByDireccion`).
 */
const desvincularChat = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conNueva: boolean,
): Promise<string> => {
  if (conNueva) {
    // El texto del Paso 1 se renderiza **antes** de desvincular y viaja dentro de la
    // plantilla de desvinculación: una sola burbuja para las dos cosas.
    const paso = await renderMessageFor(services.db, 'pedir_documento', {
      clinica: services.config.CLINIC_NAME ?? '',
      lugar: services.config.CLINIC_ADDRESS ?? '',
    });
    await unlinkChatByDireccion(services.db, conversacion.canal, conversacion.direccion);
    await saveConversation(services.db, conversacion, {
      state: 'documento',
      draft: draftParaFlujo('nueva'),
      patientId: null,
      lastTicket: null,
      opciones: {},
    });
    await reply(services, conversacion, 'desvinculado_y_nueva', { paso }, stepButtons('documento'));
    return 'desvinculado_y_nueva';
  }

  await unlinkChatByDireccion(services.db, conversacion.canal, conversacion.direccion);
  await saveConversation(services.db, conversacion, {
    state: 'inicio',
    draft: emptyDraft(),
    patientId: null,
    lastTicket: null,
    opciones: {},
  });
  await reply(services, conversacion, 'desvinculado');
  return 'desvinculado';
};

/** Vuelve a enseñar la confirmación de desvinculación pendiente (con sus opciones). */
const mostrarConfirmacionDesvinculacion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
): Promise<void> => {
  const resumen =
    conversation.patientId === null
      ? null
      : await resumenPaciente(services, conversation.patientId);
  if (draft.pendingUnlink === 'desvincular_y_nueva') {
    await reply(services, conversacion, 'desvincular_y_nueva', {}, [
      { etiqueta: 'Sí, desvincular y registrar', accion: 'desvincular_y_nueva:si' },
      { etiqueta: 'No, mantener vínculo', accion: 'desvincular_y_nueva:no' },
    ]);
    return;
  }
  await reply(
    services,
    conversacion,
    'confirmar_desvinculacion',
    {
      paciente: resumen?.fullName ?? 'el paciente vinculado',
      documento: resumen === null ? '••••' : maskDocument(resumen.docType, resumen.docNumber),
    },
    [
      { etiqueta: 'Sí, desvincular este chat', accion: 'desvincular:si' },
      { etiqueta: 'No, mantener vínculo', accion: 'desvincular:no' },
    ],
  );
};

/* ── Verificación ligera de identidad (v1.2, §4.2) ─────────────────────────── */

/** Repite la petición de verificación con el nombre abreviado y el documento enmascarado. */
const mostrarVerificacion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
): Promise<void> => {
  const candidato =
    conversation.patientId === null
      ? null
      : await resumenPaciente(services, conversation.patientId);
  if (candidato === null) {
    await reply(services, conversacion, 'servicio_no_disponible');
    return;
  }
  await reply(
    services,
    conversacion,
    'pedir_verificacion',
    {
      paciente: abbreviateName(candidato.fullName),
      documento: maskDocument(candidato.docType, candidato.docNumber),
    },
    [{ etiqueta: 'No es mi documento', accion: 'verificar:no' }],
  );
};

/** «No es mi documento»: se suelta el candidato y se vuelve al Paso 1 conservando el flujo. */
const rechazarDocumento = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
): Promise<void> => {
  await saveConversation(services.db, conversacion, {
    state: 'documento',
    draft: { ...draft, editingSingleField: false, verifyAttempts: 0 },
    patientId: null,
  });
  await askStep(services, conversacion, 'documento');
};

/**
 * Un intento de verificación de identidad. Acierta con la fecha de nacimiento o con
 * los últimos 4 dígitos del teléfono registrado; a los 3 fallos se suelta el
 * candidato y se sugiere pedir un código de vinculación en el consultorio.
 */
const intentarVerificacionIdentidad = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
  texto: string,
): Promise<string> => {
  const candidato =
    conversation.patientId === null
      ? null
      : await resumenPaciente(services, conversation.patientId);
  if (candidato === null) {
    // El servicio de pacientes no respondió: se conserva el estado y no se gasta intento.
    await reply(services, conversacion, 'servicio_no_disponible');
    return 'servicio_no_disponible';
  }

  if (!coincideVerificacion(texto, candidato)) {
    const intentos = draft.verifyAttempts + 1;
    if (intentos >= 3) {
      await saveConversation(services.db, conversacion, {
        state: 'inicio',
        draft: emptyDraft(),
        patientId: null,
        lastTicket: null,
      });
      await reply(services, conversacion, 'verificacion_agotada', {
        paciente: candidato.fullName,
      });
      return 'verificacion_agotada';
    }
    await saveConversation(services.db, conversacion, {
      state: 'verificar_identidad',
      draft: { ...draft, verifyAttempts: intentos },
      patientId: candidato.id,
    });
    await reply(services, conversacion, 'verificacion_fallida', {
      intentos: String(3 - intentos),
    });
    return 'verificacion_fallida';
  }

  // Acierto: se vincula **este** chat al candidato sin tocar sus otros chats.
  await linkChat(services.db, {
    patientId: candidato.id,
    canal: conversacion.canal,
    direccion: conversacion.direccion,
  });

  if (draft.flow === 'vincular') {
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: candidato.id,
      lastTicket: null,
    });
    await reply(services, conversacion, 'vinculado', { paciente: candidato.fullName });
    return 'vinculado';
  }

  const activa = await solicitudActivaDePaciente(services, candidato.id);
  const reutilizable = activa !== null && esSolicitudReutilizable(activa);
  if (activa !== null && !reutilizable) {
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: candidato.id,
      lastTicket: activa.ticketNumber,
    });
    await reply(services, conversacion, 'solicitud_en_curso', { ticket: activa.ticket });
    return 'solicitud_en_curso';
  }

  await saveConversation(services.db, conversacion, {
    state: 'motivo',
    draft: { ...draftFromPatient(candidato), reason: draft.reason },
    patientId: candidato.id,
    lastTicket: reutilizable && activa !== null ? activa.ticketNumber : conversation.lastTicket,
  });
  await askStep(services, conversacion, 'motivo');
  return 'verificacion_ok';
};

/* ── Menú de corrección (v1.2) ─────────────────────────────────────────────── */

/** Menú de corrección en un solo salto (paciente nuevo: todos los campos; existente: solo motivo). */
const mostrarMenuCorreccion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
): Promise<void> => {
  const pacienteExistente = conversation.patientId !== null;
  const botones: OutboundButton[] = pacienteExistente
    ? [
        { etiqueta: 'Motivo de la consulta', accion: 'corregir:motivo' },
        { etiqueta: 'Cambiar de cédula', accion: 'corregir:todo' },
        { etiqueta: 'Volver al resumen', accion: 'corregir:volver' },
      ]
    : [
        { etiqueta: 'Cédula o documento', accion: 'corregir:documento' },
        { etiqueta: 'Nombre completo', accion: 'corregir:nombre' },
        { etiqueta: 'Teléfono', accion: 'corregir:telefono' },
        { etiqueta: 'Fecha de nacimiento', accion: 'corregir:nacimiento' },
        ...(draft.birthDate !== null && isMinor(draft.birthDate)
          ? [{ etiqueta: 'Representante', accion: 'corregir:representante' }]
          : []),
        { etiqueta: 'Sexo', accion: 'corregir:sexo' },
        { etiqueta: 'Motivo de la consulta', accion: 'corregir:motivo' },
        { etiqueta: 'Corregir todo desde el inicio', accion: 'corregir:todo' },
        { etiqueta: 'Volver al resumen', accion: 'corregir:volver' },
      ];
  await saveConversation(services.db, conversacion, {
    state: 'corregir_menu',
    draft: { ...draft, editingSingleField: false },
  });
  await reply(services, conversacion, 'corregir_menu', {}, botones);
};

/** Aplica la corrección elegida: un campo (vuelve al resumen), todo o volver. */
const aplicarCorreccion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
  campo: string,
): Promise<string | null> => {
  if (campo === 'volver') {
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...draft, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, draft);
    return 'corregir_volver';
  }

  if (campo === 'todo') {
    // Empezar de cero: también se suelta la ficha elegida (si venía de una existente).
    await saveConversation(services.db, conversacion, {
      state: 'documento',
      draft: draftParaFlujo('nueva'),
      patientId: null,
      lastTicket: null,
    });
    await askStep(services, conversacion, 'documento');
    return 'corregir_todo';
  }

  switch (campo) {
    case 'representante': {
      if (draft.birthDate === null || !isMinor(draft.birthDate)) {
        await mostrarMenuCorreccion(services, conversacion, conversation, draft);
        return 'corregir_menu';
      }
      await saveConversation(services.db, conversacion, {
        state: 'representante',
        draft: { ...draft, editingSingleField: true },
      });
      await askRepresentante(services, conversacion, draft);
      return 'corregir_representante';
    }
    case 'documento':
    case 'nombre':
    case 'telefono':
    case 'nacimiento':
    case 'sexo':
    case 'motivo': {
      await saveConversation(services.db, conversacion, {
        state: campo,
        draft: { ...draft, editingSingleField: true },
      });
      await askStep(services, conversacion, campo);
      return `corregir_${campo}`;
    }
    default:
      return null;
  }
};

/* ── Navegación del flujo: «volver» y «salir» (v1.2, §2.3) ─────────────────── */

/**
 * Atiende «volver» (retrocede un paso conservando el borrador) y «salir» (aborta el
 * proceso). Al salir, un chat **vinculado** conserva su ficha; solo se limpia el
 * borrador a medias.
 */
const navegarFlujo = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
  nav: FlowNavigation,
): Promise<void> => {
  if (nav === 'salir') {
    const vinculado = await channelByDireccion(
      services.db,
      conversacion.canal,
      conversacion.direccion,
    );
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: vinculado?.patientId ?? null,
      opciones: {},
    });
    await reply(services, conversacion, 'proceso_cancelado');
    return;
  }

  switch (conversation.state) {
    case 'verificar_identidad':
      await rechazarDocumento(services, conversacion, draft);
      return;
    case 'confirmar_desvinculacion':
      // «Volver» aquí es «no desvincular».
      await mantenerVinculo(services, conversacion, conversation);
      return;
    case 'corregir_menu':
      await saveConversation(services.db, conversacion, {
        state: 'confirmacion',
        draft: { ...draft, editingSingleField: false },
      });
      await mostrarResumen(services, conversacion, draft);
      return;
    case 'confirmacion':
      // El paso anterior del resumen es el motivo.
      await saveConversation(services.db, conversacion, { state: 'motivo', draft });
      await askStep(services, conversacion, 'motivo');
      return;
    default:
      break;
  }

  if (draft.editingSingleField) {
    // Si solo se estaba corrigiendo un dato, «volver» cancela la edición.
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...draft, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, draft);
    return;
  }

  const anterior = estadoAnterior(conversation.state, draft);
  if (anterior === null) {
    await reply(services, conversacion, 'proceso_cancelado');
    return;
  }
  await saveConversation(services.db, conversacion, { state: anterior, draft });
  if (anterior === 'representante') await askRepresentante(services, conversacion, draft);
  else await askStep(services, conversacion, anterior);
};

/**
 * Repite el paso en el que está la conversación, sin avanzar. Se usa cuando llega un
 * mensaje sin texto (audio, sticker) y cuando un servicio interno falla.
 */
const repetirPasoActual = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
): Promise<string | null> => {
  const estado = conversation.state;
  if (
    estado === 'documento' ||
    estado === 'nombre' ||
    estado === 'telefono' ||
    estado === 'nacimiento' ||
    estado === 'sexo' ||
    estado === 'motivo'
  ) {
    await askStep(services, conversacion, estado);
    return `paso_${estado}`;
  }

  switch (estado) {
    case 'representante':
      await askRepresentante(services, conversacion, draft);
      return 'paso_representante';
    case 'confirmacion':
      await mostrarResumen(services, conversacion, draft);
      return 'paso_confirmacion';
    case 'verificar_identidad':
      await mostrarVerificacion(services, conversacion, conversation);
      return 'paso_verificar_identidad';
    case 'confirmar_desvinculacion':
      await mostrarConfirmacionDesvinculacion(services, conversacion, conversation, draft);
      return 'paso_confirmar_desvinculacion';
    case 'corregir_menu':
      await mostrarMenuCorreccion(services, conversacion, conversation, draft);
      return 'paso_corregir_menu';
    default:
      return null;
  }
};

/** Aplica el sexo elegido (letra escrita o acción `sexo:*`). */
const aplicarSexo = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  sex: 'M' | 'F' | 'O',
): Promise<void> => {
  const next: BotDraft = { ...draft, sex };
  if (next.editingSingleField) {
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...next, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, next);
    return;
  }
  await saveConversation(services.db, conversacion, { state: 'motivo', draft: next });
  await askStep(services, conversacion, 'motivo');
};

/** «Cancelar» sin argumento: primero la cita; si no hay, la solicitud (ADR 0053). */
const cancelarCitaOSolicitud = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
): Promise<string> => {
  const resultado = await cancelarCita(services, conversacion, null, { avisarSinCitas: false });
  if (resultado !== 'sin_citas') return `cancelar_cita_${resultado}`;
  await cancelRequest(services, conversacion, ticketDe(conversation));
  return 'cancelar';
};

/* ── Despacho de acciones e intenciones ────────────────────────────────────── */

const despacharMenu = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  value: string,
): Promise<string | null> => {
  switch (value) {
    case 'nueva':
      return iniciarNueva(services, conversacion);
    case 'estado':
      await showStatus(services, conversacion, ticketDe(conversation));
      return 'menu_estado';
    case 'confirmar': {
      const resultado = await confirmarCita(services, conversacion, null);
      return `confirmar_${resultado}`;
    }
    case 'cancelar':
      return cancelarCitaOSolicitud(services, conversacion, conversation);
    case 'desvincular':
      return preguntarDesvinculacion(services, conversacion);
    default:
      return null;
  }
};

/** Ejecuta una acción de botón u opción numerada. `null` si no se reconoce. */
const despacharAccion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  draft: BotDraft,
  kind: string,
  value: string,
): Promise<string | null> => {
  switch (kind) {
    case 'doc': {
      if (!['V', 'E', 'P', 'SC'].includes(value)) return null;
      const type = value as DocType;
      await saveConversation(services.db, conversacion, { draft: { ...draft, docType: type } });
      await enviar(
        services,
        conversacion,
        `${DOC_TYPE_LABEL[type]} (${type}): escríbeme el número, por ejemplo ${DOC_TYPE_EXAMPLE[type]}.`,
      );
      return 'documento_tipo';
    }
    case 'sexo': {
      if (!['M', 'F', 'O'].includes(value)) return null;
      await aplicarSexo(services, conversacion, draft, value as 'M' | 'F' | 'O');
      return 'sexo';
    }
    case 'confirmar': {
      if (value === 'si') {
        await finalize(
          services,
          conversacion,
          draft,
          conversation.patientId,
          conversation.lastTicket,
        );
        return 'solicitud_creada';
      }
      if (value !== 'no') return null;
      await mostrarMenuCorreccion(services, conversacion, conversation, draft);
      return 'corregir';
    }
    case 'verificar': {
      if (value !== 'no') return null;
      await rechazarDocumento(services, conversacion, draft);
      return 'verificar_no';
    }
    case 'desvincular': {
      if (value === 'si') return desvincularChat(services, conversacion, false);
      if (value !== 'no') return null;
      await mantenerVinculo(services, conversacion, conversation);
      return 'desvinculacion_cancelada';
    }
    case 'desvincular_y_nueva': {
      if (value === 'si') return desvincularChat(services, conversacion, true);
      if (value !== 'no') return null;
      await mantenerVinculo(services, conversacion, conversation);
      return 'desvinculacion_cancelada';
    }
    case 'cita_para': {
      if (value === 'yo') return citaParaYo(services, conversacion, conversation, draft);
      if (value === 'otro') return citaParaOtro(services, conversacion, draft);
      return null;
    }
    case 'corregir':
      return aplicarCorreccion(services, conversacion, conversation, draft, value);
    case 'menu':
      return despacharMenu(services, conversacion, conversation, value);
    case 'confirmar_cita': {
      const resultado = await confirmarCita(services, conversacion, value === '' ? null : value);
      return `confirmar_${resultado}`;
    }
    case 'cancelar_cita': {
      const resultado = await cancelarCita(services, conversacion, value === '' ? null : value);
      return `cancelar_cita_${resultado}`;
    }
    default:
      return null;
  }
};

/** Ejecuta una intención detectada en el texto. `null` si no la reconoce. */
const despacharIntencion = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  conversation: BotConversationRow,
  detectada: ReturnType<typeof detectIntent>,
  usuario: string | null,
): Promise<string | null> => {
  switch (detectada.intencion) {
    case 'start': {
      if (detectada.argumento !== '') {
        const linked = await linkByCode(services, conversacion, detectada.argumento, usuario);
        return linked ? 'vinculado' : 'codigo_invalido';
      }
      await saveConversation(services.db, conversacion, { state: 'inicio', draft: emptyDraft() });
      await mostrarBienvenida(services, conversacion);
      return 'start';
    }
    case 'ayuda':
      await mostrarAyuda(services, conversacion);
      return 'ayuda';
    case 'estado':
      await showStatus(
        services,
        conversacion,
        detectada.argumento !== '' ? detectada.argumento : ticketDe(conversation),
      );
      return 'estado';
    case 'mi_ticket':
      await showStatus(services, conversacion, ticketDe(conversation));
      return 'mi_ticket';
    case 'cancelar':
      if (detectada.argumento !== '') {
        await cancelRequest(services, conversacion, detectada.argumento);
        return 'cancelar';
      }
      return cancelarCitaOSolicitud(services, conversacion, conversation);
    case 'confirmar': {
      const resultado = await confirmarCita(services, conversacion, null);
      return `confirmar_${resultado}`;
    }
    case 'nueva':
      return iniciarNueva(services, conversacion);
    case 'desvincular':
      return preguntarDesvinculacion(services, conversacion);
    case 'vincular': {
      if (detectada.argumento !== '') {
        const linked = await linkByCode(services, conversacion, detectada.argumento, usuario);
        return linked ? 'vinculado' : 'codigo_invalido';
      }
      const vinculado = await channelByDireccion(
        services.db,
        conversacion.canal,
        conversacion.direccion,
      );
      if (vinculado !== null) {
        const resumen = await resumenPaciente(services, vinculado.patientId);
        await saveConversation(services.db, conversacion, {
          state: 'inicio',
          draft: emptyDraft(),
          patientId: vinculado.patientId,
        });
        await reply(services, conversacion, 'ya_vinculado', {
          paciente: resumen?.fullName ?? 'este paciente',
        });
        return 'ya_vinculado';
      }
      await saveConversation(services.db, conversacion, {
        state: 'documento',
        draft: draftParaFlujo('vincular'),
        patientId: null,
        lastTicket: null,
      });
      await askStep(services, conversacion, 'documento');
      return 'vincular';
    }
    default:
      return null;
  }
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

const describeRequest = (request: RequestSummary): string =>
  request.appointmentDate === null
    ? 'Todavía estamos buscándole fecha y hora; te avisaremos por aquí.'
    : `Tu cita es el ${fechaVe(request.appointmentDate)} a las ${request.appointmentTime ?? ''}.`;

/**
 * La **última cita cancelada** de una solicitud que volvió a la cola. Es lo que
 * permite que el bot no siga hablando de una cita que la secretaría canceló en la
 * agenda: el resumen de la solicitud ya no la muestra como cita vigente, pero el
 * paciente merece saber qué pasó con ella.
 */
const citaCanceladaDeLaSolicitud = async (
  services: AsistenteServices,
  patientId: string,
  requestId: string,
): Promise<AppointmentSummary | null> => {
  const { from, to } = ventanaDeCitas();
  const pagina = await services.clients.listAppointments({
    patientId,
    from,
    to,
    pageSize: 50,
  });
  const canceladas = pagina.items.filter(
    (cita) => cita.requestId === requestId && cita.status === 'cancelada',
  );
  return (
    canceladas.sort((a, b) =>
      (b.cancelledAt ?? b.updatedAt).localeCompare(a.cancelledAt ?? a.updatedAt),
    )[0] ?? null
  );
};

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

  let cita = describeRequest(found);
  if (found.status === 'en_espera_cita') {
    const cancelada = await citaCanceladaDeLaSolicitud(services, found.patientId, found.id);
    if (cancelada !== null) {
      cita = `La cita del ${fechaVe(cancelada.date)} a las ${formatTime12h(
        cancelada.startTime,
      )} quedó cancelada. ${cita}`;
    }
  }

  await reply(services, conversacion, 'estado_solicitud', {
    ticket: found.ticket,
    estado: estadoDe(found.status),
    cita,
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
    conversacion.canal,
  );
  await reply(services, conversacion, 'estado_solicitud', {
    ticket: cancelled.ticket,
    estado: estadoDe(cancelled.status),
    cita: 'Tu solicitud quedó anulada. Cuando quieras otra, escríbeme «nueva».',
  });
};

/* ── Pasos del asistente ───────────────────────────────────────────────────── */

/* ── Confirmar la cita (ADR 0052) ──────────────────────────────────────────── */

const responderConfirmada = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
): Promise<void> => {
  await reply(services, conversacion, 'cita_confirmada_paciente', {
    paciente: cita.patientName,
    fecha: fechaVe(cita.date),
    hora: formatTime12h(cita.startTime),
    lugar: services.config.CLINIC_ADDRESS ?? '',
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
  | 'cancelada'
  | 'ya_estaba'
  | 'elegir'
  | 'sin_citas'
  | 'no_es_suya'
  | 'no_cancelable'
  /** Confirmó, pero le quedan menos días que el corte de la clínica (ADR 0057). */
  | 'bloqueada';

/** Días de calendario entre dos fechas `AAAA-MM-DD` (negativo si ya pasó). */
const diasHasta = (date: string, hoy: string): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);

/**
 * ¿El **corte** de la clínica impide cancelar esta cita por el bot? (ADR 0057)
 *
 * Solo aplica a las citas que el paciente **ya confirmó** y cuando la clínica fijó un
 * corte (`> 0`): con el corte en 0 no hay guardia. Se bloquea cuando a la cita le
 * faltan **esos días o menos**, para que el consultorio tenga tiempo de reaccionar.
 * Las citas sin confirmar nunca se bloquean (el paciente no había prometido nada).
 */
const bloqueadaPorCorte = (cita: AppointmentSummary, corteDias: number, hoy: string): boolean =>
  corteDias > 0 && cita.status === 'confirmada' && diasHasta(cita.date, hoy) <= corteDias;

/** Responde que esa cancelación ya no se puede hacer por chat: hay que llamar. */
const responderFueraDePlazo = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  cita: AppointmentSummary,
  dias: number,
): Promise<void> => {
  await reply(services, conversacion, 'cita_cancelacion_fuera_de_plazo', {
    paciente: cita.patientName,
    fecha: fechaVe(cita.date),
    dias: String(dias),
  });
};

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

  // Política de la clínica (ADR 0057): el corte solo frena a las citas **confirmadas**.
  const ajustes = await getNotificationSettings(services.db);
  const corteDias = ajustes.patientCancelCutoffDays;
  const hoy = todayInClinic();

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
    // Ya confirmó y le quedan pocos días: por chat no se cancela, hay que llamar.
    if (bloqueadaPorCorte(suya, corteDias, hoy)) {
      await responderFueraDePlazo(services, conversacion, suya, corteDias);
      return 'bloqueada';
    }
    return (await cancelarYResponder(services, conversacion, suya)) ? 'cancelada' : 'ya_estaba';
  }

  // Las que el paciente todavía puede cancelar por aquí: las que no han llegado al
  // consultorio. La lista es **la misma** que aplica la agenda (`CANCELLABLE_STATUSES`).
  const cancelables = citas.filter((cita) => CANCELLABLE_STATUSES.includes(cita.status));
  // Y, de esas, las que el corte de la clínica no bloquea (ADR 0057): las confirmadas
  // que ya están dentro del plazo mínimo se ofrecen igualmente por chat.
  const permitidas = cancelables.filter((cita) => !bloqueadaPorCorte(cita, corteDias, hoy));

  if (permitidas.length === 0) {
    // Si lo único que había era una cita confirmada dentro del corte, se le dice por qué.
    const bloqueada = cancelables.find((cita) => bloqueadaPorCorte(cita, corteDias, hoy));
    if (bloqueada !== undefined) {
      await responderFueraDePlazo(services, conversacion, bloqueada, corteDias);
      return 'bloqueada';
    }
    const yaCancelada = citas.find((cita) => cita.status === 'cancelada');
    if (yaCancelada !== undefined) {
      await responderCancelada(services, conversacion, yaCancelada);
      return 'ya_estaba';
    }
    return sinNada();
  }

  if (permitidas.length === 1) {
    const unica = permitidas[0];
    if (unica !== undefined) {
      return (await cancelarYResponder(services, conversacion, unica)) ? 'cancelada' : 'ya_estaba';
    }
  }

  await enviar(
    services,
    conversacion,
    'Tienes varias citas próximas. Dime cuál quieres cancelar.',
    permitidas.map((cita) => ({
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
    // v1.2: error + re-pregunta en **una sola** burbuja.
    await askStep(services, conversacion, 'nombre', {
      motivo: name.message ?? 'Escribe tu nombre completo.',
    });
    return;
  }

  const next: BotDraft = { ...draft, fullName: name.value };
  if (next.editingSingleField) {
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...next, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, next);
    return;
  }
  await saveConversation(services.db, conversacion, { state: 'telefono', draft: next });
  await askStep(services, conversacion, 'telefono');
};

/**
 * Paso 1 (v1.2): cédula o documento. Acepta tipo+numero igual que antes y, en
 * cuanto el documento existe en la base, decide el camino:
 *  - este chat ya está vinculado a esa ficha → motivo (o `ya_vinculado` si solo quería vincularse);
 *  - este chat no lo está → verificación ligera de identidad antes de vincularlo;
 *  - no existe → sigue el alta por el nombre (Paso 2).
 */
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
    await askStep(services, conversacion, 'documento', {
      motivo: 'Primero elige el tipo de documento (V, E, P o SC) y luego me escribes el número.',
    });
    return;
  }

  const validation = validateDocument(type, number);
  if (!validation.ok) {
    await askStep(services, conversacion, 'documento', {
      motivo: validation.message ?? 'Revisa el documento.',
    });
    return;
  }

  const existing = await services.clients.findPatientByDocument(type, number);
  if (existing !== null) {
    const vinculado = await channelByDireccion(
      services.db,
      conversacion.canal,
      conversacion.direccion,
    );

    if (vinculado !== null && vinculado.patientId === existing.id) {
      if (draft.flow === 'vincular') {
        await saveConversation(services.db, conversacion, {
          state: 'inicio',
          draft: emptyDraft(),
          patientId: existing.id,
        });
        await reply(services, conversacion, 'ya_vinculado', { paciente: existing.fullName });
        return;
      }
      // Ya es su ficha: se saltan los datos demográficos y se va al motivo (Paso 6).
      const conFicha: BotDraft = { ...draftFromPatient(existing), reason: draft.reason };
      await saveConversation(services.db, conversacion, {
        state: 'motivo',
        draft: conFicha,
        patientId: existing.id,
      });
      await askStep(services, conversacion, 'motivo');
      return;
    }

    // El chat **no** está vinculado a esa ficha (2.º chat): verificación de identidad
    // antes de enlazarlo. Se guarda el candidato para no volver a pedir el documento.
    await saveConversation(services.db, conversacion, {
      state: 'verificar_identidad',
      draft: {
        ...draft,
        docType: type,
        docNumber: number,
        editingSingleField: false,
        verifyAttempts: 0,
      },
      patientId: existing.id,
    });
    await reply(
      services,
      conversacion,
      'pedir_verificacion',
      {
        paciente: abbreviateName(existing.fullName),
        documento: maskDocument(existing.docType, existing.docNumber),
      },
      [{ etiqueta: 'No es mi documento', accion: 'verificar:no' }],
    );
    return;
  }

  const next: BotDraft = { ...draft, docType: type, docNumber: number };

  if (draft.flow === 'vincular') {
    // Solo quería vincular su ficha y el documento no existe: no se da de alta.
    await saveConversation(services.db, conversacion, {
      state: 'inicio',
      draft: emptyDraft(),
      patientId: null,
    });
    await reply(services, conversacion, 'vincular_no_encontrado');
    return;
  }

  if (draft.editingSingleField) {
    // Corregir el documento desde el resumen: vuelve directo a la confirmación.
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...next, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, next);
    return;
  }

  await saveConversation(services.db, conversacion, { state: 'nombre', draft: next });
  await askStep(services, conversacion, 'nombre');
};

const handlePhone = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const phone = normalizePhone(text);
  if (!/^\+58\d{10}$/.test(phone)) {
    await askStep(services, conversacion, 'telefono', {
      motivo: 'Ese teléfono no me sirve: escríbelo con 11 dígitos, por ejemplo 0412-1234567.',
    });
    return;
  }

  const next: BotDraft = { ...draft, phone };
  if (next.editingSingleField) {
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...next, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, next);
    return;
  }
  await saveConversation(services.db, conversacion, { state: 'nacimiento', draft: next });
  await askStep(services, conversacion, 'nacimiento');
};

/**
 * Paso 4: fecha de nacimiento. Si es menor se pide el representante; al corregir un
 * solo campo (v1.2) se vuelve directo al resumen, salvo que pase a menor y aún no
 * tenga representante (se pide y se mantiene `editingSingleField`).
 */
const handleBirthDate = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const parsed = parseBotDate(text);
  if (!parsed.ok || parsed.value === undefined) {
    await askStep(services, conversacion, 'nacimiento', {
      motivo: parsed.message ?? 'Revisa la fecha.',
    });
    return;
  }

  const next: BotDraft = { ...draft, birthDate: parsed.value };
  const menor = isMinor(parsed.value);

  if (next.editingSingleField) {
    if (menor && next.guardianName === null) {
      await saveConversation(services.db, conversacion, { state: 'representante', draft: next });
      await askRepresentante(services, conversacion, next);
      return;
    }
    // Si pasa a adulto, el representante que hubiera deja de tener sentido.
    const corregido: BotDraft = menor
      ? next
      : { ...next, guardianName: null, guardianDocType: null, guardianDocNumber: null };
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...corregido, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, corregido);
    return;
  }

  if (menor) {
    await saveConversation(services.db, conversacion, { state: 'representante', draft: next });
    await askRepresentante(services, conversacion, next);
    return;
  }

  await saveConversation(services.db, conversacion, {
    state: 'sexo',
    draft: { ...next, guardianName: null, guardianDocType: null, guardianDocNumber: null },
  });
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
    await askRepresentante(
      services,
      conversacion,
      draft,
      name.message ?? 'Escribe el nombre del representante.',
    );
    return;
  }

  const next: BotDraft = { ...draft, guardianName: name.value };
  if (next.editingSingleField) {
    // Venía de corregir la fecha a menor: al completar el representante, al resumen.
    await saveConversation(services.db, conversacion, {
      state: 'confirmacion',
      draft: { ...next, editingSingleField: false },
    });
    await mostrarResumen(services, conversacion, next);
    return;
  }
  await saveConversation(services.db, conversacion, { state: 'sexo', draft: next });
  await askStep(services, conversacion, 'sexo');
};

/**
 * El paso del sexo se puede responder con la **letra** (M/F/O), no solo con el
 * número de la opción. En WhatsApp las opciones llegan numeradas y mucha gente
 * escribe la letra que ve en el botón de Telegram o en la ficha del paciente.
 *
 * Se aceptan las palabras completas para que no haya que adivinar: «masculino»,
 * «femenino», «otro». La comparación ignora mayúsculas, tildes y puntuación.
 */
const SEXO_POR_TEXTO: Readonly<Record<string, 'M' | 'F' | 'O'>> = {
  m: 'M',
  masculino: 'M',
  hombre: 'M',
  f: 'F',
  femenino: 'F',
  mujer: 'F',
  o: 'O',
  otro: 'O',
  otra: 'O',
};

export const sexoDesdeTexto = (texto: string): 'M' | 'F' | 'O' | null =>
  SEXO_POR_TEXTO[normalizePhrase(texto)] ?? null;

/**
 * El paso final del alta se puede responder con palabras, no solo con el
 * número de la opción: «confirmar» / «sí» o «corregir» / «no». Se resuelve
 * **antes** de `detectIntent` porque «confirmar» también es la intención de
 * confirmar una cita ya agendada (ADR 0052): en el estado `confirmacion` manda
 * el alta.
 */
const CONFIRMAR_POR_TEXTO: ReadonlySet<string> = new Set([
  'confirmar',
  'confirmo',
  'confirmado',
  'si',
  '1',
  'correcto',
  'todo bien',
  'si todo bien',
  'esta bien',
  'estan bien',
  'ok',
]);

const CORREGIR_POR_TEXTO: ReadonlySet<string> = new Set([
  'corregir',
  'corrijo',
  'corrige',
  'no',
  '2',
  'incorrecto',
  'mal',
  'cambiar',
]);

export const confirmacionDesdeTexto = (texto: string): 'si' | 'no' | null => {
  const clave = normalizePhrase(texto);
  if (CONFIRMAR_POR_TEXTO.has(clave)) return 'si';
  if (CORREGIR_POR_TEXTO.has(clave)) return 'no';
  return null;
};

const handleSex = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const sex = sexoDesdeTexto(text);
  if (sex === null) {
    await askStep(services, conversacion, 'sexo', {
      motivo:
        'Escribe M (masculino), F (femenino) u O (otro); también puedes responder el número de la opción.',
    });
    return;
  }
  await aplicarSexo(services, conversacion, draft, sex);
};

const handleReason = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const reason = cleanText(text);
  if (reason.length < 5 || reason.length > 500) {
    await askStep(services, conversacion, 'motivo', {
      motivo:
        'Cuéntame un poco más (entre 5 y 500 caracteres) para que el consultorio sepa qué necesitas.',
    });
    return;
  }

  const next: BotDraft = { ...draft, reason, editingSingleField: false };
  await saveConversation(services.db, conversacion, { state: 'confirmacion', draft: next });
  await mostrarResumen(services, conversacion, next);
};

/** Crea (o reutiliza) el paciente y su solicitud, y responde con el ticket. */
const finalize = async (
  services: AsistenteServices,
  conversacion: Conversacion,
  draft: BotDraft,
  patientId: string | null,
  lastTicket: number | null,
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
    // v1.2: el alta empieza por el documento (Paso 1), no por el nombre, y el aviso
    // viaja en la misma burbuja que la pregunta.
    await saveConversation(services.db, conversacion, {
      state: 'documento',
      draft: draftParaFlujo('nueva'),
      opciones: {},
    });
    await askStep(services, conversacion, 'documento', {
      motivo: 'Me falta algún dato. Escribamos la solicitud otra vez.',
    });
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

  /**
   * Si esta conversación venía de una solicitud **en espera sin cita vigente**
   * (el caso típico: el paciente canceló la cita y volvió a la cola), se
   * reutiliza su ticket y solo se actualiza el motivo. Crear otra solicitud
   * dejaría dos tickets para la misma persona y perdería la antigüedad.
   *
   * v1.2: si este chat no la conoce (`lastTicket` nulo, p. ej. el 2.º chat del
   * paciente o una verificación de identidad), se busca por **paciente**: el
   * ticket no puede depender de en qué chat se creó.
   */
  const anteriorPorTicket =
    lastTicket === null
      ? null
      : await services.clients.findRequestByTicket(formatTicket(lastTicket).value);
  const reutilizable = (solicitud: RequestSummary | null): solicitud is RequestSummary =>
    solicitud !== null &&
    esSolicitudReutilizable(solicitud) &&
    solicitud.patientId === patient.patient.id;
  const anterior = reutilizable(anteriorPorTicket)
    ? anteriorPorTicket
    : await solicitudReutilizableDePaciente(services, patient.patient.id);

  let summary: RequestSummary;
  if (anterior !== null) {
    summary = await services.clients.updateRequestReason(anterior.id, draft.reason);
  } else {
    summary = await services.clients.createRequest({
      patientId: patient.patient.id,
      patientName: draft.fullName,
      patientDocument: `${draft.docType}-${draft.docNumber}`,
      patientPhone: draft.phone,
      channel: canal,
      reason: draft.reason,
      notes: `Solicitud tomada por el asistente (${canal})`,
    });
  }

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
 * `(canal, eventoId)`: el mismo `update_id`, `key.id` o `wamid` no crea dos tickets. La
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

  // Idempotencia por evento del canal, antes de tocar nada más.
  const claimed = await services.db
    .insert(processedUpdates)
    .values({ canal: entrante.canal, eventoId: entrante.eventoId, direccion: entrante.direccion })
    .onConflictDoNothing({ target: [processedUpdates.canal, processedUpdates.eventoId] })
    .returning({ eventoId: processedUpdates.eventoId });

  if (claimed.length === 0) {
    return { ...conversacion, handled: false, action: 'duplicado' };
  }

  let conversation = await loadConversation(
    services.db,
    entrante.canal,
    entrante.direccion,
    entrante.usuario,
  );

  // v1.2: con varios chats por paciente, cada mensaje actualiza la actividad de su
  // vínculo (`last_inbound_at`), que desempata el destino de los avisos.
  await touchInbound(services.db, entrante.canal, entrante.direccion);

  if (await isFlooding(services, conversation)) {
    return { ...conversacion, handled: false, action: 'anti_flood' };
  }

  /**
   * Si la conversación recuerda a un paciente pero el chat ya no está vinculado
   * (desvinculación de una versión anterior o cambio de número del bot), se
   * empieza de cero. Sin esto, el `lastTicket` y el `patientId` viejos seguían
   * bloqueando el alta como «ya tienes una solicitud en curso».
   *
   * No se dispara a mitad del alta (p. ej. al verificar la identidad del candidato)
   * porque ahí el `patientId` es **provisional** y el vínculo se crea al acertar:
   * solo cuenta un ticket ya emitido o una conversación en `inicio` que venía de un
   * vínculo por código.
   */
  const recuerdaPaciente =
    conversation.lastTicket !== null ||
    (conversation.patientId !== null && conversation.state === 'inicio');
  if (recuerdaPaciente) {
    const vinculado = await channelByDireccion(services.db, entrante.canal, entrante.direccion);
    if (vinculado === null) {
      await saveConversation(services.db, conversacion, {
        state: 'inicio',
        draft: emptyDraft(),
        patientId: null,
        lastTicket: null,
        opciones: {},
      });
      conversation = {
        ...conversation,
        state: 'inicio',
        draft: {},
        patientId: null,
        lastTicket: null,
        opciones: {},
      };
    }
  }

  const adapter = services.canales.get(entrante.canal);
  const capacidades = adapter?.capacidades ?? {
    botones: false,
    documentos: false,
    comandos: false,
    plantillasAprobadas: false,
  };
  const draft = toDraft(conversation);

  /**
   * **Mensaje sin texto** (D11): un audio, una foto sin pie o un sticker. No se
   * inventa una transcripción: si el paciente está a mitad de un paso se le repite
   * el paso (también en los estados nuevos de v1.2) para que sepa qué escribir. En
   * `inicio` no se contesta nada (un sticker suelto no merece una respuesta).
   */
  if (texto === '' && accion === '') {
    const repetido = await repetirPasoActual(services, conversacion, conversation, draft);
    if (repetido !== null) return { ...conversacion, handled: true, action: repetido };
    return { ...conversacion, handled: false, action: 'sin_texto' };
  }

  // Botón pulsado o número que responde a las opciones numeradas del último paso.
  let elegida =
    accion !== ''
      ? accion
      : resolveNumberedOption(texto, new Map(Object.entries(conversation.opciones)));

  // v1.2: «volver» / «salir» a mitad del flujo, **antes** de las intenciones. Si el
  // paciente está rellenando un paso, «cancelar proceso» no puede confundirse con la
  // intención de cancelar su cita.
  if (elegida === null && ESTADOS_NAVEGABLES.has(conversation.state)) {
    const nav = detectFlowNavigation(texto);
    if (nav !== null) {
      await navegarFlujo(services, conversacion, conversation, draft, nav);
      return {
        ...conversacion,
        handled: true,
        action: nav === 'salir' ? 'proceso_cancelado' : 'volver',
      };
    }
  }

  // «confirmar» / «corregir» en el resumen final. Se traduce a la misma acción que el
  // botón o el número para no duplicar el flujo.
  if (elegida === null && conversation.state === 'confirmacion') {
    const decision = confirmacionDesdeTexto(texto);
    if (decision !== null) elegida = `confirmar:${decision}`;
  }

  // «sí» / «no» escritos en la confirmación de desvinculación (v1.2).
  if (elegida === null && conversation.state === 'confirmar_desvinculacion') {
    const decision = confirmacionDesdeTexto(texto);
    if (decision !== null) {
      const prefijo =
        draft.pendingUnlink === 'desvincular_y_nueva' ? 'desvincular_y_nueva' : 'desvincular';
      elegida = `${prefijo}:${decision}`;
    }
  }

  // En el menú de corrección también valen las palabras («teléfono», «cédula», «todo»).
  if (elegida === null && conversation.state === 'corregir_menu') {
    const campo = corregirCampoDesdeTexto(texto, conversation.patientId !== null);
    if (campo !== null) elegida = `corregir:${campo}`;
  }

  if (elegida !== null) {
    const [kind = '', value = ''] = elegida.split(':');
    const action = await despacharAccion(services, conversacion, conversation, draft, kind, value);
    if (action === null) return { ...conversacion, handled: false };
    return { ...conversacion, handled: true, action };
  }

  // Intenciones: comandos con barra (Telegram) o frases naturales (WhatsApp).
  const detectada = detectIntent(texto, { comandos: capacidades.comandos });
  if (detectada.intencion !== null) {
    const action = await despacharIntencion(
      services,
      conversacion,
      conversation,
      detectada,
      entrante.usuario,
    );
    if (action !== null) return { ...conversacion, handled: true, action };
  }

  // Un comando que no existe: se ofrece la ayuda con el menú (solo en canales con comandos).
  if (detectada.comando) {
    await mostrarAyuda(services, conversacion);
    return { ...conversacion, handled: true, action: 'comando_desconocido' };
  }

  // Texto libre: si parece un ticket, se consulta su estado; si no, sigue el paso.
  const maybeTicket = parseTicket(texto);
  if (maybeTicket !== null && conversation.state === 'inicio') {
    await showStatus(services, conversacion, maybeTicket.value);
    return { ...conversacion, handled: true, action: 'estado_por_texto' };
  }

  switch (conversation.state) {
    case 'documento':
      await handleDocument(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_documento' };
    case 'nombre':
      await handleName(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_nombre' };
    case 'telefono':
      await handlePhone(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_telefono' };
    case 'nacimiento':
      await handleBirthDate(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_nacimiento' };
    case 'representante':
      await handleGuardian(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_representante' };
    case 'sexo':
      await handleSex(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_sexo' };
    case 'motivo':
      await handleReason(services, conversacion, draft, texto);
      return { ...conversacion, handled: true, action: 'paso_motivo' };
    case 'verificar_identidad': {
      const action = await intentarVerificacionIdentidad(
        services,
        conversacion,
        conversation,
        draft,
        texto,
      );
      return { ...conversacion, handled: true, action };
    }
    case 'confirmar_desvinculacion':
      // Texto que no es «sí» ni «no»: se repite la confirmación sin avanzar.
      await mostrarConfirmacionDesvinculacion(services, conversacion, conversation, draft);
      return { ...conversacion, handled: true, action: 'confirmar_desvinculacion' };
    case 'corregir_menu':
      await mostrarMenuCorreccion(services, conversacion, conversation, draft);
      return { ...conversacion, handled: true, action: 'corregir_menu' };
    case 'confirmacion':
      // Texto no reconocido con el resumen delante: se repite el resumen.
      await mostrarResumen(services, conversacion, draft);
      return { ...conversacion, handled: true, action: 'paso_confirmacion' };
    default: {
      await mostrarBienvenida(services, conversacion);
      return { ...conversacion, handled: true, action: 'bienvenida' };
    }
  }
};

/**
 * Vinculación por código: sirve para el deep link de Telegram
 * (`t.me/<bot>?start=<código>`) y para el enlace de WhatsApp
 * (`wa.me/<número>?text=VINCULAR%20<código>`). El paciente escribe
 * «vincular <código>» o «start <código>» (D13).
 *
 * v1.2: responde **una sola burbuja** (plantilla `vinculado` con el nombre del
 * paciente), en vez de la bienvenida y después el «Listo…».
 */
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
    draft: emptyDraft(),
    patientId: row.patientId,
  });

  const resumen = await resumenPaciente(services, row.patientId);
  if (resumen === null) {
    // Sin nombre no se puede rellenar la plantilla: el texto de siempre como respaldo.
    await enviar(
      services,
      conversacion,
      'Listo: quedaste vinculado con tu ficha del consultorio. Te avisaré por aquí cuando tu cita esté confirmada.',
    );
    return true;
  }
  await reply(services, conversacion, 'vinculado', { paciente: resumen.fullName });
  return true;
};

/* ── Cuando algo de fuera falla ────────────────────────────────────────────── */

/**
 * El paciente **nunca se queda sin respuesta**.
 *
 * El asistente habla con otros servicios (pacientes y agenda) y con la base; si uno
 * falla —un servicio reiniciándose, por ejemplo— el error subía hasta el bucle del
 * canal y ahí se quedaba: el mensaje se registraba en el log y la persona no recibía
 * nada, sin saber si esperar o volver a escribir. Pasó de verdad el 2026-10-04, con
 * `ECONNREFUSED 127.0.0.1:4002` a mitad del paso del documento.
 *
 * Ahora se avisa y se repite el paso —también los nuevos de v1.2: la verificación de
 * identidad, la confirmación de desvinculación y el menú de corrección—: la
 * conversación está en la base y el mensaje se puede reenviar tal cual. El error sigue
 * subiendo (el llamador lo registra) para que nadie lo confunda con un éxito.
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

  // Si estaba rellenando un paso (o en un estado nuevo del flujo), se le vuelve a
  // pedir para que sepa qué escribir.
  const draft = toDraft(conversation);
  await repetirPasoActual(services, conversacion, conversation, draft);
};
