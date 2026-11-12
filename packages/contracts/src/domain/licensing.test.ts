import { describe, expect, it } from 'vitest';

import {
  LICENSE_KINDS,
  LICENSE_REQUEST_PREFIX,
  LICENSE_WARN_DAYS,
  PERMISSIONS_ALLOWED_IN_READ_ONLY,
  PERMISSION_ACCESS,
  TRIAL_DAYS,
  decodeLicenseRequest,
  diasDelTipoDeLicencia,
  encodeLicenseRequest,
  esTipoConVencimiento,
  licenseClaimsSchema,
  readOnlyPermissions,
  resolveLicensing,
  type LicenseClaims,
} from './licensing.js';
import { PERMISSIONS, type Permission } from './enums.js';

const DAY_MS = 86_400_000;
const INSTALADA = new Date('2026-11-01T12:00:00.000Z');
const INSTALACION = '6f6f2f7e-3a3a-4c4c-9b9b-1234567890ab';

const licencia = (
  venceEn: string,
  tipo: 'mensual' | 'trimestral' | 'anual' = 'mensual',
): LicenseClaims => ({
  v: 1,
  lic: 'LIC-2026-0001',
  tipo,
  instalacion: INSTALACION,
  cliente: { nombre: 'Consultorio Sonrisa', rif: 'J-12345678-9' },
  emitidaEn: '2026-11-01T12:00:00.000Z',
  venceEn,
  modulos: ['*'],
});

const vitalicia = (): LicenseClaims => ({
  v: 1,
  lic: 'LIC-2026-0002',
  tipo: 'vitalicia',
  instalacion: INSTALACION,
  cliente: { nombre: 'Consultorio Sonrisa' },
  emitidaEn: '2026-11-01T12:00:00.000Z',
  venceEn: null,
  modulos: ['*'],
});

const ahora = (iso: string): Date => new Date(iso);

describe('resolveLicensing · prueba', () => {
  it('el primer día está en prueba con los días completos', () => {
    const estado = resolveLicensing({
      ahora: INSTALADA,
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: null,
    });

    expect(estado.estado).toBe('trial');
    expect(estado.origen).toBe('trial');
    expect(estado.soloLectura).toBe(false);
    expect(estado.diasRestantes).toBe(TRIAL_DAYS);
  });

  it('avisa desde los últimos días de prueba', () => {
    const casi = new Date(INSTALADA.getTime() + (TRIAL_DAYS - LICENSE_WARN_DAYS + 1) * DAY_MS);
    const estado = resolveLicensing({
      ahora: casi,
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: null,
    });

    expect(estado.estado).toBe('trial_por_vencer');
    expect(estado.soloLectura).toBe(false);
    expect(estado.mensaje).toContain('prueba');
  });

  it('al cumplirse los 30 días la prueba vence y el sistema queda en modo consulta', () => {
    const fin = new Date(INSTALADA.getTime() + TRIAL_DAYS * DAY_MS);
    const estado = resolveLicensing({
      ahora: fin,
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: null,
    });

    expect(estado.estado).toBe('trial_vencida');
    expect(estado.soloLectura).toBe(true);
    expect(estado.diasRestantes).toBe(0);
  });
});

