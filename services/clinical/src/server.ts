import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction, type LetterheadLookup } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

import type { ClinicalConfig } from './config.js';
import type { ClinicalDatabaseHandle } from './db/client.js';
import type { PdfRenderer } from './prescriptions/pdf-renderer.js';
import { registerClinicalRoutes } from './routes/clinical-routes.js';
import { registerDossierRoutes } from './routes/dossier-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerPrescriptionRoutes } from './routes/prescription-routes.js';
import type { ClinicalServices } from './services.js';
import type { OdontogramChartLookup } from './shared/odontogram-client.js';
import type { PatientSnapshotLookup } from './shared/patient-client.js';

export interface CreateClinicalServerOptions {
  config: ClinicalConfig;
  database: ClinicalDatabaseHandle;
  patientLookup: PatientSnapshotLookup;
  /** La boca del paciente (del servicio de odontograma), para el dossier. */
  odontogramLookup: OdontogramChartLookup;
  /** La identidad del consultorio (del servicio de identidad), para el membrete. */
  letterheadLookup: LetterheadLookup;
  /** Almacén de adjuntos y PDF de récipes. */
  blobStore: BlobStore;
  /** Renderizador del PDF A5 (Chromium). */
  pdfRenderer: PdfRenderer;
  /** Gancho para adelantar los eventos (lo conecta `index.ts` con el publicador). */
  kickOutbox?: (() => void) | undefined;
}

/**
 * Servidor del servicio clínico: historia clínica por secciones, catálogos
 * tipificados, firma, adendas, consentimiento, **sesiones** (la evolución),
 * **adjuntos** de la sesión y **récipes A5** con su verificación pública.
 *
 * Rutas públicas bajo `/api/v1/clinical` (el gateway reenvía sin recortar) y rutas
 * internas bajo `/internal/v1` con el secreto compartido. La verificación del récipe
 * es la única ruta sin sesión.
 */
export const createClinicalServer = async (
  options: CreateClinicalServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'clinical',
    version: config.SERVICE_VERSION,
    logLevel: config.LOG_LEVEL,
    prettyLogs: config.LOG_PRETTY,
    production: isProduction(config),
    checks: [
      // El pool con sus cifras (conexiones en uso, en espera) y el outbox con lo que
      // lleva sin publicar: el panel del administrador los enseña, y un servicio que
      // responde con el outbox atascado deja de parecer sano.
      createPoolCheck('database', database.pool, { max: config.DATABASE_POOL_MAX }),
      createOutboxCheck('outbox', database.pool),
    ],
  });

  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: {
      fileSize: config.MAX_FILE_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 1024 * 8,
    },
  });

  const services: ClinicalServices = {
    config,
    db: database.db,
    pool: database.pool,
    patientLookup: options.patientLookup,
    odontogramLookup: options.odontogramLookup,
    letterheadLookup: options.letterheadLookup,
    blobStore: options.blobStore,
    pdfRenderer: options.pdfRenderer,
    ...(options.kickOutbox === undefined ? {} : { kickOutbox: options.kickOutbox }),
  };

  registerInternalRoutes(app, services);
  registerClinicalRoutes(app, services);
  registerPrescriptionRoutes(app, services);
  registerDossierRoutes(app, services);

  return app;
};
