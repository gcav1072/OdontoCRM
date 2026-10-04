import type { AuditEventRecord } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_EXPORT_MAX_EVENTS,
  AUDIT_EXPORT_PAGE_SIZE,
  auditExportFileName,
  auditExportPlan,
  auditExportRows,
  auditQueryRange,
} from './audit-service.js';

/**
 * Piezas puras de la consulta y la exportación de auditoría.
 *
 * Lo que se prueba aquí es lo que no necesita PostgreSQL: cómo se interpreta una
 * fecha suelta, cuántas páginas se recorren hasta el tope y qué nombre lleva el
 * archivo. La ruta y el diff contra la base real se cubren en
 * `audit.integration.test.ts`.
 */
describe('rango de la consulta de auditoría', () => {
  it('una fecha suelta es el día completo en Venezuela, no la medianoche UTC', () => {
    const { from, to } = auditQueryRange({ from: '2026-10-01', to: '2026-10-01' });

    // 00:00 en Caracas (UTC−4) es 04:00 UTC; el fin del día, 03:59:59.999 UTC del 2.
    expect(from?.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(to?.toISOString()).toBe('2026-10-02T03:59:59.999Z');
  });

  it('un instante completo se respeta tal cual', () => {
    const { from, to } = auditQueryRange({
      from: '2026-10-01T10:00:00Z',
      to: '2026-10-04T23:00:00-04:00',
    });

    expect(from?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(to?.toISOString()).toBe('2026-10-05T03:00:00.000Z');
  });

  it('sin fechas no inventa extremos', () => {
    expect(auditQueryRange({})).toEqual({ from: undefined, to: undefined });
    expect(auditQueryRange({ from: '', to: '' })).toEqual({ from: undefined, to: undefined });
  });

  it('una fecha ilegible se descarta en vez de romper la consulta', () => {
    const { from, to } = auditQueryRange({ from: 'ayer', to: '2026-10-01' });

    expect(from).toBeUndefined();
    expect(to?.toISOString()).toBe('2026-10-02T03:59:59.999Z');
  });
});

describe('plan de la exportación', () => {
  it('sin eventos no hay ninguna página', () => {
    expect(auditExportPlan(0)).toEqual({ pages: 0, events: 0, truncated: false });
  });

  it('una página por cada 200 eventos', () => {
    expect(auditExportPlan(1)).toEqual({ pages: 1, events: 1, truncated: false });
    expect(auditExportPlan(AUDIT_EXPORT_PAGE_SIZE)).toEqual({
      pages: 1,
      events: 200,
      truncated: false,
    });
    expect(auditExportPlan(AUDIT_EXPORT_PAGE_SIZE + 1)).toEqual({
      pages: 2,
      events: 201,
      truncated: false,
    });
  });

  it('el tope recorta la exportación y lo avisa', () => {
    const justoEnElTope = auditExportPlan(AUDIT_EXPORT_MAX_EVENTS);
    expect(justoEnElTope).toEqual({ pages: 25, events: 5_000, truncated: false });

    const pasado = auditExportPlan(AUDIT_EXPORT_MAX_EVENTS + 1);
    expect(pasado).toEqual({ pages: 25, events: 5_000, truncated: true });
  });

  it('un total negativo no pide páginas', () => {
    expect(auditExportPlan(-5)).toEqual({ pages: 0, events: 0, truncated: false });
  });
});

describe('nombre del archivo exportado', () => {
  it('lleva el rango consultado', () => {
    expect(auditExportFileName({ from: '2026-10-01', to: '2026-10-04' })).toBe(
      'auditoria-2026-10-01_2026-10-04.csv',
    );
  });

  it('sin fechas usa inicio y fin', () => {
    expect(auditExportFileName({})).toBe('auditoria-inicio_fin.csv');
  });

  it('no deja pasar comillas ni saltos de línea a la cabecera', () => {
    const nombre = auditExportFileName({ from: '2026-10-01";\r\nx', to: '2026-10-04' });

    expect(nombre).toBe('auditoria-2026-10-01----x_2026-10-04.csv');
    expect(nombre).not.toContain('"');
    expect(nombre).not.toContain('\n');
  });
});

describe('filas del CSV', () => {
  const evento: AuditEventRecord = {
    id: '0f2f5f6a-1b1b-4a4c-8a5a-9f0a1b2c3d4e',
    occurredAt: '2026-10-01T14:03:00.000Z',
    actorId: null,
    actorUsername: 'recepcion',
    action: 'patient_updated',
    entityType: 'patient',
    entityId: 'aa11bb22-cc33-dd44-ee55-ff6677889900',
    summary: 'Paciente editado',
    before: { phone: '+584121111111' },
    after: { phone: '+584142222222' },
    changedFields: ['phone'],
    reason: 'cambió de número',
    ip: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
    requestId: 'req-1',
  };

  it('una fila por evento, con el diff en texto y el motivo', () => {
    const rows = auditExportRows([evento], false);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.['actorUsername']).toBe('recepcion');
    expect(rows[0]?.['before']).toBe('phone: +584121111111');
    expect(rows[0]?.['after']).toBe('phone: +584142222222');
    expect(rows[0]?.['reason']).toBe('cambió de número');
  });

  it('al tocar el tope añade una última fila que lo avisa, sin inventar eventos', () => {
    const rows = auditExportRows([evento], true);

    expect(rows).toHaveLength(2);
    const aviso = rows[1]?.['summary'] ?? '';
    expect(aviso).toContain('tope');
    expect(aviso).toContain(AUDIT_EXPORT_MAX_EVENTS.toLocaleString('es-VE'));
    expect(aviso).toContain('Acota el rango de fechas');
    // El aviso no ocupa las columnas de datos: el resto de celdas van vacías.
    expect(rows[1]?.['actorUsername']).toBeUndefined();
    expect(rows[1]?.['occurredAt']).toBeUndefined();
  });
});