describe('resolveLicensing · licencia', () => {
  it('una licencia vigente manda sobre la prueba', () => {
    const estado = resolveLicensing({
      ahora: ahora('2026-12-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: licencia('2027-01-01T12:00:00.000Z'),
    });

    expect(estado.estado).toBe('licencia_vigente');
    expect(estado.origen).toBe('licencia');
    expect(estado.tipo).toBe('mensual');
    expect(estado.soloLectura).toBe(false);
  });

  it('avisa cuando la licencia está por vencer', () => {
    const estado = resolveLicensing({
      ahora: ahora('2027-01-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: licencia('2027-01-05T12:00:00.000Z'),
    });

    expect(estado.estado).toBe('licencia_por_vencer');
    expect(estado.diasRestantes).toBe(4);
    expect(estado.soloLectura).toBe(false);
  });

  it('una licencia vencida deja el sistema en modo consulta', () => {
    const estado = resolveLicensing({
      ahora: ahora('2027-01-02T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: licencia('2027-01-01T12:00:00.000Z'),
    });

    expect(estado.estado).toBe('licencia_vencida');
    expect(estado.soloLectura).toBe(true);
    expect(estado.mensaje).toContain('modo consulta');
  });
});

describe('resolveLicensing · licencia vitalicia', () => {
  it('nunca vence, no tiene días restantes y no pasa a modo consulta', () => {
    const estado = resolveLicensing({
      ahora: ahora('2099-01-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto: null,
      licencia: vitalicia(),
    });

    expect(estado.estado).toBe('licencia_vigente');
    expect(estado.soloLectura).toBe(false);
    expect(estado.tipo).toBe('vitalicia');
    expect(estado.diasRestantes).toBeNull();
    expect(estado.venceEn).toBeNull();
    expect(estado.mensaje).toContain('no vence');
  });

  it('el reloj atrasado sigue mandando incluso con una vitalicia', () => {
    const estado = resolveLicensing({
      ahora: ahora('2026-12-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto: ahora('2027-01-01T12:00:00.000Z'),
      licencia: vitalicia(),
    });

    expect(estado.estado).toBe('reloj_atrasado');
    expect(estado.soloLectura).toBe(true);
    expect(estado.venceEn).toBeNull();
  });
});

describe('claims · coherencia entre tipo y vencimiento', () => {
  it('una vitalicia sin fecha es válida', () => {
    expect(licenseClaimsSchema.safeParse(vitalicia()).success).toBe(true);
  });

  it('una vitalicia CON fecha se rechaza', () => {
    const conFecha = { ...vitalicia(), venceEn: '2027-01-01T00:00:00.000Z' };
    expect(licenseClaimsSchema.safeParse(conFecha).success).toBe(false);
  });

  it('una licencia con vencimiento SIN fecha se rechaza', () => {
    const sinFecha = { ...licencia('2027-01-01T00:00:00.000Z'), venceEn: null };
    expect(licenseClaimsSchema.safeParse(sinFecha).success).toBe(false);
  });
});

describe('resolveLicensing · reloj atrasado', () => {
  it('si el reloj retrocede más de la tolerancia, el sistema pasa a solo lectura', () => {
    const ultimaVezVisto = ahora('2026-12-20T12:00:00.000Z');
    const estado = resolveLicensing({
      ahora: ahora('2026-12-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto,
      licencia: licencia('2027-06-01T12:00:00.000Z'),
    });

    expect(estado.estado).toBe('reloj_atrasado');
    expect(estado.soloLectura).toBe(true);
    expect(estado.mensaje).toContain('reloj');
  });

  it('un atraso dentro de la tolerancia no cambia el estado', () => {
    const ultimaVezVisto = ahora('2026-12-01T19:00:00.000Z');
    const estado = resolveLicensing({
      ahora: ahora('2026-12-01T12:00:00.000Z'),
      instaladaEn: INSTALADA,
      ultimaVezVisto,
      licencia: licencia('2027-06-01T12:00:00.000Z'),
    });

    expect(estado.estado).toBe('licencia_vigente');
    expect(estado.soloLectura).toBe(false);
  });
});

describe('tipos y duraciones', () => {
  it('mensual 30, trimestral 90 y anual 365 días; la vitalicia no tiene días', () => {
    expect(diasDelTipoDeLicencia('mensual')).toBe(30);
    expect(diasDelTipoDeLicencia('trimestral')).toBe(90);
    expect(diasDelTipoDeLicencia('anual')).toBe(365);
    expect(diasDelTipoDeLicencia('vitalicia')).toBeNull();
  });

  it('solo la vitalicia está fuera de los tipos con vencimiento', () => {
    expect(esTipoConVencimiento('vitalicia')).toBe(false);
    for (const tipo of LICENSE_KINDS.filter((kind) => kind !== 'vitalicia')) {
      expect(esTipoConVencimiento(tipo)).toBe(true);
    }
  });
});

describe('código de solicitud', () => {
  const solicitud = {
    v: 1 as const,
    instalacion: INSTALACION,
    cliente: { nombre: 'Consultorio Sonrisa', rif: 'J-12345678-9' },
    tipoSolicitado: 'anual' as const,
    generadaEn: '2026-11-11T13:00:00.000Z',
  };

  it('va y vuelve sin perder datos', () => {
    const codigo = encodeLicenseRequest(solicitud);

    expect(codigo.startsWith(LICENSE_REQUEST_PREFIX)).toBe(true);
    expect(decodeLicenseRequest(codigo)).toEqual(solicitud);
  });

  it('acepta una solicitud de vitalicia', () => {
    const pedida = { ...solicitud, tipoSolicitado: 'vitalicia' as const };
    expect(decodeLicenseRequest(encodeLicenseRequest(pedida))).toEqual(pedida);
  });

  it('rechaza cualquier cosa que no sea una solicitud', () => {
    expect(decodeLicenseRequest('hola')).toBeNull();
    expect(decodeLicenseRequest(`${LICENSE_REQUEST_PREFIX}no-es-base64`)).toBeNull();
    expect(decodeLicenseRequest(`${LICENSE_REQUEST_PREFIX}${btoa('{}')}`)).toBeNull();
  });
});

describe('permisos en modo consulta', () => {
  it('clasifica todos los permisos del contrato (sin huecos)', () => {
    for (const permiso of PERMISSIONS) {
      expect(PERMISSION_ACCESS[permiso], `${permiso} sin clasificar`).toBeDefined();
    }
    expect(Object.keys(PERMISSION_ACCESS)).toHaveLength(PERMISSIONS.length);
  });

  it('deja solo lectura y conserva la activación de licencia', () => {
    const todos: Permission[] = [...PERMISSIONS];
    const quedan = readOnlyPermissions(todos);

    expect(quedan).toContain('patients:read');
    expect(quedan).toContain('clinical:read');
    expect(quedan).toContain('reports:clinical');
    expect(quedan).toContain('screens:display');
    expect(quedan).not.toContain('patients:write');
    expect(quedan).not.toContain('users:manage');
    expect(quedan).not.toContain('settings:manage');
    for (const permiso of PERMISSIONS_ALLOWED_IN_READ_ONLY) {
      expect(quedan).toContain(permiso);
    }
  });
});
