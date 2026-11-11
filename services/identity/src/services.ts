import type { PrivateKey, PublicKey } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import type pg from 'pg';

import type { IdentityConfig } from './config.js';
import type { IdentityDb } from './db/client.js';

/** Todo lo que necesitan las rutas del servicio, en un solo objeto. */
export interface IdentityServices {
  config: IdentityConfig;
  db: IdentityDb;
  pool: pg.Pool;
  privateKey: PrivateKey;
  /**
   * Almacén compartido para el **logo** que sube el titular (ADR 0056), o `null` si
   * no está configurado (el servicio funciona igual: el membrete usa el logo del
   * repositorio).
   */
  blobStore: BlobStore | null;
  /**
   * Clave **pública** con la que se verifican las licencias offline (ADR 0075), o
   * `null` si esta instalación no la tiene: entonces la activación responde un
   * error claro y el resto (prueba y modo consulta) sigue funcionando.
   */
  licensePublicKey: PublicKey | null;
}
