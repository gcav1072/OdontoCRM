import { Boom } from '@hapi/boom';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type UserFacingSocketConfig,
  type WAMessage,
  type WAVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

import {
  toE164Digits,
  type InboundMessage,
  type OutboundMessage,
  type SendResult,
  type WhatsAppPairInput,
  type WhatsAppSessionState,
  type WhatsAppSessionView,
} from '@odontocrm/contracts';
import { ConflictError, ServiceUnavailableError, ValidationError } from '@odontocrm/kernel';

import type { AdminAlerter } from '../../alertas.js';
import type { NotificationsConfig } from '../../config.js';
import type { NotificationsDb } from '../../db/client.js';
import { patientChannels } from '../../db/schema.js';
import { usePostgresAuthState, type WhatsAppAuthHandle } from './auth-store.js';
import { createMessageCache, type MessageCache } from './cache-mensajes.js';
import { toInboundMessage } from './entrantes.js';
import { createWhatsAppSessionStore, type WhatsAppSessionStore } from './estado-store.js';
import { jidDesdeDireccion } from './jid.js';
import { CanalNoDisponibleError, createLimitador, type Limitador } from './limitador.js';

/**
 * Ciclo de vida del socket de **Baileys** (ADR 0072/0073).
 *
 * La pieza importante es la máquina de estados del §4 del plan: el panel, la
 * bandeja y el bot de administración ven siempre un estado legible, y cada
 * transición tiene una regla explícita. `makeSocket` se inyecta para poder
 * probar QR, reconexión, `loggedOut` y `connectionReplaced` sin red.
 */

export interface WhatsAppSocket {
  ev: {
    on: <T extends keyof BaileysEventMap>(
      evento: T,
      handler: (arg: BaileysEventMap[T]) => void,
    ) => void;
    removeAllListeners?: (evento: keyof BaileysEventMap) => void;
  };
  sendMessage: WASocket['sendMessage'];
  requestPairingCode: WASocket['requestPairingCode'];
  sendPresenceUpdate: WASocket['sendPresenceUpdate'];
  logout: WASocket['logout'];
  end: WASocket['end'];
  user: WASocket['user'];
}

export type MakeWhatsAppSocket = (config: UserFacingSocketConfig) => WhatsAppSocket;
type BaileysLogger = UserFacingSocketConfig['logger'];

export interface WhatsAppSessionAudit {
  accion: 'whatsapp_session_paired' | 'whatsapp_session_logged_out' | 'whatsapp_session_lost';
  detalle: string;
  actorId?: string | null;
  actorUsername?: string | null;
}

export interface WhatsAppSesionOptions {
  config: NotificationsConfig;
  db: NotificationsDb;
  alertas?: AdminAlerter | null;
  /** Fábrica inyectable; en producción es `makeWASocket`. */
  makeSocket?: MakeWhatsAppSocket;
  /** Persistencia inyectable para las pruebas. */
  store?: WhatsAppSessionStore;
  /** Estado Signal inyectable para las pruebas. */
  auth?: WhatsAppAuthHandle;
  logger?: BaileysLogger;
  onError?: (error: unknown, contexto: string) => void;
  onAuditoria?: (evento: WhatsAppSessionAudit) => Promise<void> | void;
}

export interface WhatsAppSesion {
  iniciar: (entregar: (entrante: InboundMessage) => Promise<void>) => Promise<void>;
  detener: () => Promise<void>;
  enviar: (saliente: OutboundMessage) => Promise<SendResult>;
  identidad: () => Promise<{ nombre: string | null; usuario: string | null; conectado: boolean }>;
  estado: () => WhatsAppSessionState;
  vista: () => Promise<WhatsAppSessionView>;
  pair: (
    input: WhatsAppPairInput,
    actor?: { id: string | null; username: string | null },
  ) => Promise<WhatsAppSessionView>;
  restart: () => Promise<WhatsAppSessionView>;
  logout: (actor?: { id: string | null; username: string | null }) => Promise<void>;
}

const QR_TTL_MS = 60_000;
const PAIR_QR_WAIT_MS = 15_000;

const dormir = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const EVENTOS_SOCKET = ['connection.update', 'creds.update', 'messages.upsert'] as const;

