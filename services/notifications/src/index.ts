import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  deadLetterAlert,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  startDeadLetterWatcher,
  stopBoss,
} from '@odontocrm/db';
import type { InboundMessage } from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { aplicarDatosDelConsultorio, createLetterheadLookup, startServer } from '@odontocrm/kernel';

import { createAdminAlerter } from './alertas.js';
import { createChannelAdapters } from './canales/index.js';
import { createChannelCredentialsLookup } from './channels-config.js';
import {
  applyChannelCredentials,
  channelSignature,
  loadNotificationsConfig,
  syncChannelFields,
  type NotificationsConfig,
} from './config.js';
import { handleDomainEvent, publishMessageEvent } from './consumer.js';
import { avisarFalloAlPaciente, handleInbound } from './core/asistente.js';
import { createNotificationsDatabase } from './db/client.js';
import { createInternalClients } from './internal-client.js';
import { ensureDefaultTemplates, processQueue } from './messaging.js';
import { createNotificationsServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadNotificationsConfig();
  const database = createNotificationsDatabase(config);
  const clients = createInternalClients(config);

  // El nombre, la dirección y el correo del consultorio: base de datos > `CLINIC`,
  // con `CLINIC_*` del entorno por encima. Se refresca cada 5 minutos (sin mantener
  // el proceso vivo), así un cambio de identidad llega al bot sin reiniciar.
  const letterheadLookup = createLetterheadLookup(config);
  await aplicarDatosDelConsultorio(config, letterheadLookup);
  const refrescoIdentidad = setInterval(
    () => void aplicarDatosDelConsultorio(config, letterheadLookup),
    5 * 60_000,
  );
  refrescoIdentidad.unref();

  // El logger todavía no existe cuando se construyen los adaptadores: el error de
  // entrega se guarda y se registra en cuanto el servidor está en pie.
  let logError: (error: unknown) => void = () => undefined;
  let logAviso: (error: unknown, contexto: string) => void = () => undefined;

  /**
   * Los canales se construyen con la **configuración efectiva**: la del `.env` más lo que el
   * panel haya guardado en la base (ADR 0060). La base manda; el `.env` es el respaldo.
   *
   * `configBase` se guarda intacto para que, si el panel **borra** un valor, se vuelva al del
   * archivo en vez de quedarse pegado en el último valor de la base.
   */
  const configBase: NotificationsConfig = { ...config };
  const canalesLookup = createChannelCredentialsLookup(config);
  const resolverCanales = async (): Promise<NotificationsConfig> => {
    const creds = await canalesLookup();
    const efectivo = applyChannelCredentials(configBase, creds);
    syncChannelFields(config, efectivo);
    return efectivo;
  };

  const configCanales = await resolverCanales();
  const canales = createChannelAdapters(configCanales, {
    onError: (error) => {
      logError(error);
    },
    onAviso: (error, contexto) => {
      logAviso(error, contexto);
    },
  });

  /**
   * Emisor de los avisos de **infraestructura** (bot de administración). Se crea antes que
   * el logger por la misma razón que los canales: el logger todavía no existe, así que el
   * fallo se guarda y se registra en cuanto el servidor está en pie.
   */
  const adminAlerter = createAdminAlerter({
    config: configCanales,
    onError: (error, contexto) => {
      logAviso(error, contexto);
    },
  });

  const services = {
    config,
    db: database.db,
    pool: database.pool,
    canales,
    clients,
    // El emisor de avisos de infraestructura: este servicio es el único que tiene el bot.
    adminAlerter,
    lastError: null as string | null,
  };

  const app = await createNotificationsServer({ config, database, services });
  logError = (error) => {
    services.lastError = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, 'Falló la entrega de un mensaje del canal');
  };
  logAviso = (error, contexto) => {
    // Un aviso no tumba nada: el bot sigue, solo se pierde el detalle.
    app.log.warn({ err: error, contexto }, 'Detalle del canal que no se pudo aplicar');
  };

  // Plantillas del catálogo: si falta alguna (o se borró), se vuelve a sembrar.
  const seeded = await ensureDefaultTemplates(database.db);
  app.log.info(
    {
      plantillasCreadas: seeded,
      canales: canales.registry.all.map((adapter) => adapter.id),
    },
    'Plantillas de mensajes listas',
  );

  // Cola de eventos: los avisos de cita llegan desde la agenda (`appointment.scheduled`
  // y compañía) y aquí se convierten en mensajes encolados.
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-notifications',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);
  await registerDomainEventHandler(
    boss,
    async (events) => {
      for (const event of events) {
        try {
          const result = await handleDomainEvent(database.db, config, event);
          if (result.status === 'encolado' || result.status === 'reintentado') {
            app.log.info(
              {
                eventType: event.eventType,
                plantilla: result.templateKey,
                resultado: result.status,
              },
              'Aviso preparado para el paciente',
            );
          }
        } catch (error) {
          services.lastError = error instanceof Error ? error.message : String(error);
          app.log.error({ err: error, eventType: event.eventType }, 'No se pudo encolar el aviso');
          throw error;
        }
      }
    },
    { queue: consumerQueueName('notifications') },
  );

  // Publicador del outbox: deja en la auditoría cada aviso enviado o fallido.
  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    intervalMs: 2_000,
    onError: (error) => {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'Falló un ciclo del publicador del outbox');
    },
  });
  outbox.start();

  /**
   * Vigilante de la **cola de descarte**: apunta los eventos que agotan sus reintentos y
   * avisa al administrador por el bot. Este servicio es el único que puede avisar, así que
   * aquí el vigilante llama al emisor directamente (sin pasar por HTTP).
   */
  const deadLetters = await startDeadLetterWatcher({
    boss,
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-notifications-dlq',
    onDeadLetter: async (record, esNuevo) => {
      app.log.error(
        { cola: record.sourceQueue, evento: record.eventType, error: record.error },
        'Evento perdido: agotó sus reintentos',
      );
      if (!esNuevo) return;
      // Este servicio es el que tiene el bot: llama al emisor directamente en vez de pedirse
      // el aviso a sí mismo por HTTP.
      await services.adminAlerter.enviar({ ...deadLetterAlert(record), source: 'notifications' });
    },
    onError: (error) => {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'Falló el vigilante de la cola de descarte');
    },
  });

  /** Cycle de la cola de envíos: manda lo que toca y programa los reintentos. */
  const runQueue = async (): Promise<void> => {
    try {
      const result = await processQueue(database.db, canales.registry, config, {
        appointmentLoader: (id) => clients.getAppointment(id),
        onResult: async (info) => {
          await publishMessageEvent(database.db, {
            topic: info.ok ? EVENT_TOPICS.messageSent : EVENT_TOPICS.messageFailed,
            notificationId: info.id,
            payload: {
              notificationId: info.id,
              patientId: info.patientId,
              appointmentId: info.appointmentId,
              templateKey: info.templateKey,
              channel: info.channel,
              providerMessageId: info.providerMessageId ?? null,
              error: info.error ?? null,
              summary: info.ok
                ? `Aviso «${info.templateKey}» enviado al paciente`
                : `Aviso «${info.templateKey}» falló: ${info.error ?? 'sin detalle'}`,
            },
          });
        },
      });

      if (result.processed > 0) {
        app.log.info(result, 'Cola de envíos procesada');
      }
    } catch (error) {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'Falló un ciclo de la cola de envíos');
    }
  };

  const queueTimer = setInterval(() => {
    void runQueue();
  }, config.QUEUE_INTERVAL_MS);
  queueTimer.unref?.();

  /**
   * Los adaptadores empujan los mensajes al **mismo núcleo**: Telegram sondea por
   * dentro y WhatsApp los recibe por webhook, así que aquí no hay bucle propio.
   * La idempotencia por `(canal, eventoId)` la garantiza el asistente.
   */
  const asistente = {
    db: database.db,
    config,
    canales: canales.registry,
    clients,
  };

  /** El núcleo al que entregan los adaptadores (el mismo al reconstruirlos). */
  const entregar = async (entrante: InboundMessage): Promise<void> => {
    try {
      const result = await handleInbound(asistente, entrante);
      if (result.handled) {
        app.log.info(
          { canal: result.canal, accion: result.action },
          'Mensaje del asistente procesado',
        );
      }
    } catch (error) {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error, canal: entrante.canal }, 'Fallo al procesar un mensaje');

      // Nada de silencio: si el paso falló por algo de fuera (un servicio interno
      // caído, la base), el paciente recibe un aviso y se le repite el paso.
      try {
        await avisarFalloAlPaciente(asistente, entrante);
      } catch (falloDelAviso) {
        app.log.error(
          { err: falloDelAviso, canal: entrante.canal },
          'Tampoco se pudo avisar al paciente del fallo',
        );
      }
    }
  };

  await canales.registry.start(entregar);

  /**
   * **Recarga de canales en caliente** (ADR 0060). Cuando alguien guarda un token en el
   * panel, la base cambia; aquí se detecta cada minuto y se **reconstruyen** los adaptadores
   * (Telegram vuelve a conectar con el token nuevo) sin reiniciar el servicio.
   *
   * Se mutan las propiedades del **mismo** objeto `canales`: las rutas lo capturaron por
   * referencia al registrarse, así que siguen viendo el registro nuevo. El asistente y el
   * emisor de avisos se reapuntan igual.
   */
  let firmaCanales = channelSignature(configCanales);
  const recargarCanales = async (): Promise<void> => {
    try {
      const efectivo = await resolverCanales();
      const firma = channelSignature(efectivo);
      if (firma === firmaCanales) return;
      firmaCanales = firma;

      const nuevo = createChannelAdapters(efectivo, {
        onError: (error) => {
          logError(error);
        },
        onAviso: (error, contexto) => {
          logAviso(error, contexto);
        },
      });

      await canales.registry.stop().catch(() => undefined);
      canales.registry = nuevo.registry;
      canales.transport = nuevo.transport;
      canales.modoTelegram = nuevo.modoTelegram;
      canales.modoTest = nuevo.modoTest;
      canales.webhooks = nuevo.webhooks;
      asistente.canales = canales.registry;
      services.adminAlerter = createAdminAlerter({
        config: efectivo,
        onError: (error, contexto) => {
          logAviso(error, contexto);
        },
      });
      await canales.registry.start(entregar);

      app.log.info(
        { modo: canales.modoTelegram, canales: canales.registry.all.map((a) => a.id) },
        'Canales reconstruidos tras un cambio en la configuración',
      );
    } catch (error) {
      app.log.error({ err: error }, 'No se pudieron recargar los canales');
    }
  };

  const canalesTimer = setInterval(() => void recargarCanales(), 60_000);
  canalesTimer.unref?.();

  const telegram = canales.registry.get('telegram');
  const telegramIdentidad = telegram === null ? null : await telegram.identidad().catch(() => null);
  if (canales.modoTelegram === 'real') {
    app.log.info(
      { bot: telegramIdentidad?.usuario ?? 'desconocido' },
      'Bot de Telegram conectado; el sondeo es único (ADR 0008)',
    );
  } else {
    app.log.warn(
      'Sin TELEGRAM_BOT_TOKEN: el servicio arranca en modo simulado (los envíos se registran, no salen a Telegram)',
    );
  }
  for (const adapter of canales.webhooks) {
    app.log.info(
      { canal: adapter.id },
      'Canal con webhook activo: la ruta pública valida la firma del proveedor',
    );
  }

  app.addHook('onClose', async () => {
    clearInterval(queueTimer);
    clearInterval(canalesTimer);
    await deadLetters.stop();
    await canales.registry.stop();
    await outbox.stop();
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.NOTIFICATIONS_PORT, host: config.NOTIFICATIONS_HOST });
  app.log.info(
    {
      port: config.NOTIFICATIONS_PORT,
      host: config.NOTIFICATIONS_HOST,
      modo: canales.modoTelegram,
      bot: config.TELEGRAM_BOT_USERNAME ?? null,
      canales: canales.registry.all.map((adapter) => adapter.id),
    },
    'Servicio notifications escuchando',
  );
};

main().catch((error: unknown) => {
  // Solo el mensaje: nunca valores de configuración (el token vive en el .env).
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
