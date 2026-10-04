import { describe, expect, it } from 'vitest';

import {
  AGE_BUCKETS,
  ageAtDate,
  ageBucketOf,
  clinicalProfileCounts,
  daysBetween,
  REPORT_DEFAULT_DAYS,
  REPORT_KEYS,
  REPORT_LABELS,
  reportDocumentSchema,
  reportFileName,
  reportPermissionFor,
  reportToCsv,
  resolveReportRange,
  shiftIsoDate,
} from './reporting.js';

describe('rango de fechas del reporte', () => {
  it('sin fechas usa una ventana de 30 días que termina hoy', () => {
    const range = resolveReportRange({}, '2026-10-04');
    expect(range.to).toBe('2026-10-04');
    expect(range.from).toBe('2026-09-05');
    expect(daysBetween(range.from, range.to) + 1).toBe(REPORT_DEFAULT_DAYS);
  });

  it('respeta las fechas que llegan', () => {
    expect(resolveReportRange({ from: '2026-01-01', to: '2026-03-31' }, '2026-10-04')).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
  });

  it('rechaza un rango invertido y uno desmedido', () => {
    expect(() =>
      resolveReportRange({ from: '2026-10-05', to: '2026-10-04' }, '2026-10-04'),
    ).toThrow(/empieza después/);
    expect(() =>
      resolveReportRange({ from: '2010-01-01', to: '2026-10-04' }, '2026-10-04'),
    ).toThrow(/no puede pasar/);
  });

  it('mueve días sin desfase de zona horaria', () => {
    expect(shiftIsoDate('2026-10-04', -3)).toBe('2026-10-01');
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftIsoDate('2024-02-29', 1)).toBe('2024-03-01');
  });
});

describe('edad y tramos', () => {
  it('cumple años el día del cumpleaños, no antes', () => {
    expect(ageAtDate('2016-10-04', '2026-10-04')).toBe(10);
    expect(ageAtDate('2016-10-05', '2026-10-04')).toBe(9);
  });

  it('calcula en UTC: un 1 de enero no envejece la víspera', () => {
    // En Venezuela (UTC−4) la medianoche UTC del 1 de enero son las 20:00 del 31
    // de diciembre: con getters locales, este paciente tendría un año de más.
    expect(ageAtDate('2008-01-01', '2026-01-01')).toBe(18);
    expect(ageAtDate('2008-01-01', '2025-12-31')).toBe(17);
  });

  it('los tramos cubren toda la vida y no se solapan', () => {
    const cubiertos = AGE_BUCKETS.flatMap((bucket) =>
      Array.from({ length: bucket.to - bucket.from + 1 }, (_, i) => bucket.from + i),
    );
    expect(new Set(cubiertos).size).toBe(cubiertos.length);
    expect(cubiertos).toContain(0);
    expect(cubiertos).toContain(120);
    expect(ageBucketOf(0)).toBe('0-12');
    expect(ageBucketOf(12)).toBe('0-12');
    expect(ageBucketOf(13)).toBe('13-17');
    expect(ageBucketOf(41)).toBe('41-65');
    expect(ageBucketOf(66)).toBe('66+');
  });
});

describe('perfil clínico agregado', () => {
  it('cuenta pacientes por grupo y un paciente puede caer en varios', () => {
    const counts = clinicalProfileCounts([
      ['diabetes', 'hipertension', 'alergia_penicilina'],
      ['diabetes'],
      ['anticoagulante'],
      [],
    ]);
    expect(counts.diabetes).toBe(2);
    expect(counts.hipertension).toBe(1);
    expect(counts.alergias).toBe(1);
    expect(counts.anticoagulados).toBe(1);
    expect(counts.bifosfonatos).toBe(0);
  });

  it('sin pacientes todos los grupos quedan en cero', () => {
    const counts = clinicalProfileCounts([]);
    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
  });
});

describe('documento de reporte', () => {
  const document = {
    key: 'funnel' as const,
    title: 'Embudo',
    subtitle: '01/09/2026 – 30/09/2026',
    generatedAt: '2026-10-04T12:00:00.000Z',
    range: { from: '2026-09-01', to: '2026-09-30' },
    filters: { granularity: 'week' as const },
    kpis: [{ label: 'Atendidas', value: 12, unit: 'citas' }],
    series: [
      {
        id: 'serie',
        label: 'Atendidas',
        kind: 'bar' as const,
        points: [{ x: '2026-W36', y: 12 }],
      },
    ],
    table: {
      columns: [{ key: 'periodo', label: 'Período' }],
      rows: [{ periodo: '2026-W36' }],
    },
    notes: [],
  };

  it('aplica los valores por defecto del contrato', () => {
    const parsed = reportDocumentSchema.parse(document);
    expect(parsed.kpis[0]?.tone).toBe('neutral');
    expect(parsed.table.rows[0]?.['periodo']).toBe('2026-W36');
    expect(parsed.filters.granularity).toBe('week');
  });

  it('rechaza un reporte con una clave fuera del catálogo', () => {
    expect(reportDocumentSchema.safeParse({ ...document, key: 'inventado' }).success).toBe(false);
  });

  it('el CSV sale de la tabla del documento', () => {
    const csv = reportToCsv(reportDocumentSchema.parse(document));
    expect(csv).toContain('Período');
    expect(csv).toContain('2026-W36');
  });

  it('el nombre del archivo es estable y sin acentos', () => {
    expect(reportFileName('oral-health', { from: '2026-09-01', to: '2026-09-30' }, 'csv')).toBe(
      'reporte-oral-health-2026-09-01_2026-09-30.csv',
    );
  });
});

describe('catálogo de reportes', () => {
  it('cada reporte tiene etiqueta y permiso', () => {
    for (const key of REPORT_KEYS) {
      expect(REPORT_LABELS[key]).toBeTruthy();
      expect(['reports:read', 'reports:clinical']).toContain(reportPermissionFor(key));
    }
  });

  it('los reportes clínicos exigen el permiso clínico', () => {
    expect(reportPermissionFor('clinical-profile')).toBe('reports:clinical');
    expect(reportPermissionFor('oral-health')).toBe('reports:clinical');
    expect(reportPermissionFor('prescriptions')).toBe('reports:clinical');
    expect(reportPermissionFor('funnel')).toBe('reports:read');
    expect(reportPermissionFor('capacity')).toBe('reports:read');
    expect(reportPermissionFor('demographics')).toBe('reports:read');
  });
});
