import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CLINICAL_SECTION_FIELDS,
  asDiagnosisItems,
  type ClinicalFieldSpec,
} from '../../lib/clinical';
import { ClinicalSectionFields, asProcedures } from './ClinicalSectionFields';

/**
 * Campos de la historia que dependen del vínculo diagnóstico ↔ plan (v1.2).
 *
 * Se renderiza a HTML estático (como el resto de pruebas de componentes del
 * proyecto) y se lee lo que ve el odontólogo: la lista de diagnósticos, el chip
 * que ata cada procedimiento a su diagnóstico (con la pieza que manda el
 * diagnóstico y sin botón de quitar) y el botón para agregar un procedimiento
 * libre.
 */
const ID_DIAGNOSTICO = '11111111-2222-4333-8444-555555555555';

const renderFields = (
  key: 'diagnostico' | 'plan_tratamiento',
  content: Record<string, unknown>,
  diagnosisItems = asDiagnosisItems(content['items']),
): string =>
  renderToStaticMarkup(
    createElement(ClinicalSectionFields, {
      fields: CLINICAL_SECTION_FIELDS[key] as readonly ClinicalFieldSpec[],
      content,
      onChange: () => undefined,
      diagnosisItems,
      planProcedures: asProcedures(content['procedimientos']),
    }),
  );

const DIAGNOSTICO = {
  id: ID_DIAGNOSTICO,
  descripcion: 'Caries oclusal',
  piezas: '16, 26',
};

const PLAN_VINCULADO = {
  diagnosticoId: ID_DIAGNOSTICO,
  descripcion: '',
  prioridad: 'media',
  pieza: '16, 26',
  presupuesto: null,
};

const PLAN_LIBRE = {
  diagnosticoId: null,
  descripcion: 'Limpieza dental',
  prioridad: 'baja',
  pieza: null,
  presupuesto: null,
};

describe('diagnóstico por ítems ↔ plan de tratamiento', () => {
  it('el diagnóstico se edita como lista de ítems con descripción y piezas', () => {
    const html = renderFields('diagnostico', {
      items: [DIAGNOSTICO],
      saludBucalGeneral: null,
      observaciones: null,
    });

    expect(html).toContain('Caries oclusal');
    expect(html).toContain('Piezas');
    expect(html).toContain('Agregar diagnóstico');
    expect(html).not.toContain('Todavía no hay diagnósticos');
  });

  it('sin diagnósticos lo dice, en lugar de dejar la lista muda', () => {
    const html = renderFields('diagnostico', {
      items: [],
      saludBucalGeneral: null,
      observaciones: null,
    });

    expect(html).toContain('Todavía no hay diagnósticos');
  });

  it('el procedimiento vinculado muestra su diagnóstico y su pieza, y no se quita desde el plan', () => {
    const html = renderFields(
      'plan_tratamiento',
      {
        procedimientos: [PLAN_VINCULADO, PLAN_LIBRE],
        alternativas: null,
        aceptacionPaciente: null,
        observaciones: null,
      },
      [DIAGNOSTICO],
    );

    expect(html).toContain('Diagnóstico: Caries oclusal');
    expect(html).toContain('Pieza(s): 16, 26');
    expect(html).toContain('Pendiente por completar');
    expect(html).toContain('Indica el tratamiento para este diagnóstico');
    // Solo el ítem libre se puede quitar desde la lista del plan.
    expect(html.match(/Quitar/g) ?? []).toHaveLength(1);
    expect(html).toContain('Agregar procedimiento adicional');
  });

  it('el procedimiento libre conserva su formulario completo y editable', () => {
    const html = renderFields('plan_tratamiento', {
      procedimientos: [PLAN_LIBRE],
      alternativas: null,
      aceptacionPaciente: null,
      observaciones: null,
    });

    expect(html).toContain('Limpieza dental');
    expect(html).toContain('Presupuesto');
    expect(html).toContain('Quitar');
    expect(html).not.toContain('Pendiente por completar');
  });
});