/** Quita los listeners que puso la sesión (no toca los del socket de Baileys). */
const quitarListeners = (socket: WhatsAppSocket): void => {
  for (const evento of EVENTOS_SOCKET) socket.ev.removeAllListeners?.(evento);
};

/** Motivo legible de un cierre, sin filtrar secretos ni el JSON del Boom. */
const motivoDe = (error: unknown): string => {
  if (error instanceof Error && error.message.trim() !== '') return error.message.slice(0, 300);
  return 'La conexión con WhatsApp se cerró';
};

const codigoDeCierre = (estado: Partial<ConnectionState>): number | null => {
  const error = estado.lastDisconnect?.error;
  if (error === undefined) return null;
  if (error instanceof Boom) return error.output.statusCode;
  const status = (error as { output?: { statusCode?: unknown } }).output?.statusCode;
  return typeof status === 'number' ? status : null;
};

const numeroDeUsuario = (socket: WhatsAppSocket): string | null => {
  // En v7 `id` puede ser un LID; `phoneNumber` es el PN cuando está disponible.
  const phoneNumber = socket.user?.phoneNumber?.trim() || undefined;
  const id = phoneNumber ?? socket.user?.id;
  if (typeof id !== 'string') return null;
  if (phoneNumber === undefined && id.endsWith('@lid')) return null;
  const local = id.split('@')[0]?.split(':')[0] ?? '';
  const digitos = local.replace(/\D/g, '');
  return digitos.length >= 8 ? digitos : null;
};

