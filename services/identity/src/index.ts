import {
  consumerQueueName,
  createBoss,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { loadPrivateKey, startServer } from '@odontocrm/kernel';
import { existsSync } from 'node:fs';

import { handleDomainEvent } from './audit/event-consumer.js';
import { jwtKeyPaths, loadIdentityConfig } from './config.js';
import { createIdentityDatabase } from './db/client.js';
import { createIdentityServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadIdentityConfig();
  const { privateKeyPath } = jwtKeyPaths(config);

  if (!existsSync(privateKeyPath)) {
    throw new Error(
      `No encuentro la clave privada del JWT en ${privateKeyPath}.\n` +
        'Genérala una vez con:  npm run build:node && npm run keys:generate\n' +
        'Si acabas de escribir el .env, revisa JWT_PRIVATE_KEY_PATH (ver .env.example).',
    );
  }

  const database = createIdentityDatabase(config);
  const privateKey = await loadPrivateKey(privateKeyPath);
  const app = await createIdentityServer({ config, database, privateKey });

  /**
   * Auditoría de otros servicios: identity **consume** los eventos de dominio
   * (hoy, los cambios de paciente) y los convierte en filas de `audit_events`.
   * La cola es compartida (`EVENTS_DATABASE_URL`), por eso puede leer lo que
   * publica el servicio de pacientes.
   */
  const boss = createBoss({
    connectionString: config.EVENTS_DATABASE_URL ?? config.DATABASE_URL,
    applicationName: 'odontocrm-identity-consumer',
  });
  await startBoss(boss);

  const workerId = await registerDomainEventHandler(
    boss,
    async (events) => {
      for (const event of events) {
        try {
          const summary = await handleDomainEvent(database.db, event);
          if (summary.processed) {
            app.log.info(
              { eventType: event.eventType, eventId: event.eventId },
              'Evento convertido en registro de auditoría',
            );
          } else {
            app.log.debug(
              { eventType: event.eventType, reason: summary.reason },
              'Evento ignorado',
            );
          }
        } catch (error) {
          // Se relanza para que la cola reintente: el marcador de idempotencia solo
          // se escribe después de validar la carga.
          app.log.error({ err: error, eventType: event.eventType }, 'No se pudo auditar el evento');
          throw error;
        }
      }
    },
    { queue: consumerQueueName('identity') },
  );

  // El pool se cierra cuando Fastify termina (apagado ordenado).
  app.addHook('onClose', async () => {
    await boss.offWork(workerId).catch(() => undefined);
    await stopBoss(boss);
    await database.close();
  });

  await startServer(app, { port: config.IDENTITY_PORT, host: config.IDENTITY_HOST });
  app.log.info(
    { port: config.IDENTITY_PORT, host: config.IDENTITY_HOST, workerId },
    'Servicio identity escuchando y consumiendo eventos',
  );
};

main().catch((error: unknown) => {
  // Solo el mensaje: puede contener la lista de variables faltantes, nunca sus valores.
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
