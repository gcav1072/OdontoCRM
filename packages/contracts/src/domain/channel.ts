import { z } from 'zod';

/**
 * Contrato de canal (ADR 0029): lo que el núcleo conversacional necesita de
 * Telegram, WhatsApp o cualquier canal futuro, sin saber nada de sus detalles.
 */

export const CHANNEL_IDS = ['telegram', 'whatsapp'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const CHANNEL_LABELS: Readonly<Record<ChannelId, string>> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

/** Qué sabe hacer un canal: el núcleo se adapta a esto. */
export interface ChannelCapabilities {
  /** Botones interactivos (Telegram: teclado en línea; WhatsApp: interactivo). */
  botones: boolean;
  /** Adjuntos (el `.ics` de la cita). */
  documentos: boolean;
  /** Comandos con barra (`/nueva`); WhatsApp no los tiene. */
  comandos: boolean;
  /**
   * El canal exige **plantillas aprobadas** fuera de la ventana de atención
   * (WhatsApp Cloud API): el adaptador decide cuándo usar plantilla y cuándo texto.
   */
  plantillasAprobadas: boolean;
}

/** Mensaje entrante ya normalizado, venga de donde venga. */
export interface InboundMessage {
  canal: ChannelId;
  /** Dirección del interlocutor: id de chat (Telegram) o número (WhatsApp). */
  direccion: string;
  /** Nombre de usuario del canal, si lo hay. */
  usuario: string | null;
  texto: string | null;
  /** Acción de un botón o respuesta rápida pulsada. */
  accion: string | null;
  /** Identificador del evento en el canal, para la idempotencia. */
  eventoId: string;
  recibidoEn: string;
}

export const inboundMessageSchema = z.object({
  canal: z.enum(CHANNEL_IDS),
  direccion: z.string().min(1).max(80),
  usuario: z.string().max(80).nullable(),
  texto: z.string().max(4000).nullable(),
  accion: z.string().max(120).nullable(),
  eventoId: z.string().min(1).max(120),
  recibidoEn: z.string(),
});

export interface OutboundButton {
  etiqueta: string;
  /** Acción que vuelve como `InboundMessage.accion`. */
  accion: string;
}

export interface OutboundDocument {
  nombre: string;
  contenido: Buffer;
  mime: string;
}

/** Mensaje saliente que el adaptador sabe entregar. */
export interface OutboundMessage {
  direccion: string;
  texto: string;
  botones?: readonly OutboundButton[];
  documento?: OutboundDocument;
  /** Plantilla del catálogo que originó el mensaje (para WhatsApp aprobado). */
  plantilla?: string;
}

export interface SendResult {
  /** Identificador del mensaje en el canal, para la trazabilidad. */
  idMensaje: string;
}

export interface WebhookRequest {
  metodo: 'GET' | 'POST';
  query: Readonly<Record<string, string | undefined>>;
  headers: Readonly<Record<string, string | undefined>>;
  /** Cuerpo ya leído (texto) y su forma analizada si es JSON. */
  rawBody: string;
  json: unknown;
}

export interface WebhookResponse {
  estado: number;
  cuerpo?: unknown;
  contentType?: string;
}

/**
 * Adaptador de canal. El núcleo **no** sondea ni escucha: cada adaptador entrega
 * los mensajes con `entregar()` (Telegram los saca por long polling; WhatsApp los
 * recibe por webhook) y sabe enviar lo que el núcleo decide.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capacidades: ChannelCapabilities;
  /** Empieza a escuchar. Debe ser idempotente. */
  iniciar: (entregar: (entrante: InboundMessage) => Promise<void>) => Promise<void>;
  detener: () => Promise<void>;
  enviar: (saliente: OutboundMessage) => Promise<SendResult>;
  /** Solo los canales con webhook (WhatsApp) lo implementan. */
  webhook?: (peticion: WebhookRequest) => Promise<WebhookResponse>;
  /** Identidad visible del canal, para la pantalla de estado. */
  identidad: () => Promise<{ nombre: string | null; usuario: string | null; conectado: boolean }>;
}

/**
 * Opciones numeradas para canales sin botones: el mismo paso, en texto que se
 * puede responder con un número.
 */
