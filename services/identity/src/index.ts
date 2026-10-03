import { startServer } from '@odontocrm/kernel';

import { loadIdentityConfig } from './config.js';
import { createIdentityDatabase } from './db/client.js';
import { createIdentityServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadIdentityConfig();
  const database = createIdentityDatabase(config);
  const app = createIdentityServer({ config, pool: database.pool });

  // El pool se cierra cuando Fastify termina (apagado ordenado).
  app.addHook('onClose', async () => {
    await database.close();
  });

  await startServer(app, { port: config.IDENTITY_PORT, host: config.IDENTITY_HOST });
  app.log.info(
    { port: config.IDENTITY_PORT, host: config.IDENTITY_HOST },
    'Servicio identity escuchando',
  );
};

main().catch((error: unknown) => {
  // Solo el mensaje: puede contener la lista de variables faltantes, nunca sus valores.
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
