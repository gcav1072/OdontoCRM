import {
  consumerQueueName,
  createBoss,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startAlertingDeadLetterWatcher,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { aplicarDatosDelConsultorio, createLetterheadLookup, startServer } from '@odontocrm/kernel';
import type { DomainEvent } from '@odontocrm/events';

import { loadScreensConfig } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createScreensDatabase } from './db/client.js';
import { createPatientLookup, createAlertLookup } from './internal-client.js';
import { createScreenBroadcaster } from './sala/broadcast.js';
import { staffSignals } from './sala/staff-signal.js';
import { consultationState, lobbyState } from './sala/estado-service.js';
import { createScreensServer } from './server.js';
import type { ScreensServices } from './services.js';

const main = async (): Promise<void> => {
  const config = loadScreensConfig();
  const database = createScreensDatabase(config);

  // El nombre del consultorio para el encabezado de las pantallas (ADR 0056).
  // Se refresca cada 5 minutos; `CLINIC_*` del entorno manda si está puesto.
  const letterheadLookup = createLetterheadLookup(config);
  await aplicarDatosDelConsultorio(config, letterheadLookup);
  const refrescoIdentidad = setInterval(
    () => void aplicarDatosDelConsultorio(config, letterheadLookup),
    5 * 60_000,
  );
  refrescoIdentidad.unref();
  const broadcast = createScreenBroadcaster();
  const patientLookup = createPatientLookup(config);
  /** Datos críticos del paciente en curso (alergias, crónicos) para el consultorio. */
  const alertLookup = createAlertLookup(config);

  const services: Omit<ScreensServices, 'config' | 'db' | 'pool'> = {
    broadcast,
    lastError: null,
    alertLookup,
  };

  const app = await createScreensServer({ config, database, services });

  /** Recalcula y reparte el estado: es lo que ven las pantallas conectadas. */
  const refrescar = async (): Promise<void> => {
    broadcast.publicar('lobby', await lobbyState(database.db, config));
    broadcast.publicar('consultorio', await consultationState(database.db, { alertLookup }));
  };

  /**
   * Avisa al personal de lo que acaba de cambiar.
   *
   * Va **aparte** del refresco de la sala: el aviso sale con **cualquier** lote que traiga
   * un tema interesante —también los que la proyección de la sala ignora, como cerrar una
   * sesión o emitir una factura—, mientras que el estado solo se reparte cuando la sala
   * cambió de verdad. Si dependiera del refresco, la caja no se enteraría de un cobro.
   */
  const avisarAlPersonal = (events: readonly DomainEvent[]): void => {
    for (const senal of staffSignals(events)) {
      broadcast.publicar('staff', senal);
    }
  };

  // Cola de eventos: la sala se alimenta de lo que pasa en la agenda.
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-screens',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);
  await registerDomainEventHandler(
    boss,
    async (events) => {
      try {
        // El personal se entera **siempre**; la sala solo cuando su estado cambió.
        avisarAlPersonal(events);
        const resultados = await handleDomainEvents(
          { db: database.db, config, patientLookup, onCambio: refrescar },
          events,
        );
        const aplicados = resultados.filter((resultado) => resultado.estado === 'aplicado').length;
        if (aplicados > 0) {
          app.log.info(
            { aplicados, lote: events.length, pantallas: broadcast.conectadas() },
            'Estado de la sala actualizado',
          );
        }
      } catch (error) {
        services.lastError = error instanceof Error ? error.message : String(error);
        app.log.error({ err: error }, 'No se pudo aplicar el lote de eventos de agenda');
        throw error;
      }
    },
    {
      queue: consumerQueueName('screens'),
      // Medio segundo: la sala tiene que reaccionar al llamado, no solo auditarse.
      pollingIntervalSeconds: 0.5,
    },
  );

  /**
   * Vigilante de la **cola de descarte**: apunta los eventos que agotan sus reintentos y
   * avisa al administrador (el aviso lo manda notificaciones, que es quien tiene el bot).
   * Sin esto, un evento perdido se quedaba en el buzón de la cola y nadie lo sabía.
   */
  const deadLetters = await startAlertingDeadLetterWatcher({
    boss,
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-screens-dlq',
    onError: (error) => {
      app.log.error({ err: error }, 'Falló el vigilante de la cola de descarte');
    },
    onRecorded: (record) => {
      app.log.error(
        { cola: record.sourceQueue, evento: record.eventType, error: record.error },
        'Evento perdido: agotó sus reintentos',
      );
    },
    alert: {
      notificationsUrl: config.NOTIFICATIONS_URL,
      internalSecret: config.INTERNAL_SERVICE_SECRET,
      source: 'screens',
    },
  });
  app.addHook('onClose', async () => {
    await deadLetters.stop();
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.SCREENS_PORT, host: config.SCREENS_HOST });
  app.log.info(
    {
      port: config.SCREENS_PORT,
      host: config.SCREENS_HOST,
      sillon: config.CHAIR_LABEL,
      llamadosEnPantalla: config.SCREEN_CALLS_SHOWN,
    },
    'Servicio screens escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