export const numberedOptions = (
  opciones: readonly OutboundButton[],
): { texto: string; acciones: ReadonlyMap<string, string> } => {
  const acciones = new Map<string, string>();
  const lineas = opciones.map((opcion, index) => {
    acciones.set(String(index + 1), opcion.accion);
    return `${String(index + 1)}) ${opcion.etiqueta}`;
  });
  return { texto: lineas.join('\n'), acciones };
};

/** Traduce «2» o «2) Femenino» a la acción correspondiente, si la hay. */
export const resolveNumberedOption = (
  entrada: string,
  acciones: ReadonlyMap<string, string>,
): string | null => {
  const match = /^\s*(?<numero>\d{1,2})\b/.exec(entrada);
  if (match?.groups?.['numero'] === undefined) return null;
  return acciones.get(match.groups['numero']) ?? null;
};

/* ── Intenciones ───────────────────────────────────────────────────────────── */

/**
 * El núcleo conversacional habla de **intenciones**, no de comandos (ADR 0029):
 * Telegram traduce `/nueva` a `nueva` y WhatsApp traduce «cita» o «quiero una
 * cita» a la misma intención. Así el guion del asistente es el mismo en todos los
 * canales y añadir uno nuevo no toca el núcleo.
 */
export const BOT_INTENTS = [
  'nueva',
  'estado',
  'mi_ticket',
  'confirmar',
  'cancelar',
  'ayuda',
  'start',
] as const;
export type BotIntent = (typeof BOT_INTENTS)[number];

/** Frases que llevan a cada intención (se comparan normalizadas: sin acentos ni signos). */
export const INTENT_PHRASES: Readonly<Record<BotIntent, readonly string[]>> = {
  nueva: [
    'nueva',
    'nueva cita',
    'cita',
    'cita nueva',
    'quiero una cita',
    'quiero cita',
    'quiero sacar cita',
    'necesito una cita',
    'necesito cita',
    'pedir cita',
    'pedir una cita',
    'solicitar cita',
    'solicitar una cita',
    'agendar',
    'agendar cita',
    'sacar cita',
  ],
  estado: [
    'estado',
    'mi estado',
    'estado de mi cita',
    'estado de mi solicitud',
    'como va',
    'como va mi cita',
    'como va mi solicitud',
    'seguimiento',
  ],
  mi_ticket: ['mi ticket', 'mi tiquete', 'ticket', 'tiquete', 'mi turno'],
  /**
   * Confirmar la asistencia (ADR 0052). El aviso de la cita invita a hacerlo y el
   * mismo mensaje lleva un botón con esta acción; el texto se admite para quien
   * responda escribiendo (y para los canales sin botones).
   *
   * No se incluyen respuestas de una sola palabra del tipo «sí» u «ok»: son
   * demasiado ambiguas —durante el alta del paciente se escribe cualquier cosa— y
   * un «sí» a mitad del asistente no tiene por qué ser una confirmación de cita.
   */
  confirmar: [
    'confirmar',
    'confirmar cita',
    'confirmar mi cita',
    'confirmar asistencia',
    'confirmo',
    'confirmo mi cita',
    'confirmo asistencia',
    'si asistire',
    'asistire',
    'voy a asistir',
    'asistencia confirmada',
  ],
  cancelar: [
    'cancelar',
    'cancelar cita',
    'cancelar mi cita',
    'cancelar solicitud',
    'anular',
    'anular cita',
    'anular solicitud',
    'ya no quiero la cita',
  ],
  ayuda: ['ayuda', 'help', 'menu', 'opciones', 'que puedo hacer', 'como funciona'],
  /** Arrancar la conversación: en Telegram es `/start` y admite el código de vinculación. */
  start: ['start', 'iniciar', 'empezar', 'comenzar'],
};

