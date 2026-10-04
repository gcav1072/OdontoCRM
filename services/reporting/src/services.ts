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
  /** Último error del consumidor o del refresco, para el diagnóstico. */
  lastError: string | null;
}
