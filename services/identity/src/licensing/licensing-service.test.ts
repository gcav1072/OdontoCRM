import type { LicenseClaims, LicensingStatus } from '@odontocrm/contracts';
import { decodeLicenseRequest } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import type { InstallationRow } from '../db/schema.js';
import {
  buildLicenseRequest,
  parseStoredLicense,
  toLicenseView,
  toPublicView,
} from './licensing-service.js';

/**
 * Las **piezas puras** del licenciamiento (ADR 0075): las vistas que publica la API
 * y el código de solicitud que viaja al proveedor. Se prueban sin base de datos ni
 * servidor: son las que no pueden cambiar de forma sin romper el emisor o la web.
 */

const INSTALACION = '11111111-1111-4111-8111-111111111111';

const claims = (overrides: Partial<LicenseClaims> = {}): LicenseClaims => ({
  v: 1,
  lic: 'LIC-2026-0001',
  tipo: 'mensual',
  instalacion: INSTALACION,
  cliente: { nombre: 'Consultorio de prueba', rif: 'J-12345678-9' },
  emitidaEn: '2026-11-11T12:00:00.000Z',
  venceEn: '2026-12-11T12:00:00.000Z',
  modulos: ['*'],
  ...overrides,
});

const estado = (overrides: Partial<LicensingStatus> = {}): LicensingStatus => ({
  estado: 'trial',
  soloLectura: false,
  origen: 'trial',
  tipo: null,
  diasRestantes: 30,
  venceEn: '2026-12-11T12:00:00.000Z',
  mensaje: 'Estás en el periodo de prueba: quedan 30 días.',
  ...overrides,
});

const fila = (overrides: Partial<InstallationRow> = {}): InstallationRow => ({
  id: 1,
  installationId: INSTALACION,
  installedAt: new Date('2026-11-11T12:00:00.000Z'),
  lastSeenAt: new Date('2026-11-11T12:00:00.000Z'),
  licenseToken: null,
  licenseClaims: null,
  licenseActivatedAt: null,
  licenseActivatedBy: null,
  licenseActivationReason: null,
  createdAt: new Date('2026-11-11T12:00:00.000Z'),
  updatedAt: new Date('2026-11-11T12:00:00.000Z'),
  ...overrides,
});

describe('vista pública de la licencia', () => {
  it('copia el estado tal cual, sin agregar datos del consultorio ni de la instalación', () => {
    const vista = toPublicView(
      estado({
        estado: 'licencia_por_vencer',
        origen: 'licencia',
        tipo: 'anual',
        diasRestantes: 3,
      }),
    );

    expect(vista).toEqual({
      estado: 'licencia_por_vencer',
      soloLectura: false,
      origen: 'licencia',
      tipo: 'anual',
      diasRestantes: 3,
      venceEn: '2026-12-11T12:00:00.000Z',
      mensaje: 'Estás en el periodo de prueba: quedan 30 días.',
    });
    expect(JSON.stringify(vista)).not.toContain(INSTALACION);
  });

  it('en modo consulta lo dice en `soloLectura`, que es lo que enciende el banner rojo', () => {
    const vista = toPublicView(
      estado({ estado: 'trial_vencida', soloLectura: true, diasRestantes: 0 }),
    );

    expect(vista.soloLectura).toBe(true);
    expect(vista.estado).toBe('trial_vencida');
  });
});

describe('licencia guardada en la fila de la instalación', () => {
  it('sin licencia devuelve `null` (la instalación está en prueba)', () => {
    expect(parseStoredLicense(fila())).toBeNull();
    expect(toLicenseView(fila())).toBeNull();
  });

  it('parsea los claims guardados y los devuelve ya validados', () => {
    const guardados = claims();
    expect(parseStoredLicense(fila({ licenseClaims: guardados }))).toEqual(guardados);
  });

  it('un jsonb dañado se trata como «sin licencia» en vez de romper el panel', () => {
    expect(
      parseStoredLicense(fila({ licenseClaims: { lic: 'no-es-una-licencia' } as never })),
    ).toBeNull();
  });

  it('la vista del administrador arma la licencia con su fecha de activación', () => {
    const vista = toLicenseView(
      fila({
        licenseClaims: claims(),
        licenseActivatedAt: new Date('2026-11-12T09:30:00.000Z'),
      }),
    );

    expect(vista).toEqual({
      id: 'LIC-2026-0001',
      tipo: 'mensual',
      cliente: { nombre: 'Consultorio de prueba', rif: 'J-12345678-9' },
      emitidaEn: '2026-11-11T12:00:00.000Z',
      venceEn: '2026-12-11T12:00:00.000Z',
      activadaEn: '2026-11-12T09:30:00.000Z',
    });
  });

  it('una licencia sin fecha de activación conserva `activadaEn: null`', () => {
    expect(toLicenseView(fila({ licenseClaims: claims() }))?.activadaEn).toBeNull();
  });

  it('una vitalicia se guarda sin vencimiento y la vista lo respeta', () => {
    const vitalicia = claims({ tipo: 'vitalicia', venceEn: null, lic: 'LIC-VITALICIA-1' });

    expect(parseStoredLicense(fila({ licenseClaims: vitalicia }))).toEqual(vitalicia);
    const vista = toLicenseView(fila({ licenseClaims: vitalicia }));
    expect(vista?.tipo).toBe('vitalicia');
    expect(vista?.venceEn).toBeNull();
  });
});

describe('solicitud de licencia (consultorio → proveedor)', () => {
  const ahora = new Date('2026-11-11T13:00:00.000Z');

  it('produce un código ODO-REQ1. que el proveedor puede decodificar', () => {
    const { codigo } = buildLicenseRequest(
      INSTALACION,
      { nombre: 'Clínica Los Andes', rif: 'J-12345678-9' },
      ahora,
    );

    expect(codigo.startsWith('ODO-REQ1.')).toBe(true);
    const solicitud = decodeLicenseRequest(codigo);
    expect(solicitud).toEqual({
      v: 1,
      instalacion: INSTALACION,
      cliente: { nombre: 'Clínica Los Andes', rif: 'J-12345678-9' },
      tipoSolicitado: 'no_se',
      generadaEn: '2026-11-11T13:00:00.000Z',
    });
  });

  it('el texto listo para WhatsApp lleva consultorio, RIF, instalación y el código', () => {
    const { codigo, texto } = buildLicenseRequest(
      INSTALACION,
      { nombre: 'Clínica Los Andes', rif: 'J-12345678-9' },
      ahora,
    );

    expect(texto).toContain('Clínica Los Andes');
    expect(texto).toContain('J-12345678-9');
    expect(texto).toContain(INSTALACION);
    expect(texto).toContain(codigo);
  });

  it('un consultorio sin perfil todavía no tiene nombre: la solicitud no falla', () => {
    const { codigo, texto } = buildLicenseRequest(INSTALACION, { nombre: '', rif: null }, ahora);

    expect(decodeLicenseRequest(codigo)?.cliente).toEqual({ nombre: 'Consultorio sin nombre' });
    expect(texto).toContain('Consultorio sin nombre');
  });

  it('sin RIF el claims no lo incluye y el texto lo deja como «—»', () => {
    const { codigo, texto } = buildLicenseRequest(
      INSTALACION,
      { nombre: 'Consultorio sin RIF', rif: null },
      ahora,
    );

    expect(decodeLicenseRequest(codigo)?.cliente).toEqual({ nombre: 'Consultorio sin RIF' });
    expect(texto).toContain('RIF: —');
    expect(texto).not.toContain('rif:');
  });
});
