import type { HealthReport, Role, UserSummary } from '@odontocrm/contracts';
import { permissionsForRoles } from '@odontocrm/contracts';

import { createRng, type SeededRandom } from './prng.js';

/** Usuario ficticio para pruebas y para el modo test. */
export const aUserSummary = (overrides: Partial<UserSummary> = {}): UserSummary => {
  const roles: Role[] = overrides.roles ?? ['secretario'];

  return {
    id: globalThis.crypto.randomUUID(),
    username: 'recepcion',
    fullName: 'María Pérez',
    email: null,
    roles,
    permissions: permissionsForRoles(roles),
    isActive: true,
    mustChangePassword: false,
    needsProfile: false,
    isLocked: false,
    failedAttempts: 0,
    lastLoginAt: null,
    createdAt: '2026-10-02T12:00:00.000Z',
    ...overrides,
  };
};

/** Informe de salud ficticio, útil para probar el tablero de estado. */
export const aHealthReport = (overrides: Partial<HealthReport> = {}): HealthReport => ({
  service: overrides.service ?? 'identity',
  version: overrides.version ?? '0.1.0',
  status: overrides.status ?? 'ok',
  uptimeSeconds: overrides.uptimeSeconds ?? 42,
  timestamp: overrides.timestamp ?? '2026-10-02T12:00:00.000Z',
  checks: overrides.checks ?? [{ name: 'database', status: 'ok', latencyMs: 3 }],
});

/** Nombres y apellidos venezolanos para el seed del modo test (determinista). */
export const SAMPLE_FIRST_NAMES = [
  'María',
  'José',
  'Carmen',
  'Luis',
  'Erika',
  'Rafael',
  'Yulimar',
  'Andrés',
  'Gabriela',
  'Jesús',
  'Daniela',
  'Manuel',
  'Rosa',
  'Pedro',
  'Andreína',
  'Wilmer',
] as const;

export const SAMPLE_LAST_NAMES = [
  'Gómez',
  'Rodríguez',
  'Pérez',
  'Hernández',
  'Blanco',
  'Marcano',
  'Salazar',
  'Rondón',
  'Ferrer',
  'Aponte',
  'Guerra',
  'Narváez',
] as const;

/** Nombre completo ficticio reproducible a partir del generador. */
export const fakeFullName = (rng: SeededRandom): string =>
  `${rng.pick(SAMPLE_FIRST_NAMES)} ${rng.pick(SAMPLE_LAST_NAMES)} ${rng.pick(SAMPLE_LAST_NAMES)}`;

/** Cédula ficticia dentro del rango reservado 90.000.000+ (nunca choca con reales). */
export const fakeCedula = (rng: SeededRandom): string => `V-${rng.int(90_000_000, 99_999_999)}`;

export const testRng = (seed?: string): SeededRandom => createRng(seed);
