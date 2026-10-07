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
import { mkdir } from 'node:fs/promises';

import { loadPatientsConfig, storageRoot } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createPatientsDatabase } from './db/client.js';
import { createPatientsServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadPatientsConfig();
  const database = createPatientsDatabase(config);

  const root = storageRoot(config);
  await mkdir(root, { recursive: true });
  const blobStore = createDiskBlobStore({ rootDir: root });

  // Cola y publicador del outbox: los cambios de paciente viajan a identity para
  // quedar en la auditoría (y más adelante a los reportes). La cola es compartida
  // entre servicios (`EVENTS_DATABASE_URL`), porque pg-boss guarda sus tablas en
  // una sola base.
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-patients',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);

  const app = await createPatientsServer({ config, database, blobStore });

  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    intervalMs: 2_000,
    onCycle: (result) => {
      app.log.debug(result, 'Eventos publicados desde el outbox');
    },
    onError: (error) => {
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
    applicationName: 'odontocrm-patients-dlq',
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
      source: 'patients',
    },
  });

  // Consumidor propio: la agenda avisa de que al paciente se le asignó una cita y
  // aquí se le quita el «en espera de cita». No es urgente (nadie mira la ficha en
  // el segundo en que se agenda), así que con el sondeo por defecto basta.
  await registerDomainEventHandler(
    boss,
    async (events) => {
      const resultados = await handleDomainEvents({ db: database.db }, events);
      const aplicados = resultados.filter((resultado) => resultado.estado === 'aplicado');
      if (aplicados.length > 0) {
        app.log.info(
          { aplicados: aplicados.length, lote: events.length },
          'Pacientes con cita pasados a activo',
        );
      }
    },
    { queue: consumerQueueName('patients') },
  );

  app.addHook('onClose', async () => {
    await deadLetters.stop();
    await outbox.stop();
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.PATIENTS_PORT, host: config.PATIENTS_HOST });
  app.log.info(
    { port: config.PATIENTS_PORT, host: config.PATIENTS_HOST, storage: root },
    'Servicio patients escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
