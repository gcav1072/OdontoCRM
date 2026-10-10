import type { BlobStore } from '@odontocrm/storage';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import type pg from 'pg';

import type { ClinicalConfig } from './config.js';
import type { ClinicalDb } from './db/client.js';
import type { PdfRenderer } from './prescriptions/pdf-renderer.js';
import type { PatientSnapshotLookup } from './shared/patient-client.js';
import type { OdontogramChartLookup } from './shared/odontogram-client.js';

/** Todo lo que necesitan las rutas del servicio, en un solo objeto. */
export interface ClinicalServices {
  config: ClinicalConfig;
  db: ClinicalDb;
  pool: pg.Pool;
  patientLookup: PatientSnapshotLookup;
  /** La boca del paciente, para dibujarla en el dossier del expediente. */
  odontogramLookup: OdontogramChartLookup;
  /** La identidad del consultorio (ADR 0056), para el membrete de los documentos. */
  letterheadLookup: LetterheadLookup;
  /** La marca efectiva de los imprimibles (ADR 0060). */
  brandLookup: BrandLookup;
  /** Adjuntos de la sesión y PDF de los récipes: binarios en disco. */
  blobStore: BlobStore;
  /** Chromium para el PDF A5 del récipe (uno por proceso, reutilizado). */
  pdfRenderer: PdfRenderer;
  /** Adelanta el publicador del outbox (lo conecta `index.ts`). */
  kickOutbox?: (() => void) | undefined;
}
