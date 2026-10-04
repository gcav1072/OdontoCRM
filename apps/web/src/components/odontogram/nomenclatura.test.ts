import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { describeAction, type QuickEntryAction } from './QuickEntryBar';
import { ToothFindingSheet } from './ToothFindingSheet';

/**
 * Nomenclatura clínica de las caras en la **selección**, que es lo que el odontólogo
 * lee mientras marca: del canino al incisivo central no hay cara oclusal ancha, hay
 * **borde incisal**. El dato guardado sigue siendo `occlusal` (mismo polígono, sin
 * migración): lo que cambia es cómo se llama delante de la pieza.
 *
 * Se renderiza a HTML (sin DOM): el componente es de servidor-salvo-efectos, y lo que
 * hay que comprobar es el texto de los botones, no la interacción.
 */
const hoja = (toothNumber: number): string =>
  renderToStaticMarkup(
    createElement(ToothFindingSheet, {
      open: true,
      patientId: '11111111-1111-4111-8111-111111111111',
      toothNumber,
      findings: [],
      canWrite: true,
      onClose: () => undefined,
      onApplied: () => undefined,
      onError: () => undefined,
    }),
  );

describe('la cara de masticación se nombra según la pieza', () => {
  it('en un canino o un incisivo la hoja ofrece «Incisal»', () => {
    for (const pieza of [13, 33, 11, 41]) {
      const html = hoja(pieza);
      expect(html).toContain('Incisal');
      // Y ninguna cara se llama «Oclusal» en esa pieza.
      expect(html).not.toContain('Oclusal');
    }
  });

  it('en un premolar o un molar sigue siendo «Oclusal»', () => {
    for (const pieza of [14, 36, 46, 25]) {
      const html = hoja(pieza);
      expect(html).toContain('Oclusal');
      expect(html).not.toContain('Incisal');
    }
  });

  it('las demás caras se llaman igual en toda la boca', () => {
    const anterior = hoja(33);
    for (const cara of ['Vestibular', 'Lingual', 'Mesial', 'Distal']) {
      expect(anterior).toContain(cara);
      expect(hoja(36)).toContain(cara);
    }
  });

  it('la hoja deja escribir las notas al marcar, que es lo que sale en el informe', () => {
    const html = hoja(36);
    // El campo está en el formulario de marcado, no solo al editar después.
    expect(html).toContain('Notas del hallazgo');
    expect(html).toContain('Observación clínica (opcional)');
    expect(html).toContain('columna NOTAS del informe');
  });
});

describe('el aviso de la carga rápida usa el nombre clínico', () => {
  const accion = (toothNumber: number, surface: 'occlusal' | 'vestibular'): QuickEntryAction => ({
    kind: 'record',
    input: {
      toothNumber,
      surface,
      condition: 'caries',
      state: 'pendiente',
      notes: null,
      sessionId: null,
    },
  });

  it('«caries incisal» en el 11 y «caries oclusal» en el 16', () => {
    expect(describeAction(accion(11, 'occlusal'))).toContain('incisal');
    expect(describeAction(accion(16, 'occlusal'))).toContain('oclusal');
    // Lo que no cambia: las demás caras se llaman igual en toda la boca.
    expect(describeAction(accion(11, 'vestibular'))).toContain('vestibular');
  });
});
