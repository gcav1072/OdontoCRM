import { describe, expect, it } from 'vitest';

import {
  AUDIT_EXPORT_COLUMNS,
  auditDiffRows,
  auditEventToRow,
  auditInstantRange,
  formatAuditValue,
} from './audit.js';

const evento = {
  id: '0f2f5f6a-1b1b-4a4c-8a5a-9f0a1b2c3d4e',
  occurredAt: '2026-10-04T14:03:00.000Z',
  actorId: '5b8f2e7c-2b1c-4e3a-9c4d-6f7a8b9c0d1e',
  actorUsername: 'recepcion',
  action: 'patient_updated',
  entityType: 'patient',
  entityId: 'aa11bb22-cc33-dd44-ee55-ff6677889900',
  summary: 'Paciente editado',
  before: { phone: '+584121111111', address: 'Av. Bolívar' },
  after: { phone: '+584142222222', address: 'Av. Bolívar' },
  changedFields: ['phone'],
  reason: 'cambió de número',
  ip: '127.0.0.1',
  userAgent: 'Mozilla/5.0',
  requestId: 'req-1',
};

describe('fechas de la auditoría', () => {
  it('interpreta una fecha suelta como el día completo en Venezuela', () => {
    const range = auditInstantRange('2026-10-01', '2026-10-04');
    expect(range.fromIso).toBe('2026-10-01T00:00:00.000-04:00');
    expect(range.toIso).toBe('2026-10-04T23:59:59.999-04:00');
  });

  it('deja pasar un instante completo tal cual', () => {
    const range = auditInstantRange('2026-10-01T10:00:00Z', undefined);
    expect(range.fromIso).toBe('2026-10-01T10:00:00Z');
    expect(range.toIso).toBeUndefined();
  });

  it('sin fechas no inventa extremos', () => {
    expect(auditInstantRange(undefined, '')).toEqual({ fromIso: undefined, toIso: undefined });
  });
});

describe('diff antes/después de la auditoría', () => {
  it('muestra el valor anterior y el nuevo del campo que cambió', () => {
    const rows = auditDiffRows(evento);
    expect(rows).toEqual([{ field: 'phone', before: '+584121111111', after: '+584142222222' }]);
  });

  it('respeta el orden de changedFields y omite lo que no cambió', () => {
    const rows = auditDiffRows({
      changedFields: ['address', 'phone'],
      before: { phone: '+58', address: 'A' },
      after: { phone: '+58', address: 'B' },
    });
    expect(rows.map((row) => row.field)).toEqual(['address', 'phone']);
    expect(rows[0]).toEqual({ field: 'address', before: 'A', after: 'B' });
  });

  it('sin changedFields cae a la unión de las claves', () => {
    const rows = auditDiffRows({ changedFields: [], before: { a: 1 }, after: { b: 2 } });
    expect(rows.map((row) => row.field)).toEqual(['a', 'b']);
  });

  it('pinta los vacíos como raya y los booleanos en español', () => {
    expect(formatAuditValue(null)).toBe('—');
    expect(formatAuditValue('')).toBe('—');
    expect(formatAuditValue(true)).toBe('sí');
    expect(formatAuditValue(false)).toBe('no');
    expect(formatAuditValue(30)).toBe('30');
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('exportación de la auditoría', () => {
  it('la fila lleva autor, acción, motivo y el diff en texto', () => {
    const row = auditEventToRow(evento);
    expect(row['actorUsername']).toBe('recepcion');
    expect(row['reason']).toBe('cambió de número');
    expect(row['changedFields']).toBe('phone');
    expect(row['before']).toBe('phone: +584121111111');
    expect(row['after']).toBe('phone: +584142222222');
  });

  it('las columnas declaradas son las que se exportan', () => {
    const keys = AUDIT_EXPORT_COLUMNS.map((column) => column.key);
    const row = auditEventToRow(evento);
    for (const key of keys) expect(Object.keys(row)).toContain(key);
    expect(keys).toContain('reason');
    expect(keys).toContain('before');
    expect(keys).toContain('after');
  });

  it('un evento sin motivo ni usuario no rompe la exportación', () => {
    const row = auditEventToRow({
      ...evento,
      actorUsername: null,
      reason: null,
      entityId: null,
      before: null,
      after: null,
      changedFields: [],
    });
    expect(row['actorUsername']).toBe('—');
    expect(row['reason']).toBe('—');
    expect(row['before']).toBe('');
  });
});
