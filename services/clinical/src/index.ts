import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';

import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { createClinicalServer } from './server.js';
import { createPatientSnapshotLookup } from './shared/patient-client.js';

const main = async (): Promise<void> => {
  const config = loadClinicalConfig();
  const database = createClinicalDatabase(config);

  /**
   * El publicador se crea después del servidor, así que el gancho se resuelve por
   * referencia: cuando llega una petición, ya apunta al runner.
   */
  const publicador: { kick: () => void } = { kick: () => undefined };

  // Cola y publicador del outbox: cada transición de la historia viaja a identity
  // para quedar en la auditoría (y más adelante a los reportes).
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-clinical',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);

  const app = await createClinicalServer({
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
      app.log.debug(result, 'Eventos clínicos publicados desde el outbox');
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

  await startServer(app, { port: config.CLINICAL_PORT, host: config.CLINICAL_HOST });
  app.log.info(
    { port: config.CLINICAL_PORT, host: config.CLINICAL_HOST },
    'Servicio clinical escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
