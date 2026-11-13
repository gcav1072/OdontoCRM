import type { ClinicalRecordDetail } from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MedicalRecordDocument } from './MedicalRecordDocument';

/**
 * Impresión A4 de la historia clínica (v1.2).
 *
 * Se renderiza a HTML estático (como el resto de pruebas de componentes del
 * proyecto) y se lee **lo que sale en el papel**: el diagnóstico como lista con
 * sus piezas, la referencia al diagnóstico en los procedimientos del plan y la
 * evolución cronológica de las sesiones cerradas, que es una proyección viva y
 * se imprime incluso con la historia firmada.
 */
const ID_DIAGNOSTICO = '11111111-2222-4333-8444-555555555555';

const PACIENTE = {
  id: '99999999-8888-4777-8666-555555555555',
  fullName: 'María Pérez',
  document: 'V-12345678',
  birthDate: '1990-01-01',
  age: 36,
  sex: 'F',
  phone: null,
  address: null,
  occupation: null,
};

const registro = (overrides: Partial<ClinicalRecordDetail> = {}): ClinicalRecordDetail => ({
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  patientId: PACIENTE.id,
  status: 'borrador',
  openedAt: '2026-09-01T13:00:00.000Z',
  updatedAt: '2026-09-20T13:40:00.000Z',
  signedAt: null,
  signedByUsername: null,
  amendmentCount: 0,
  completedSections: [],
  missingSections: [],
  consentAccepted: false,
  alerts: [],
  patient: PACIENTE,
  sections: {},
  amendments: [],
  consent: null,
  evolutionSessions: [],
  ...overrides,
});

const htmlDe = (record: ClinicalRecordDetail): string =>
  renderToStaticMarkup(createElement(MedicalRecordDocument, { record }));

const SESIONES = [
  {
    id: '22222222-3333-4444-8555-666666666666',
    sessionNumber: 1,
    fecha: '2026-09-20T13:40:00.000Z',
    diagnostico: 'Caries oclusal en 16',
    tratamientos: ['Obturación de resina'],
    observaciones: 'Evoluciona sin dolor.',
  },
  {
    id: '33333333-4444-4555-8666-777777777777',
    sessionNumber: 2,
    fecha: '2026-10-04T14:00:00.000Z',
    diagnostico: null,
    tratamientos: [],
    observaciones: null,
  },
];

describe('impresión de la historia clínica', () => {
  it('imprime el diagnóstico como lista, con sus piezas y sin «principal/secundarios»', () => {
    const html = htmlDe(
      registro({
        sections: {
          diagnostico: {
            items: [{ id: ID_DIAGNOSTICO, descripcion: 'Caries oclusal', piezas: '16, 26' }],
            saludBucalGeneral: 'regular',
            observaciones: null,
          },
        },
      }),
    );

    expect(html).toContain('Diagnóstico');
    expect(html).toContain('Caries oclusal');
    expect(html).toContain('Piezas: 16, 26');
    expect(html).toContain('Estado de salud bucal general');
    expect(html).toContain('Regular');
    // El modelo anterior ya no existe.
    expect(html).not.toContain('Diagnóstico principal');
    expect(html).not.toContain('Diagnósticos secundarios');
  });

  it('en el plan referencia el diagnóstico del que sale cada procedimiento', () => {
    const html = htmlDe(
      registro({
        sections: {
          diagnostico: {
            items: [{ id: ID_DIAGNOSTICO, descripcion: 'Caries oclusal', piezas: '16, 26' }],
            saludBucalGeneral: null,
            observaciones: null,
          },
          plan_tratamiento: {
            procedimientos: [
              {
                diagnosticoId: ID_DIAGNOSTICO,
                descripcion: 'Obturación de resina',
                prioridad: 'alta',
                pieza: '16, 26',
                presupuesto: 120,
              },
              {
                diagnosticoId: null,
                descripcion: 'Limpieza dental',
                prioridad: 'baja',
                pieza: null,
                presupuesto: null,
              },
            ],
            alternativas: null,
            aceptacionPaciente: null,
            observaciones: null,
          },
        },
      }),
    );

    expect(html).toContain('Obturación de resina');
    expect(html).toContain('Diagnóstico: Caries oclusal');
    expect(html).toContain('Limpieza dental');
    // El procedimiento libre no inventa un diagnóstico.
    const libre = html.slice(html.indexOf('Limpieza dental'));
    expect(libre).not.toContain('Diagnóstico: Caries oclusal');
  });

  it('imprime la evolución con la tabla de sesiones cerradas, incluso si la historia está firmada', () => {
    const html = htmlDe(
      registro({
        status: 'firmada',
        signedAt: '2026-10-05T12:00:00.000Z',
        signedByUsername: 'prueba',
        evolutionSessions: SESIONES,
      }),
    );

    expect(html).toContain('Evolución clínica');
    expect(html).toContain('Resumen de sesiones clínicas cerradas');
    expect(html).toContain('Fecha · Sesión');
    expect(html).toContain('Sesión #1');
    expect(html).toContain('Sesión #2');
    expect(html).toContain('20/09/2026');
    expect(html).toContain('Caries oclusal en 16');
    expect(html).toContain('Obturación de resina');
    expect(html).toContain('Evoluciona sin dolor.');
    // La sesión sin diagnóstico ni tratamientos deja el guion, no un hueco.
    expect(html).toContain('Sesión #2');
    // Sin cuadro manual lleno no se imprime su etiqueta.
    expect(html).not.toContain('Observaciones / evolución manual');
  });

  it('imprime el cuadro manual de evolución debajo de la tabla cronológica', () => {
    const html = htmlDe(
      registro({
        sections: { evolucion: { observaciones: 'Revisión anual sin hallazgos.' } },
        evolutionSessions: [SESIONES[0]!],
      }),
    );

    expect(html).toContain('Observaciones / evolución manual');
    expect(html).toContain('Revisión anual sin hallazgos.');
    expect(html.indexOf('Resumen de sesiones clínicas cerradas')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('Resumen de sesiones clínicas cerradas')).toBeLessThan(
      html.indexOf('Observaciones / evolución manual'),
    );
  });

  it('no imprime como tratamientos los procedimientos que siguen pendientes de completar', () => {
    const html = htmlDe(
      registro({
        sections: {
          diagnostico: {
            items: [{ id: ID_DIAGNOSTICO, descripcion: 'Caries oclusal', piezas: '16, 26' }],
            saludBucalGeneral: null,
            observaciones: null,
          },
          plan_tratamiento: {
            procedimientos: [
              {
                diagnosticoId: ID_DIAGNOSTICO,
                descripcion: '',
                prioridad: 'media',
                pieza: '16, 26',
                presupuesto: null,
              },
            ],
            alternativas: null,
            aceptacionPaciente: null,
            observaciones: null,
          },
        },
      }),
    );

    expect(html).toContain('Caries oclusal');
    expect(html).not.toContain('Procedimientos propuestos');
  });

  it('no imprime la evolución cuando no hay sesiones ni cuadro manual', () => {
    expect(htmlDe(registro())).not.toContain('Evolución clínica');
  });

  it('una sección de diagnóstico sin hallazgos no imprime una lista vacía', () => {
    const html = htmlDe(
      registro({
        sections: {
          diagnostico: { items: [], saludBucalGeneral: null, observaciones: null },
        },
      }),
    );

    expect(html).not.toContain('Diagnósticos');
  });
});
