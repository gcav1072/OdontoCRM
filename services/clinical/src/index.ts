import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { createBrandLookup, createLetterheadLookup, startServer } from '@odontocrm/kernel';
import { createDiskBlobStore, parseEncryptionKey } from '@odontocrm/storage';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadClinicalConfig } from './config.js';
import { createClinicalDatabase } from './db/client.js';
import { createPdfRenderer } from './prescriptions/pdf-renderer.js';
import { createClinicalServer } from './server.js';
import { createOdontogramChartLookup } from './shared/odontogram-client.js';
import { createPatientSnapshotLookup } from './shared/patient-client.js';

const main = async (): Promise<void> => {
  const config = loadClinicalConfig();
  const database = createClinicalDatabase(config);

  /** Adjuntos de la sesión y PDF de los récipes: binarios en disco. */
  const storageRoot = resolve(config.STORAGE_DIR);
  await mkdir(storageRoot, { recursive: true });
  const blobStore = createDiskBlobStore({
    rootDir: storageRoot,
    // Cifrado en reposo de radiografías, adjuntos de sesión y PDF de récipes.
    encryptionKey: parseEncryptionKey(config.STORAGE_ENCRYPTION_KEY),
  });

  /** Un Chromium por proceso para el PDF del récipe (arrancarlo cuesta más que el PDF). */
  const pdfRenderer = createPdfRenderer({
    executablePath: config.PDF_CHROMIUM_PATH,
    timeoutMs: config.PDF_TIMEOUT_MS,
  });

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

  /**
   * Avisos de que los imprimibles están cayendo al **respaldo del código** (la marca o la
   * identidad del consultorio). Se resuelven por referencia, como el publicador: los
   * lectores se construyen antes de que exista el servidor (y su logger). Sin esto, un
   * fallo de la lectura interna dejaría los récipes con colores y membrete de fábrica en
   * silencio —el fallo de «cambié el color en el panel y el papel salió igual»—.
   */
  const avisos: { marca: (motivo: string) => void; identidad: (motivo: string) => void } = {
    marca: () => undefined,
    identidad: () => undefined,
  };

  const app = await createClinicalServer({
    config,
    database,
    patientLookup: createPatientSnapshotLookup(config),
    odontogramLookup: createOdontogramChartLookup(config),
    // El membrete se refresca en segundos: el logo y los datos salen de «Mi perfil» y no
    // pueden quedarse rancios mientras el administrador cree que ya aplicó.
    letterheadLookup: createLetterheadLookup({
      ...config,
      onFallback: (motivo) => avisos.identidad(motivo),
    }),
    brandLookup: createBrandLookup({ ...config, onFallback: (motivo) => avisos.marca(motivo) }),
    blobStore,
    pdfRenderer,
    kickOutbox: () => publicador.kick(),
  });

  avisos.marca = (motivo) =>
    app.log.warn(
      { lectura: 'marca' },
      `Los imprimibles usan la marca del CÓDIGO (no la del panel): ${motivo}. ` +
        'Revisa que identity esté arriba, al día y con el INTERNAL_SERVICE_SECRET compartido.',
    );
  avisos.identidad = (motivo) =>
    app.log.warn(
      { lectura: 'identidad' },
      `Los imprimibles usan el membrete del CÓDIGO (no el del consultorio): ${motivo}. ` +
        'Revisa que identity esté arriba, al día y con el INTERNAL_SERVICE_SECRET compartido.',
    );

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
    await pdfRenderer.close();
    await database.close();
  });

  await startServer(app, { port: config.CLINICAL_PORT, host: config.CLINICAL_HOST });
  app.log.info(
    {
      port: config.CLINICAL_PORT,
      host: config.CLINICAL_HOST,
      storage: storageRoot,
      publicAppUrl: config.PUBLIC_APP_URL,
    },
    'Servicio clinical escuchando',
  );
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- el logger todavía no está configurado
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