export const createWhatsAppSesion = (options: WhatsAppSesionOptions): WhatsAppSesion => {
  const { config } = options;
  const store = options.store ?? createWhatsAppSessionStore(options.db, config.WHATSAPP_SESSION_ID);
  const cache: MessageCache = createMessageCache();
  const logger =
    options.logger ?? (pino({ level: config.WHATSAPP_LOG_LEVEL }) as unknown as BaileysLogger);

  let entregar: ((entrante: InboundMessage) => Promise<void>) | null = null;
  let authPromise: Promise<WhatsAppAuthHandle> | null = null;
  let socket: WhatsAppSocket | null = null;
  let estadoActual: WhatsAppSessionState = 'sin_vincular';
  let numero: string | null = null;
  let nombre: string | null = null;
  let vinculadoEn: Date | null = null;
  let conectadoDesde: Date | null = null;
  let ultimaDesconexion: Date | null = null;
  let motivo: string | null = null;
  let qrCrudo: string | null = null;
  let qrExpiraEn: Date | null = null;
  let pairingCode: string | null = null;
  let pairingPorCodigo = false;
  let iniciado = false;
  let deteniendo = false;
  let conectando = false;
  let intentosReconexion = 0;
  let temporizadorReconexion: ReturnType<typeof setTimeout> | null = null;
  let temporizadorAlerta: ReturnType<typeof setTimeout> | null = null;
  let alertaCaidaEnviada = false;
  let actorPendiente: { id: string | null; username: string | null } | null = null;
  let versionPromise: Promise<WAVersion> | null = null;

  const limitador: Limitador = createLimitador({
    minIntervalMs: config.WHATSAPP_SEND_MIN_INTERVAL_MS,
    maxIntervalMs: config.WHATSAPP_SEND_MAX_INTERVAL_MS,
    dailyCap: config.WHATSAPP_DAILY_SEND_CAP,
    typing: config.WHATSAPP_TYPING,
    store,
    conectado: () => estadoActual === 'conectado' && socket !== null,
  });

  const avisarError = (error: unknown, contexto: string): void => {
    options.onError?.(error, contexto);
  };

  const getAuth = async (): Promise<WhatsAppAuthHandle> => {
    if (options.auth !== undefined) return options.auth;
    authPromise ??= usePostgresAuthState(options.db, {
      sessionId: config.WHATSAPP_SESSION_ID,
      encryptionKey: config.STORAGE_ENCRYPTION_KEY,
      warn: (mensaje) => avisarError(new Error(mensaje), 'whatsapp_sesion_sin_cifrar'),
    });
    return authPromise;
  };

  /** Borra la sesión Signal (base y caché) y deja que el próximo `getAuth` la recree. */
  const borrarCredenciales = async (): Promise<void> => {
    const auth = await getAuth();
    await auth.clear().catch((error: unknown) => avisarError(error, 'whatsapp_borrar_auth'));
    if (options.auth === undefined) authPromise = null;
  };

  const guardar = async (patch: Parameters<WhatsAppSessionStore['save']>[0]): Promise<void> => {
    try {
      await store.save(patch);
    } catch (error) {
      avisarError(error, 'whatsapp_guardar_estado');
    }
  };

  const persistir = async (
    patch: Parameters<WhatsAppSessionStore['save']>[0] = {},
  ): Promise<void> => {
    await guardar({
      estado: estadoActual,
      numero,
      nombre,
      vinculadoEn,
      conectadoDesde,
      ultimaDesconexion,
      motivo,
      ...patch,
    });
  };

  const alertarAdmin = async (
    nivel: 'info' | 'warn' | 'error',
    titulo: string,
    detalle: string,
  ): Promise<void> => {
    if (options.alertas === undefined || options.alertas === null) return;
    const level = nivel === 'error' ? 'critical' : nivel === 'warn' ? 'warning' : 'info';
    await options.alertas
      .enviar({
        level,
        title: titulo,
        detail: detalle,
        context: { canal: 'whatsapp', sesion: config.WHATSAPP_SESSION_ID },
        source: 'notifications',
      })
      .catch((error: unknown) => avisarError(error, 'whatsapp_alerta_admin'));
  };

  /**
   * Si el número del consultorio cambia, los pacientes vinculados al número
   * anterior **no** han escrito al nuevo: se marcan para volver a vincular y no
   * se les escribe en frío (decisión del usuario sobre §8). Al escribir de nuevo
   * al bot, `linkChat` les quita el bloqueo.
   */
  const marcarPacientesParaRevincular = async (numeroNuevo: string): Promise<void> => {
    try {
      const filas = await options.db
        .update(patientChannels)
        .set({ isBlocked: true, updatedAt: new Date() })
        .where(and(eq(patientChannels.channel, 'whatsapp'), eq(patientChannels.isBlocked, false)))
        .returning({ id: patientChannels.id });
      if (filas.length > 0) {
        await alertarAdmin(
          'warn',
          'WhatsApp cambió de número',
          `El número nuevo es ${numeroNuevo}. ${String(
            filas.length,
          )} paciente(s) quedaron marcados para volver a vincular; no se les escribe en frío.`,
        );
      }
    } catch (error) {
      avisarError(error, 'whatsapp_revincular_pacientes');
    }
  };

  const auditar = async (
    accion: WhatsAppSessionAudit['accion'],
    detalle: string,
    actor: { id: string | null; username: string | null } | null = actorPendiente,
  ): Promise<void> => {
    try {
      await options.onAuditoria?.({
        accion,
        detalle,
        actorId: actor?.id ?? null,
        actorUsername: actor?.username ?? null,
      });
    } catch (error) {
      avisarError(error, 'whatsapp_auditoria');
    }
  };

  const limpiarTemporizadores = (): void => {
    if (temporizadorReconexion !== null) clearTimeout(temporizadorReconexion);
    if (temporizadorAlerta !== null) clearTimeout(temporizadorAlerta);
    temporizadorReconexion = null;
    temporizadorAlerta = null;
  };

  const programarAlertaCaida = (): void => {
    if (alertaCaidaEnviada || temporizadorAlerta !== null) return;
    const retraso = config.WHATSAPP_ALERT_AFTER_MINUTES * 60_000;
    temporizadorAlerta = setTimeout(() => {
      temporizadorAlerta = null;
      if (estadoActual === 'conectado' || alertaCaidaEnviada) return;
      alertaCaidaEnviada = true;
      void alertarAdmin(
        'error',
        'WhatsApp: la sesión lleva demasiado tiempo caída',
        `El canal WhatsApp (sesión ${config.WHATSAPP_SESSION_ID}) lleva más de ${String(
          config.WHATSAPP_ALERT_AFTER_MINUTES,
        )} minutos sin conectar. Estado: ${estadoActual}. Revisa el teléfono y, si hace falta, vuelve a vincular.`,
      );
      void auditar(
        'whatsapp_session_lost',
        `Sesión de WhatsApp caída más de ${String(config.WHATSAPP_ALERT_AFTER_MINUTES)} minutos (${estadoActual})`,
        null,
      );
    }, retraso);
    temporizadorAlerta.unref?.();
  };

  const programarReconexion = (): void => {
    if (deteniendo || temporizadorReconexion !== null) return;
    if (estadoActual === 'reemplazada' || estadoActual === 'sesion_cerrada') return;
    const intento = Math.min(intentosReconexion, 20);
    intentosReconexion += 1;
    const base = Math.min(1_000 * 2 ** intento, config.WHATSAPP_RECONNECT_MAX_DELAY_MS);
    const retraso = base + Math.floor(Math.random() * 250);
    temporizadorReconexion = setTimeout(() => {
      temporizadorReconexion = null;
      if (deteniendo) return;
      void conectar().catch((error: unknown) => {
        avisarError(error, 'whatsapp_reconexion');
        programarReconexion();
      });
    }, retraso);
    temporizadorReconexion.unref?.();
  };

  const cerrarSocket = async (): Promise<void> => {
    const actual = socket;
    socket = null;
    if (actual === null) return;
    try {
      quitarListeners(actual);
      await actual.end(undefined);
    } catch (error) {
      avisarError(error, 'whatsapp_cerrar_socket');
    }
  };

  const sesionCerrada = async (
    nuevoMotivo: string,
    actor: { id: string | null; username: string | null } | null = null,
  ): Promise<void> => {
    limpiarTemporizadores();
    await cerrarSocket();
    await borrarCredenciales();
    estadoActual = 'sesion_cerrada';
    motivo = nuevoMotivo;
    ultimaDesconexion = new Date();
    // Se conserva el último número: sirve para detectar un cambio de número y
    // marcar a los pacientes para volver a vincular (no se borra al cerrar).
    conectadoDesde = null;
    qrCrudo = null;
    qrExpiraEn = null;
    pairingCode = null;
    pairingPorCodigo = false;
    await persistir();
    await alertarAdmin(
      'error',
      'WhatsApp: la sesión se cerró',
      `${nuevoMotivo}. Hay que volver a vincular el número desde Configuración → Canales.`,
    );
    await auditar('whatsapp_session_logged_out', nuevoMotivo, actor);
  };

  const procesarConexion = async (actualizacion: Partial<ConnectionState>): Promise<void> => {
    if (actualizacion.qr !== undefined) {
      estadoActual = 'esperando_qr';
      // Con código de emparejamiento no se muestra el QR: el admin ya eligió
      // el camino del código y es el que tiene delante.
      qrCrudo = pairingPorCodigo ? null : actualizacion.qr;
      qrExpiraEn = new Date(Date.now() + QR_TTL_MS);
      if (!pairingPorCodigo) pairingCode = null;
      motivo = null;
      await persistir();
    }

    if (actualizacion.connection === 'connecting') {
      if (estadoActual === 'sin_vincular' || estadoActual === 'sesion_cerrada') {
        estadoActual = 'conectando';
        await persistir();
      }
      return;
    }

    if (actualizacion.connection === 'open') {
      conectando = false;
      intentosReconexion = 0;
      alertaCaidaEnviada = false;
      if (temporizadorAlerta !== null) clearTimeout(temporizadorAlerta);
      temporizadorAlerta = null;

      const eraVinculada = vinculadoEn !== null;
      estadoActual = 'conectado';
      motivo = null;
      qrCrudo = null;
      qrExpiraEn = null;
      pairingCode = null;
      pairingPorCodigo = false;
      conectadoDesde = new Date();
      const actual = socket;
      const numeroNuevo = actual === null ? null : numeroDeUsuario(actual);
      if (numeroNuevo !== null) {
        if (numero !== null && numero !== numeroNuevo) {
          await marcarPacientesParaRevincular(numeroNuevo);
        }
        numero = numeroNuevo;
      }
      // Si el socket aún no expone el contacto, se conserva el último nombre
      // conocido en vez de borrarlo.
      nombre = actual?.user?.name ?? nombre;
      if (!eraVinculada) vinculadoEn = new Date();
      await persistir();

      if (!eraVinculada) {
        await alertarAdmin(
          'info',
          'WhatsApp vinculado',
          `La sesión ${config.WHATSAPP_SESSION_ID} quedó conectada con el número ${numero ?? 'desconocido'}.`,
        );
        await auditar(
          'whatsapp_session_paired',
          `WhatsApp vinculado con el número ${numero ?? 'desconocido'}`,
        );
        actorPendiente = null;
      } else if (alertaCaidaEnviada) {
        alertaCaidaEnviada = false;
        await alertarAdmin(
          'info',
          'WhatsApp restablecido',
          'La sesión de WhatsApp volvió a conectar.',
        );
      }
      return;
    }

    if (actualizacion.connection === 'close') {
      conectando = false;
      const codigo = codigoDeCierre(actualizacion);
      const detalle = motivoDe(actualizacion.lastDisconnect?.error);
      const actual = socket;
      socket = null;
      if (actual !== null) {
        try {
          quitarListeners(actual);
          await actual.end(undefined);
        } catch (error) {
          avisarError(error, 'whatsapp_cerrar_socket');
        }
      }

      if (
        codigo === DisconnectReason.loggedOut ||
        codigo === DisconnectReason.badSession ||
        codigo === DisconnectReason.multideviceMismatch ||
        codigo === DisconnectReason.forbidden
      ) {
        await sesionCerrada(detalle);
        return;
      }

      if (codigo === DisconnectReason.connectionReplaced) {
        limpiarTemporizadores();
        estadoActual = 'reemplazada';
        motivo = detalle;
        ultimaDesconexion = new Date();
        conectadoDesde = null;
        await persistir();
        await alertarAdmin(
          'error',
          'WhatsApp: otro dispositivo abrió la misma sesión',
          'Hay otra instancia usando el mismo número (por ejemplo, desarrollo y producción). ' +
            'No se reconectará sola para no pelear por la sesión.',
        );
        return;
      }

      estadoActual = 'reconectando';
      motivo = detalle;
      ultimaDesconexion = new Date();
      conectadoDesde = null;
      await persistir();
      programarAlertaCaida();
      programarReconexion();
    }
  };

  const conectar = async (permitirSinCreds = false): Promise<void> => {
    if (deteniendo || socket !== null || conectando) return;
    const auth = await getAuth();
    if (!permitirSinCreds && !(await auth.hasCreds()) && estadoActual === 'sin_vincular') return;

    conectando = true;
    estadoActual = estadoActual === 'esperando_qr' ? 'esperando_qr' : 'conectando';
    await persistir();

    versionPromise ??=
      options.makeSocket === undefined
        ? fetchLatestBaileysVersion({ signal: AbortSignal.timeout(10_000) })
            .then((resultado) => resultado.version)
            .catch(() => DEFAULT_CONNECTION_CONFIG.version)
        : Promise.resolve(DEFAULT_CONNECTION_CONFIG.version);
    const version = await versionPromise;

    try {
      const nuevo = (options.makeSocket ?? makeWASocket)({
        auth: auth.state as AuthenticationState,
        logger,
        version,
        browser: ['OdontoCRM', 'Chrome', '1.1.0'],
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) =>
          jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
        getMessage: async (key) => cache.get(key),
        generateHighQualityLinkPreview: false,
        emitOwnEvents: false,
        countryCode: 'VE',
      });
      socket = nuevo;

      nuevo.ev.on('connection.update', (actualizacion) => {
        void procesarConexion(actualizacion).catch((error: unknown) => {
          avisarError(error, 'whatsapp_connection_update');
        });
      });

      nuevo.ev.on('creds.update', () => {
        void auth.saveCreds().catch((error: unknown) => {
          avisarError(error, 'whatsapp_guardar_creds');
        });
      });

      nuevo.ev.on('messages.upsert', (evento) => {
        if (evento.type !== 'notify') return;
        for (const mensaje of evento.messages as WAMessage[]) {
          const entrante = toInboundMessage(mensaje, {
            prefijoPorDefecto: config.WHATSAPP_DEFAULT_COUNTRY_CODE,
          });
          if (entrante === null || entregar === null) continue;
          void entregar(entrante).catch((error: unknown) => {
            avisarError(error, 'whatsapp_entrante');
          });
        }
      });
    } catch (error) {
      conectando = false;
      socket = null;
      throw error;
    }
  };

  const vista = async (): Promise<WhatsAppSessionView> => {
    if (
      estadoActual === 'esperando_qr' &&
      qrExpiraEn !== null &&
      qrExpiraEn.getTime() <= Date.now()
    ) {
      estadoActual = 'sin_vincular';
      qrCrudo = null;
      qrExpiraEn = null;
      // Si el QR caducó sin escanear, el socket ya no sirve para vincular: se
      // cierra para que un nuevo «Vincular» abra otro limpio.
      await cerrarSocket();
      await persistir();
    }

    let qrDataUrl: string | null = null;
    if (qrCrudo !== null && estadoActual === 'esperando_qr') {
      try {
        qrDataUrl = await QRCode.toDataURL(qrCrudo, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: 'M',
        });
      } catch (error) {
        avisarError(error, 'whatsapp_qr');
      }
    }

    return {
      estado: estadoActual,
      numero,
      nombre,
      qrDataUrl,
      qrRaw: estadoActual === 'esperando_qr' ? qrCrudo : null,
      qrExpiraEn: qrExpiraEn?.toISOString() ?? null,
      pairingCode: estadoActual === 'esperando_qr' ? pairingCode : null,
      conectadoDesde: conectadoDesde?.toISOString() ?? null,
      ultimaDesconexion: ultimaDesconexion?.toISOString() ?? null,
      motivo,
    };
  };

  const pair = async (
    input: WhatsAppPairInput,
    actor: { id: string | null; username: string | null } = { id: null, username: null },
  ): Promise<WhatsAppSessionView> => {
    if (estadoActual === 'conectado') {
      throw new ConflictError(
        'Ya hay una sesión de WhatsApp conectada: ciérrala antes de vincular otra',
      );
    }
    if (estadoActual === 'sesion_cerrada' || estadoActual === 'reemplazada') {
      await borrarCredenciales();
      vinculadoEn = null;
      estadoActual = 'sin_vincular';
    }
    actorPendiente = actor;
    // Un «Vincular» explícito empieza con un socket limpio: si había uno a
    // medio conectar (QR caducado, reintento), se cierra sin borrar credenciales.
    if (socket !== null) await cerrarSocket();
    qrCrudo = null;
    qrExpiraEn = null;
    pairingCode = null;
    pairingPorCodigo = input.metodo === 'codigo';
    await conectar(true);
    if (socket === null) {
      throw new ServiceUnavailableError('No se pudo abrir el socket de WhatsApp');
    }

    if (input.metodo === 'codigo') {
      const telefono = toE164Digits(input.telefono ?? '', config.WHATSAPP_DEFAULT_COUNTRY_CODE);
      if (!/^\d{8,15}$/.test(telefono)) {
        throw new ValidationError('El número para el código de emparejamiento no es válido');
      }
      let codigo: string;
      try {
        codigo = await socket.requestPairingCode(telefono);
      } catch {
        // Baileys necesita que el socket termine de registrarse; un reintento
        // corto evita el fallo típico del primer clic del panel.
        await dormir(2_000);
        codigo = await socket.requestPairingCode(telefono);
      }
      pairingCode = codigo;
      estadoActual = 'esperando_qr';
      qrExpiraEn = new Date(Date.now() + QR_TTL_MS);
      await persistir();
      return vista();
    }

    const inicio = Date.now();
    while (qrCrudo === null && Date.now() - inicio < PAIR_QR_WAIT_MS) {
      await dormir(100);
    }
    return vista();
  };

  const restart = async (): Promise<WhatsAppSessionView> => {
    limpiarTemporizadores();
    deteniendo = false;
    alertaCaidaEnviada = false;
    intentosReconexion = 0;
    await cerrarSocket();
    estadoActual = 'sin_vincular';
    const auth = await getAuth();
    if (await auth.hasCreds()) {
      await conectar();
    } else {
      await persistir();
    }
    return vista();
  };

  const logout = async (
    actor: { id: string | null; username: string | null } = { id: null, username: null },
  ): Promise<void> => {
    limpiarTemporizadores();
    const actual = socket;
    socket = null;
    if (actual !== null) {
      quitarListeners(actual);
      try {
        await actual.logout();
      } catch (error) {
        avisarError(error, 'whatsapp_logout_socket');
      }
      await actual.end(undefined).catch((error: unknown) => {
        avisarError(error, 'whatsapp_logout_end');
      });
    }
    await borrarCredenciales();
    estadoActual = 'sin_vincular';
    motivo = 'Sesión cerrada desde el panel';
    vinculadoEn = null;
    conectadoDesde = null;
    qrCrudo = null;
    qrExpiraEn = null;
    pairingCode = null;
    pairingPorCodigo = false;
    await persistir();
    await auditar('whatsapp_session_logged_out', motivo, actor);
  };

  return {
    iniciar: async (handler) => {
      entregar = handler;
      if (iniciado) return;
      iniciado = true;
      deteniendo = false;

      const guardado = await store.load().catch((error: unknown) => {
        avisarError(error, 'whatsapp_cargar_estado');
        return null;
      });
      if (guardado !== null) {
        estadoActual = guardado.estado;
        numero = guardado.numero;
        nombre = guardado.nombre;
        vinculadoEn = guardado.vinculadoEn;
        conectadoDesde = guardado.conectadoDesde;
        ultimaDesconexion = guardado.ultimaDesconexion;
        motivo = guardado.motivo;
      }

      const auth = await getAuth();
      const tieneCreds = await auth.hasCreds();
      if (tieneCreds && (estadoActual === 'reemplazada' || estadoActual === 'sesion_cerrada')) {
        // Requieren una acción del admin: no se pelea con la otra instancia ni
        // se reintenta en bucle una sesión que WhatsApp ya rechazó.
        await persistir();
        return;
      }
      if (tieneCreds) {
        // Si el proceso murió a mitad de una reconexión, se intenta de nuevo.
        if (
          estadoActual === 'conectado' ||
          estadoActual === 'reconectando' ||
          estadoActual === 'conectando'
        ) {
          estadoActual = 'conectando';
        }
        await conectar();
      } else {
        estadoActual = 'sin_vincular';
        await persistir();
      }
    },

    detener: async () => {
      deteniendo = true;
      limpiarTemporizadores();
      await cerrarSocket();
      estadoActual = 'desactivado';
      iniciado = false;
      await persistir();
    },

    estado: () => estadoActual,

    vista,

    pair,

    restart,

    logout,

    enviar: async (saliente) => {
      const jid = jidDesdeDireccion(saliente.direccion, config.WHATSAPP_DEFAULT_COUNTRY_CODE);
      const texto = saliente.texto.slice(0, 4096);
      return limitador.programar(
        texto,
        async (): Promise<SendResult> => {
          const actual = socket;
          if (actual === null || estadoActual !== 'conectado') {
            throw new CanalNoDisponibleError(
              'WhatsApp no está conectado',
              new Date(Date.now() + 60_000),
            );
          }
          const enviado =
            saliente.documento === undefined
              ? await actual.sendMessage(jid, { text: texto })
              : await actual.sendMessage(jid, {
                  document: saliente.documento.contenido,
                  mimetype: saliente.documento.mime,
                  fileName: saliente.documento.nombre,
                  ...(texto === '' ? {} : { caption: texto.slice(0, 1024) }),
                });
          const idMensaje = enviado?.key.id;
          if (idMensaje === undefined || idMensaje === null) {
            throw new Error('WhatsApp no devolvió el identificador del mensaje');
          }
          if (enviado?.message !== undefined && enviado.message !== null) {
            cache.record(enviado.key, enviado.message);
          }
          return { idMensaje };
        },
        async (presencia) => {
          const actual = socket;
          if (actual === null) return;
          await actual.sendPresenceUpdate(presencia, jid);
        },
      );
    },

    identidad: async () => ({
      nombre,
      usuario: numero,
      conectado: estadoActual === 'conectado',
    }),
  };
};
