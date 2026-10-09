import type { LetterheadLookup } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import type pg from 'pg';

import type { BillingConfig } from './config.js';
import type { BillingDb } from './db/client.js';
import type { PdfRenderer } from './pdf-renderer.js';
import type { BillingPatientLookup } from './shared/patient-client.js';

/** Todo lo que necesitan las rutas del servicio de facturación. */
export interface BillingServices {
  config: BillingConfig;
  db: BillingDb;
  pool: pg.Pool;
  /** Ficha del paciente para la instantánea del documento (por la red interna). */
  patientLookup: BillingPatientLookup;
  /** Almacén de los documentos archivados: factura, recibo y nota de crédito (ADR 0036/0048). */
  blobStore: BlobStore;
  /** Chromium del PDF de la factura (un navegador por proceso). */
  pdf: PdfRenderer;
  /** La identidad del consultorio (ADR 0056), para el miembrete de los documentos de cobro. */
  letterheadLookup: LetterheadLookup;
  /** Avanza el publicador del outbox para que la auditoría aparezca al instante. */
  kickOutbox?: (() => void) | undefined;
  /** Último error del consumidor, para el diagnóstico. */
  lastError: string | null;
}
