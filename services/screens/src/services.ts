import type { ScreensConfig } from './config.js';
import type { ScreensDb } from './db/client.js';
import type { ChairCatalog, ClinicalAlertLookup } from './internal-client.js';
import type { ScreenBroadcaster } from './sala/broadcast.js';
import type { LetterheadLookup } from '@odontocrm/kernel';
import type pg from 'pg';

/** Todo lo que necesitan las rutas y el consumidor del servicio de pantallas. */
export interface ScreensServices {
  config: ScreensConfig;
  db: ScreensDb;
  pool: pg.Pool;
  /** Reparto del estado a las pantallas conectadas por SSE. */
  broadcast: ScreenBroadcaster;
  /** Último error del consumidor de eventos, para mostrarlo en la administración. */
  lastError: string | null;
  /**
   * Datos críticos del paciente en curso, leídos de la historia clínica. Es lo
   * que hace que la pantalla del consultorio muestre alergias y crónicos.
   */
  alertLookup: ClinicalAlertLookup;
  /**
   * Catálogo de consultorios (sillones) activos, leído de la agenda. La pantalla
   * compartida pinta un tile por consultorio.
   */
  chairCatalog: ChairCatalog;
  /**
   * La **marca del consultorio** (nombre y logo) leída de identity con caché. La
   * pantalla kiosko la pide para su cabecera y su marca de agua; el mismo lector
   * alimenta `aplicarDatosDelConsultorio`, que refresca `config.CLINIC_NAME`.
   */
  clinicLookup: LetterheadLookup;
}
