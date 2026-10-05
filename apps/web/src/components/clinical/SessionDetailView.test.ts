import { emptyClinicalSessionContent, type ClinicalSessionDetail } from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SessionDetailView } from './SessionDetailView';

/**
 * Lectura de una sesión cerrada desde la ficha del paciente.
 *
 * Se renderiza a HTML estático (como el resto de pruebas de componentes del
 * proyecto) y se comprueba **lo que lee una persona**: el motivo, los procedimientos
 * con su pieza, el diagnóstico, las indicaciones, quién firmó el cierre… y que las
 * notas internas **no** aparezcan cuando no corresponden.
 *
 * Lo que motivó esta vista: en la ficha se veía que había sesiones, pero no había
 * forma de leer lo que se registró en ellas.
 */
const SESION: ClinicalSessionDetail = {
  id: '11111111-2222-4333-8444-555555555555',
  recordId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  patientId: '99999999-8888-4777-8666-555555555555',
  appointmentId: null,
  sessionNumber: 3,
  status: 'cerrada',
  openedAt: '2026-09-20T13:00:00.000Z',
  updatedAt: '2026-09-20T13:40:00.000Z',
  closedAt: '2026-09-20T13:40:00.000Z',
  openedByUsername: 'egomez',
  closedByUsername: 'egomez',
  closureNote: 'Paciente tolera bien el procedimiento.',
  amendedFromId: null,
  amendmentReason: null,
  procedureCount: 1,
  summary: 'Sesión con 1 procedimiento: Obturación',
  content: {
    ...emptyClinicalSessionContent(),
    motivo: 'Dolor en la pieza 16 al masticar',
    anamnesis: 'Sin alergias conocidas.',
    diagnostico: 'Caries oclusal en 16',
    indicaciones: 'No masticar duro durante 24 horas.',
    notasInternas: 'El paciente prefiere citas por la tarde.',
    procedimientos: [
      {
        code: 'obturacion_resina',
        detalle: null,
        toothNumber: 16,
        surfaces: ['occlusal'],
        notas: 'Anestesia local',
      },
    ],
    proximaCitaFecha: '2026-10-04',
    proximaCitaNota: 'Control de la obturación',
  },
};

describe('lectura de una sesión clínica', () => {
  it('muestra el motivo, el diagnóstico y las indicaciones', () => {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: SESION }));

    expect(html).toContain('Dolor en la pieza 16 al masticar');
    expect(html).toContain('Caries oclusal en 16');
    expect(html).toContain('No masticar duro durante 24 horas.');
  });

  it('lista los procedimientos con su pieza y sus notas', () => {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: SESION }));

    expect(html).toContain('pieza 16');
    expect(html).toContain('Anestesia local');
  });

  it('dice quién abrió y quién firmó el cierre, con las fechas', () => {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: SESION }));

    expect(html).toContain('egomez');
    expect(html).toContain('Nota de cierre');
    expect(html).toContain('Paciente tolera bien el procedimiento.');
  });

  it('muestra la próxima cita sugerida', () => {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: SESION }));

    expect(html).toContain('Control de la obturación');
  });

  it('NO muestra las notas internas si no se piden (son internas)', () => {
    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: SESION }));

    expect(html).not.toContain('El paciente prefiere citas por la tarde.');
  });

  it('las muestra, avisando de que son internas, para quien puede escribir', () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { sesion: SESION, mostrarNotasInternas: true }),
    );

    expect(html).toContain('El paciente prefiere citas por la tarde.');
    expect(html).toContain('no se imprimen');
  });

  it('una sesión sin procedimientos lo dice, en lugar de dejar el hueco vacío', () => {
    const vacia: ClinicalSessionDetail = {
      ...SESION,
      procedureCount: 0,
      content: { ...emptyClinicalSessionContent(), motivo: 'Revisión de rutina' },
    };

    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: vacia }));

    expect(html).toContain('No se registraron procedimientos');
    expect(html).toContain('Sin registrar');
  });

  it('una sesión enmendada se marca y explica por qué', () => {
    const enmendada: ClinicalSessionDetail = {
      ...SESION,
      amendedFromId: '77777777-6666-4555-8444-333333333333',
      amendmentReason: 'Se corrigió la pieza tratada',
    };

    const html = renderToStaticMarkup(createElement(SessionDetailView, { sesion: enmendada }));

    expect(html).toContain('Sesión enmendada');
    expect(html).toContain('Se corrigió la pieza tratada');
  });
});
