import {
  FICTITIOUS_DOCUMENT_MAX,
  FICTITIOUS_DOCUMENT_MIN,
  TEST_MODE_SEED,
  type SystemMeta,
} from '@odontocrm/contracts';
import { testModeStatus } from '@odontocrm/kernel';

import type { GatewayConfig } from './config.js';

/**
 * Lo que la puerta publica en `GET /api/v1/meta`, **sin sesión**: qué servicio
 * responde, con qué versión, en qué entorno y si el modo test está activo.
 *
 * No lleva datos de pacientes ni secretos: la interfaz lo usa para el banner
 * rojo antes de que nadie inicie sesión (en la pantalla de acceso también tiene
 * que verse) y el tablero de estado de la Fase 10 para saber qué hay desplegado.
 */
export const buildSystemMeta = (config: GatewayConfig, now: Date = new Date()): SystemMeta => ({
  service: 'gateway',
  version: config.SERVICE_VERSION,
  environment: config.NODE_ENV,
  timestamp: now.toISOString(),
  testMode: testModeStatus(config),
  fixtures: {
    seed: TEST_MODE_SEED,
    documentMin: FICTITIOUS_DOCUMENT_MIN,
    documentMax: FICTITIOUS_DOCUMENT_MAX,
  },
});
