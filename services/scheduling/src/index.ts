import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';

import { loadSchedulingConfig } from './config.js';
import { createSchedulingDatabase } from './db/client.js';
import { createSchedulingServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadSchedulingConfig();
  const database = createSchedulingDatabase(config);

  // Publicador del outbox: cada cambio de agenda viaja a la cola compartida, donde
  // identity lo convierte en auditoría y (Fase 4) notificaciones lo envía al paciente.
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-scheduling',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);

  const app = await createSchedulingServer({ config, database });

  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    intervalMs: 2_000,
    onCycle: (result) => {
      app.log.debug(result, 'Eventos de agenda publicados desde el outbox');
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

  await startServer(app, { port: config.SCHEDULING_PORT, host: config.SCHEDULING_HOST });
  app.log.info(
    {
      port: config.SCHEDULING_PORT,
      host: config.SCHEDULING_HOST,
      cupoPorDefecto: config.DEFAULT_DAY_CAPACITY,
      toleranciaMinutos: config.NO_SHOW_GRACE_MINUTES,
    },
    'Servicio scheduling escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
