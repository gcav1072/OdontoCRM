import { reportFiltersSchema, type ReportDocument } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { componerEmbudo } from './reports/funnel.js';
import { reportHtml } from './report-html.js';

const documentoDePrueba = (): ReportDocument =>
  componerEmbudo(
    [
      {
        day: '2026-10-05',
        requests: 4,
        scheduled: 3,
        notified: 3,
        confirmed: 2,
        attended: 2,
        noShow: 1,
        cancelled: 0,
      },
    ],
    {
      filters: reportFiltersSchema.parse({ granularity: 'week', sex: 'F' }),
      range: { from: '2026-10-01', to: '2026-10-31' },
      generatedAt: '2026-10-31T12:00:00.000Z',
    },
  );

/**
 * La plantilla del PDF: es HTML que se le pasa a Chromium, así que lo que hay que
 * probar es que lleva el membrete del consultorio, las cifras y la tabla, y que
 * **escapa** lo que viene de los datos (hay nombres de paciente en la tabla).
 */
describe('plantilla HTML del reporte', () => {
  it('lleva el membrete del consultorio, el rango y la fecha de generación', () => {
    const html = reportHtml(documentoDePrueba());
    expect(html).toContain('Consultorio - Od. Erika Gómez');
    expect(html).toContain('Av. Luis del Valle García');
    expect(html).toContain('Del 01/10/2026 al 31/10/2026');
    expect(html).toContain('31/10/2026 08:00');
    expect(html).toContain('Filtros aplicados');
  });

  it('pinta los KPIs y la tabla del documento', () => {
    const html = reportHtml(documentoDePrueba());
    expect(html).toContain('Tasa de inasistencia');
    expect(html).toContain('Embudo y tasa de inasistencia');
    expect(html).toContain('semana del 2026-10-05');
    expect(html).toContain('33,3');
  });

  it('escapa el HTML de los datos: un nombre con etiquetas no rompe el PDF', () => {
    const documento = documentoDePrueba();
    const conEtiquetas: ReportDocument = {
      ...documento,
      notes: ['<script>alert(1)</script>'],
      kpis: [
        ...documento.kpis,
        { label: '<b>Peligro</b>', value: '<img src=x>', unit: null, hint: null, tone: 'bad' },
      ],
    };

    const html = reportHtml(conEtiquetas);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;b&gt;Peligro&lt;/b&gt;');
  });

  it('sin filas avisa en vez de imprimir una tabla vacía', () => {
    const documento = documentoDePrueba();
    const html = reportHtml({ ...documento, table: { ...documento.table, rows: [] } });
    expect(html).toContain('Sin filas que imprimir');
    expect(html).not.toContain('<tbody>');
  });
});