/** Texto comparable: minúsculas, sin acentos, sin signos y con espacios simples. */
export const normalizePhrase = (texto: string): string =>
  texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Los comandos de Telegram usan `_` (`/mi_ticket`): se compara igual que «mi ticket».
    .replace(/[.,;:!¡?¿"'()_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ── Menú de comandos ──────────────────────────────────────────────────────── */

/**
 * Comando del menú. Telegram dibuja la lista al pulsar `/` (o el botón junto al
 * campo de texto) y se registra con `setMyCommands`; WhatsApp no tiene comandos,
 * así que allí el núcleo solo usa las frases naturales.
 */
export interface BotCommand {
  /** Sin la barra: es lo que exige la API del canal (minúsculas, `a-z0-9_`). */
  comando: string;
  /** Lo que se lee en el menú: corto, para que no se corte en el móvil. */
  descripcion: string;
  /** Intención que dispara (el asistente no conoce comandos, solo intenciones). */
  intencion: BotIntent;
  /** `true` si admite algo detrás (`/estado #000123`). */
  admiteArgumento?: boolean;
}

/**
 * Catálogo de comandos, en el orden en que se muestran. Es la **única** fuente:
 * de aquí salen el menú de Telegram y la lista que se escribe en la ayuda, así
 * que añadir un comando es añadirlo una vez.
 */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { comando: 'start', descripcion: 'Empezar (y vincular mi Telegram)', intencion: 'start' },
  { comando: 'nueva', descripcion: 'Pedir una cita', intencion: 'nueva' },
  {
    comando: 'estado',
    descripcion: 'Ver cómo va mi cita',
    intencion: 'estado',
    admiteArgumento: true,
  },
  { comando: 'mi_ticket', descripcion: 'Recordarme mi ticket', intencion: 'mi_ticket' },
  { comando: 'confirmar', descripcion: 'Confirmar mi cita', intencion: 'confirmar' },
  {
    comando: 'cancelar',
    descripcion: 'Cancelar mi cita o solicitud',
    intencion: 'cancelar',
    admiteArgumento: true,
  },
  { comando: 'ayuda', descripcion: 'Ver todo lo que puedo hacer', intencion: 'ayuda' },
];

/** Límites de Telegram (`setMyCommands`), para no registrar algo que rechace. */
export const BOT_COMMAND_LIMITS = {
  maxComandos: 100,
  maxLargoComando: 32,
  minLargoDescripcion: 3,
  maxLargoDescripcion: 256,
} as const;

/** Comandos con la forma que pide la API del canal (`command` / `description`). */
export const toMenuCommands = (): readonly { command: string; description: string }[] =>
  BOT_COMMANDS.map(({ comando, descripcion }) => ({ command: comando, description: descripcion }));

/**
 * La misma lista, en texto, para el mensaje de ayuda: quien no descubra el menú
 * (o use WhatsApp, que no lo tiene) lee igualmente lo que el asistente sabe hacer.
 */
export const botCommandsAsText = (): string =>
  BOT_COMMANDS.map(({ comando, descripcion }) => `/${comando} — ${descripcion}`).join('\n');

const INTENT_BY_PHRASE: ReadonlyMap<string, BotIntent> = new Map(
  BOT_INTENTS.flatMap((intencion) =>
    INTENT_PHRASES[intencion].map((frase) => [normalizePhrase(frase), intencion] as const),
  ),
);

export interface DetectedIntent {
  /** `null` cuando el texto no expresa ninguna intención conocida. */
  intencion: BotIntent | null;
  /** Lo que venía detrás (`/estado #000123` → `#000123`). */
  argumento: string;
  /** `true` si venía como comando con barra: en canales sin comandos no se acepta. */
  comando: boolean;
}

/**
 * Deduce la intención de un texto entrante. Los comandos con barra solo se
 * interpretan en canales que los tienen (`capacidades.comandos`); las frases
 * naturales funcionan en todos.
 */
export const detectIntent = (
  texto: string | null,
  opciones: { comandos: boolean },
): DetectedIntent => {
  const raw = (texto ?? '').trim();
  if (raw === '') return { intencion: null, argumento: '', comando: false };

  if (raw.startsWith('/')) {
    if (!opciones.comandos) return { intencion: null, argumento: '', comando: true };
    const [head = '', ...rest] = raw.split(/\s+/);
    const nombre = normalizePhrase((head.slice(1).split('@')[0] ?? '').trim());
    return {
      intencion: INTENT_BY_PHRASE.get(nombre) ?? null,
      argumento: rest.join(' ').trim(),
      comando: true,
    };
  }

  return {
    intencion: INTENT_BY_PHRASE.get(normalizePhrase(raw)) ?? null,
    argumento: '',
    comando: false,
  };
};
