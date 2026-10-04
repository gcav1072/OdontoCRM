import {
  consumerQueueName,
  createBoss,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { startServer } from '@odontocrm/kernel';

import { loadScreensConfig } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createScreensDatabase } from './db/client.js';
import { createPatientLookup, createAlertLookup } from './internal-client.js';
import { createScreenBroadcaster } from './sala/broadcast.js';
import { consultationState, lobbyState } from './sala/estado-service.js';
import { createScreensServer } from './server.js';
import type { ScreensServices } from './services.js';

const main = async (): Promise<void> => {
  const config = loadScreensConfig();
  const database = createScreensDatabase(config);
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

  app.addHook('onClose', async () => {
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
