import {
  consumerQueueName,
  createBoss,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startAlertingDeadLetterWatcher,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { createLetterheadLookup, startServer } from '@odontocrm/kernel';

import { loadReportingConfig } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createReportingDatabase } from './db/client.js';
import { createPdfRenderer } from './pdf-renderer.js';
import { refreshMaterializedViews, scheduleNightlyRefresh } from './refresh.js';
import { createReportingServer } from './server.js';
import type { ReportingServices } from './services.js';

/**
 * Arranque del servicio de reportes (puerto 4008).
 *
 * Orden: configuración → base → cola de eventos (el read model se alimenta de los
 * eventos de los demás servicios) → refresco nocturno → servidor. Al cerrar se para
 * el job, el consumidor, el navegador del PDF y la base.
 *
 * **No hay outbox propio**: este servicio no publica eventos, solo los consume.
 */
const main = async (): Promise<void> => {
  const config = loadReportingConfig();
  const database = createReportingDatabase(config);
  const pdf = createPdfRenderer({
    executablePath: config.PDF_CHROMIUM_PATH,
    timeoutMs: config.PDF_TIMEOUT_MS,
  });

  const services: Omit<ReportingServices, 'config' | 'db' | 'pool'> = {
    pdf,
    letterheadLookup: createLetterheadLookup(config),
    lastError: null,
  };

  const app = await createReportingServer({ config, database, services });

  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-reporting',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);
  await registerDomainEventHandler(
    boss,
    async (events) => {
      try {
        const resultado = await handleDomainEvents({ db: database.db }, events);
        if (resultado.aplicados > 0) {
          app.log.info(
            {
              aplicados: resultado.aplicados,
              duplicados: resultado.duplicados,
              ignorados: resultado.ignorados,
              vistas: resultado.refresh?.views ?? [],
              lote: events.length,
            },
            'Read model actualizado',
          );
        }
        if (resultado.refresh !== null && !resultado.refresh.ok) {
          services.lastError = resultado.refresh.error;
          app.log.error({ err: resultado.refresh.error }, 'No se pudieron refrescar las vistas');
        }
      } catch (error) {
        services.lastError = error instanceof Error ? error.message : String(error);
        app.log.error({ err: error }, 'No se pudo aplicar el lote de eventos');
        throw error;
      }
    },
    {
      queue: consumerQueueName('reporting'),
      // Un segundo de sondeo: los reportes se miran a diario, no en vivo.
      pollingIntervalSeconds: 1,
    },
  );

  /**
   * Refresco nocturno: los eventos no cuentan todo lo que cambia solo (la pirámide de
   * edad envejece, por ejemplo), así que a la hora configurada se rehacen las vistas
   * y queda la fila de traza con `trigger: 'nocturno'`.
   */
  const nocturno = scheduleNightlyRefresh({
    hour: config.REPORTING_REFRESH_HOUR,
    run: async () => {
      const resultado = await refreshMaterializedViews(database.db, { trigger: 'nocturno' });
      if (resultado.ok) {
        app.log.info({ vistas: resultado.views }, 'Vistas materializadas refrescadas');
      } else {
        services.lastError = resultado.error;
        app.log.error({ err: resultado.error }, 'Falló el refresco nocturno');
      }
      return resultado;
    },
    onError: (error) => {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'Falló el refresco nocturno');
    },
  });
  nocturno.start();

  /**
   * Vigilante de la **cola de descarte**: apunta los eventos que agotan sus reintentos y
   * avisa al administrador (el aviso lo manda notificaciones, que es quien tiene el bot).
   * Sin esto, un evento perdido se quedaba en el buzón de la cola y nadie lo sabía.
   */
  const deadLetters = await startAlertingDeadLetterWatcher({
    boss,
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-reporting-dlq',
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
      source: 'reporting',
    },
  });
  app.addHook('onClose', async () => {
    await deadLetters.stop();
    nocturno.stop();
    await stopBoss(boss);
    await pdf.close();
    await database.close();
  });

  await startServer(app, { port: config.REPORTING_PORT, host: config.REPORTING_HOST });
  app.log.info(
    {
      port: config.REPORTING_PORT,
      host: config.REPORTING_HOST,
      refrescoNocturno: config.REPORTING_REFRESH_HOUR,
    },
    'Servicio reporting escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
