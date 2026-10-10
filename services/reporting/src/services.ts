import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import type pg from 'pg';

import type { ReportingConfig } from './config.js';
import type { ReportingDb } from './db/client.js';
import type { PdfRenderer } from './pdf-renderer.js';

/** Todo lo que necesitan las rutas del servicio de reportes. */
export interface ReportingServices {
  config: ReportingConfig;
  db: ReportingDb;
  pool: pg.Pool;
  /** Chromium del PDF del reporte (un navegador por proceso). */
  pdf: PdfRenderer;
  /** La identidad del consultorio (ADR 0056), para el membrete del reporte. */
  letterheadLookup: LetterheadLookup;
  /** La marca efectiva de los imprimibles (ADR 0060). */
  brandLookup: BrandLookup;
  /** Último error del consumidor o del refresco, para el diagnóstico. */
  lastError: string | null;
}
