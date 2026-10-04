import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';

import { loadOdontogramConfig } from './config.js';
import { createOdontogramDatabase } from './db/client.js';
import { createOdontogramServer } from './server.js';
import { createPatientSnapshotLookup } from './shared/patient-client.js';

const main = async (): Promise<void> => {
  const config = loadOdontogramConfig();
  const database = createOdontogramDatabase(config);

  /**
   * El publicador se crea después del servidor, así que el gancho se resuelve por
   * referencia: cuando llega una petición, ya apunta al runner.
   */
  const publicador: { kick: () => void } = { kick: () => undefined };

  // Cola y publicador del outbox: cada hallazgo registrado, cambiado, superado o
  // borrado viaja a identity para quedar en la auditoría (y a la Fase 9, para los
  // reportes de salud bucal).
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-odontogram',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);

  const app = await createOdontogramServer({
    config,
    database,
    patientLookup: createPatientSnapshotLookup(config),
    kickOutbox: () => publicador.kick(),
  });

  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    // 500 ms como red de seguridad; con `kick()` el cambio sale al instante.
    intervalMs: 500,
    onCycle: (result) => {
      app.log.debug(result, 'Eventos del odontograma publicados desde el outbox');
    },
    onError: (error) => {
      app.log.error({ err: error }, 'Falló un ciclo del publicador del outbox');
    },
  });
  outbox.start();
  publicador.kick = () => outbox.kick();

  app.addHook('onClose', async () => {
    await outbox.stop();
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.ODONTOGRAM_PORT, host: config.ODONTOGRAM_HOST });
  app.log.info(
    { port: config.ODONTOGRAM_PORT, host: config.ODONTOGRAM_HOST },
    'Servicio odontogram escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
