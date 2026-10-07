import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startAlertingDeadLetterWatcher,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';
import { createDiskBlobStore } from '@odontocrm/storage';

import { loadBillingConfig } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createBillingDatabase } from './db/client.js';
import { createPdfRenderer } from './pdf-renderer.js';
import { createBillingServer } from './server.js';
import type { BillingServices } from './services.js';
import { createBillingPatientLookup } from './shared/patient-client.js';

/**
 * Arranque del servicio de facturación (puerto 4009).
 *
 * Orden: configuración → base → cola de eventos (el borrador nace del cierre de la sesión clínica) →
 * servidor. Al cerrar se paran el consumidor y la base.
 *
 * Todavía **no hay publicador**: el borrador no publica evento (es un acto interno que se puede
 * descartar). El primer acto de dinero que publica —emitir, cobrar— llega con la sesión B y traerá
 * consigo el publicador del outbox.
 */
const main = async (): Promise<void> => {
  const config = loadBillingConfig();
  const database = createBillingDatabase(config);
  const patientLookup = createBillingPatientLookup(config);

  // El publicador se crea después del servidor, así que el gancho se resuelve por referencia.
  let kick: () => void = () => undefined;
  const blobStore = createDiskBlobStore({ rootDir: config.STORAGE_DIR });
  const pdf = createPdfRenderer({
    executablePath: config.PDF_CHROMIUM_PATH,
    timeoutMs: config.PDF_TIMEOUT_MS,
  });
  const services: Omit<BillingServices, 'config' | 'db' | 'pool'> = {
    patientLookup,
    blobStore,
    pdf,
    kickOutbox: () => kick(),
    lastError: null,
  };

  const app = await createBillingServer({ config, database, services });

  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-billing',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);
  await registerDomainEventHandler(
    boss,
    async (events) => {
      try {
        const resultado = await handleDomainEvents({ db: database.db, patientLookup }, events);
        if (resultado.creados > 0) {
          app.log.info(resultado, 'Borradores de factura creados');
        }
      } catch (error) {
        services.lastError = error instanceof Error ? error.message : String(error);
        app.log.error({ err: error }, 'No se pudo crear el borrador de factura');
        // Se relanza para que la cola lo reintente: un documento fiscal no lleva un nombre inventado.
        throw error;
      }
    },
    {
      queue: consumerQueueName('billing'),
      pollingIntervalSeconds: 1,
    },
  );

  /**
   * Publicador del outbox: la tasa del día y, más adelante, cada acto de dinero (emitir, cobrar)
   * dejan su evento en la auditoría. `kick()` lo adelanta para que se vea sin esperar el ciclo.
   */
  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    intervalMs: 500,
    onError: (error) => {
      services.lastError = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error }, 'Falló un ciclo del publicador del outbox');
    },
  });
  outbox.start();

  /**
   * Vigilante de la **cola de descarte**: apunta los eventos que agotan sus reintentos y
   * avisa al administrador (el aviso lo manda notificaciones, que es quien tiene el bot).
   * Sin esto, un evento perdido se quedaba en el buzón de la cola y nadie lo sabía.
   */
  const deadLetters = await startAlertingDeadLetterWatcher({
    boss,
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-billing-dlq',
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
      source: 'billing',
    },
  });
  kick = () => outbox.kick();

  app.addHook('onClose', async () => {
    await deadLetters.stop();
    await outbox.stop();
    await pdf.close();
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.BILLING_PORT, host: config.BILLING_HOST });
  app.log.info(
    { port: config.BILLING_PORT, host: config.BILLING_HOST },
    'Servicio billing escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
