/**
 * Mundo de prueba del modo test (ADR 0020).
 *
 * - `buildTestWorld()` — los datos ficticios completos, deterministas y puros.
 * - `buildTestWorldEvents()` — los eventos que habría publicado el sistema.
 * - `worldFingerprints()` — las huellas que compara `seed:verify`.
 * - `clinical-content` — el contenido clínico (secciones, sesiones y récipes) que
 *   usan los servicios de historia clínica.
 */
export * from './billing.js';
export * from './clinic-time.js';
export * from './clinical-content.js';
export * from './events.js';
export * from './ids.js';
export * from './world.js';
