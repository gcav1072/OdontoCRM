import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { aplicarDatosDelConsultorio, createLetterheadLookup, startServer } from '@odontocrm/kernel';

import { loadSchedulingConfig } from './config.js';
import { createSchedulingDatabase } from './db/client.js';
import { createSchedulingServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadSchedulingConfig();
  const database = createSchedulingDatabase(config);

  // Nombre y dirección del consultorio para los avisos: base de datos > `CLINIC`,
  // con `CLINIC_*` del entorno por encima. Se refresca cada 5 minutos.
  const letterheadLookup = createLetterheadLookup(config);
  await aplicarDatosDelConsultorio(config, letterheadLookup);
  const refrescoIdentidad = setInterval(
    () => void aplicarDatosDelConsultorio(config, letterheadLookup),
    5 * 60_000,
  );
  refrescoIdentidad.unref();

  /**
   * El publicador del outbox se crea más abajo, pero las rutas necesitan poder
   * adelantarlo desde ya (un llamado tiene que verse en el displaylobby al
   * instante). Este hueco se rellena en cuanto existe.
   */
  const publicador: { kick: () => void } = { kick: () => undefined };

  // Publicador del outbox: cada cambio de agenda viaja a la cola compartida, donde
  // identity lo convierte en auditoría y (Fase 4) notificaciones lo envía al paciente.
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-scheduling',
  });
  await startBoss(boss);
  await ensureDomainEventsQueue(boss);

  const app = await createSchedulingServer({
    config,
    database,
    // El publicador se crea después del servidor, así que el gancho se resuelve
    // por referencia: cuando llega una petición, ya está apuntando al runner.
    kickOutbox: () => publicador.kick(),
  });

  const outbox = createOutboxRunner({
    pool: database.pool,
    boss,
    // 500 ms como red de seguridad (con `kick()` el cambio sale al instante): el
    // caso que lo necesita es el llamado, que se ve en el displaylobby.
    intervalMs: 500,
    onCycle: (result) => {
      app.log.debug(result, 'Eventos de agenda publicados desde el outbox');
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
