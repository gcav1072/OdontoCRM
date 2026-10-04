import { describe, expect, it } from 'vitest';

import {
  FICTITIOUS_DOCUMENT_MAX,
  FICTITIOUS_DOCUMENT_MIN,
  isFictitiousDocument,
  resolveTestMode,
  systemMetaSchema,
  TEST_MODE_SEED,
} from './system.js';

/**
 * Reglas del modo test (ADR 0020). La prueba que más importa es la de
 * producción: **el modo test no puede activarse ahí** ni con las dos variables
 * en `true`, que es el criterio de aceptación de la Fase 10.
 */
describe('resolveTestMode', () => {
  it('está desactivado por defecto', () => {
    const estado = resolveTestMode({
      nodeEnv: 'development',
      testMode: false,
      allowTestMode: false,
    });

    expect(estado.enabled).toBe(false);
    expect(estado.state).toBe('disabled');
    expect(estado.message).toContain('TEST_MODE');
  });

  it('se activa solo si se pide Y se permite', () => {
    const estado = resolveTestMode({ nodeEnv: 'development', testMode: true, allowTestMode: true });

    expect(estado.enabled).toBe(true);
    expect(estado.state).toBe('enabled');
    expect(estado.message).toContain('banner');
  });

  it('no se activa si se pide sin permiso explícito', () => {
    const estado = resolveTestMode({
      nodeEnv: 'development',
      testMode: true,
      allowTestMode: false,
    });

    expect(estado.enabled).toBe(false);
    expect(estado.state).toBe('needs_allow');
    expect(estado.message).toContain('ALLOW_TEST_MODE');
  });

  it('no se activa con permiso pero sin pedirlo', () => {
    const estado = resolveTestMode({
      nodeEnv: 'development',
      testMode: false,
      allowTestMode: true,
    });

    expect(estado.enabled).toBe(false);
    expect(estado.state).toBe('disabled');
  });

  it('está bloqueado en producción aunque se pida y se permita', () => {
    const estado = resolveTestMode({ nodeEnv: 'production', testMode: true, allowTestMode: true });

    expect(estado.enabled).toBe(false);
    expect(estado.state).toBe('blocked_in_production');
    expect(estado.message).toContain('production');
  });

  it('el entorno de pruebas de Node también puede activarlo (es lo que usan las suites)', () => {
    expect(resolveTestMode({ nodeEnv: 'test', testMode: true, allowTestMode: true }).enabled).toBe(
      true,
    );
  });
});

describe('isFictitiousDocument', () => {
  it('reconoce el rango reservado con y sin formato', () => {
    expect(isFictitiousDocument('90000000')).toBe(true);
    expect(isFictitiousDocument('V-90.000.001')).toBe(true);
    expect(isFictitiousDocument(FICTITIOUS_DOCUMENT_MIN)).toBe(true);
    expect(isFictitiousDocument(String(FICTITIOUS_DOCUMENT_MAX))).toBe(true);
  });

  it('deja fuera las cédulas reales y lo que no es un número', () => {
    expect(isFictitiousDocument('12345678')).toBe(false);
    expect(isFictitiousDocument('89999999')).toBe(false);
    expect(isFictitiousDocument('100000000')).toBe(false);
    expect(isFictitiousDocument('')).toBe(false);
    expect(isFictitiousDocument('sin cedula')).toBe(false);
  });
});

describe('systemMetaSchema', () => {
  it('acepta lo que publica el gateway en /api/v1/meta', () => {
    const meta = {
      service: 'gateway',
      version: '0.1.0',
      environment: 'development',
      timestamp: new Date().toISOString(),
      testMode: resolveTestMode({ nodeEnv: 'development', testMode: true, allowTestMode: true }),
      fixtures: {
        seed: TEST_MODE_SEED,
        documentMin: FICTITIOUS_DOCUMENT_MIN,
        documentMax: FICTITIOUS_DOCUMENT_MAX,
      },
    };

    expect(systemMetaSchema.parse(meta)).toEqual(meta);
    expect(TEST_MODE_SEED).toBe('odontocrm-2026');
  });
});
