import { startServer } from '@odontocrm/kernel';

import { loadGatewayConfig } from './config.js';
import { createGatewayServer } from './server.js';

const main = async (): Promise<void> => {
  const config = loadGatewayConfig();
  const app = await createGatewayServer({ config });

  await startServer(app, { port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });
  app.log.info(
    { port: config.GATEWAY_PORT, host: config.GATEWAY_HOST },
    'Gateway escuchando: la interfaz y las pantallas entran por aquí',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
