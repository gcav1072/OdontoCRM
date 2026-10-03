import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';
import { mkdir } from 'node:fs/promises';

import { loadPatientsConfig, storageRoot } from './config.js';
import { createPatientsDatabase } from './db/client.js';
import { createDiskBlobStore } from './files/blob-store.js';
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

  app.addHook('onClose', async () => {
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
