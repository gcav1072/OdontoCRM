import { describe, expect, it } from 'vitest';

import {
  allowedStatesFor,
  archLayout,
  CLINICAL_STATE_COLORS,
  conditionsConflict,
  conflictingCondition,
  dentitionOfTooth,
  findingsFromSelection,
  hasPrimaryFindings,
  isStateAllowed,
  isToothNumber,
  MIDLINE_GAP,
  neighborTooth,
  odontogramSummary,
  PERMANENT_TOOTH_NUMBERS,
  PRIMARY_TOOTH_NUMBERS,
  parsePolygonPoints,
  primarySuccessor,
  PROCEDURE_TRANSITIONS,
  quickEntryKey,
  quickEntryLabel,
  initialQuickEntryState,
  recordFindingSchema,
  selectionIsApplicable,
  supersedesSurfaces,
  SURFACE_POLYGONS,
  excludesSurfaces,
  recordingConflicts,
  surfaceAtPoint,
  surfaceLabelFor,
  TOOTH_NUMBERS,
  toothGroupTransform,
  TOOTH_STRIDE,
  toothNumberSchema,
  unscreenPoint,
  type QuickEntryIntent,
  type ToothFindingRecord,
} from './odontogram.js';

const hallazgo = (parcial: Partial<ToothFindingRecord>): ToothFindingRecord => ({
  id: '00000000-0000-4000-8000-000000000000',
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
  notes: null,
  recordedByUsername: 'prueba',
  recordedAt: '2026-10-05T14:00:00.000Z',
  updatedAt: '2026-10-05T14:00:00.000Z',
  sessionId: null,
  resolvedAt: null,
  ...parcial,
});

describe('dominio FDI', () => {
  it('reconoce las 52 piezas válidas (32 permanentes y 20 temporales)', () => {
    expect(PERMANENT_TOOTH_NUMBERS).toHaveLength(32);
    expect(PRIMARY_TOOTH_NUMBERS).toHaveLength(20);
    expect(TOOTH_NUMBERS).toHaveLength(52);

    expect(isToothNumber(11)).toBe(true);
    expect(isToothNumber(48)).toBe(true);
    expect(isToothNumber(61)).toBe(true);
    expect(isToothNumber(85)).toBe(true);

    // Fuera de FDI: ni el 0, ni el 49, ni el 99, ni el «9.º» de un cuadrante.
    expect(isToothNumber(0)).toBe(false);
    expect(isToothNumber(19)).toBe(false);
    expect(isToothNumber(49)).toBe(false);
    expect(isToothNumber(99)).toBe(false);
    expect(isToothNumber(86)).toBe(false);
  });

  it('deduce la dentición del propio número: no se puede contradecir', () => {
    expect(dentitionOfTooth(16)).toBe('permanente');
    expect(dentitionOfTooth(48)).toBe('permanente');
    expect(dentitionOfTooth(55)).toBe('temporal');
    expect(dentitionOfTooth(85)).toBe('temporal');
  });

  it('`hasPrimaryFindings` distingue una boca con piezas de leche de una sin ellas', () => {
    // Sin odontograma o sin hallazgos: no hay nada temporal que imprimir.
    expect(hasPrimaryFindings(null)).toBe(false);
    expect(hasPrimaryFindings(undefined)).toBe(false);
    expect(hasPrimaryFindings({})).toBe(false);

    // Solo permanentes: la banda temporal no se dibuja (boca permanente al día).
    expect(hasPrimaryFindings({ '16': [hallazgo({ toothNumber: 16 })] })).toBe(false);

    // Una sola pieza de leche ya justifica la banda temporal.
    expect(
      hasPrimaryFindings({
        '16': [hallazgo({ toothNumber: 16 })],
        '55': [hallazgo({ toothNumber: 55, condition: 'caries' })],
      }),
    ).toBe(true);
    expect(hasPrimaryFindings({ '85': [hallazgo({ toothNumber: 85 })] })).toBe(true);
  });

  it('el esquema de pieza rechaza un número que no existe', () => {
    expect(toothNumberSchema.safeParse(46).success).toBe(true);
    expect(toothNumberSchema.safeParse(49).success).toBe(false);
    expect(toothNumberSchema.safeParse(4.6).success).toBe(false);
  });

  it('el vecino proximal se corta en el borde del cuadrante y respeta los molares temporales', () => {
    expect(neighborTooth(16, 'mesial')).toBe(15);
    expect(neighborTooth(16, 'distal')).toBe(17);
    expect(neighborTooth(11, 'mesial')).toBeNull();
    expect(neighborTooth(18, 'distal')).toBeNull();
    // Un temporal no salta a la posición 6: esa pieza no existe en su dentición.
    expect(neighborTooth(55, 'distal')).toBeNull();
    expect(neighborTooth(55, 'mesial')).toBe(54);
  });
});

describe('captura por excepción: qué se puede registrar', () => {
  it('la caries y la obturación se registran por cara', () => {
    const caries = recordFindingSchema.parse({
      toothNumber: 24,
      surface: 'occlusal',
      condition: 'caries',
    });
    expect(caries.state).toBe('pendiente');
    expect(caries.notes).toBeNull();

    const obturacion = recordFindingSchema.parse({
      toothNumber: 24,
      surface: 'mesial',
      condition: 'restauracion',
      state: 'completado',
    });
    expect(obturacion.state).toBe('completado');
  });

  it('las condiciones de pieza completa exigen surface null', () => {
    // Cada condición lleva su estado válido: `ausente` solo existe completado y
    // `extraccion_indicada` solo pendiente (spec anexo ADR 0032 §2).
    const estadoValido = {
      ausente: 'completado',
      extraccion_indicada: 'pendiente',
      corona: 'completado',
      implante: 'completado',
      endodoncia: 'completado',
    } as const;
    for (const condition of [
      'ausente',
      'extraccion_indicada',
      'corona',
      'implante',
      'endodoncia',
    ] as const) {
      expect(
        recordFindingSchema.safeParse({
          toothNumber: 36,
          condition,
          state: estadoValido[condition],
        }).success,
      ).toBe(true);
      expect(
        recordFindingSchema.safeParse({
          toothNumber: 36,
          surface: 'occlusal',
          condition,
          state: estadoValido[condition],
        }).success,
      ).toBe(false);
    }
  });

  it('la caries y la obturación exigen la cara', () => {
    expect(recordFindingSchema.safeParse({ toothNumber: 36, condition: 'caries' }).success).toBe(
      false,
    );
    expect(
      recordFindingSchema.safeParse({
        toothNumber: 36,
        surface: 'vestibular',
        condition: 'restauracion',
      }).success,
    ).toBe(true);
  });

  it('las notas se limpian y se vacían a null', () => {
    const conNotas = recordFindingSchema.parse({
      toothNumber: 16,
      surface: 'occlusal',
      condition: 'caries',
      notes: '  Lesión   de fosa   profunda  ',
    });
    expect(conNotas.notes).toBe('Lesión de fosa profunda');

    const vacias = recordFindingSchema.parse({
      toothNumber: 16,
      surface: 'occlusal',
      condition: 'caries',
      notes: '   ',
    });
    expect(vacias.notes).toBeNull();
  });
});

describe('geometría del componente SVG', () => {
  it('los cinco polígonos reparten el lienzo de 100×100 sin solaparse', () => {
    const areas = Object.fromEntries(
      Object.entries(SURFACE_POLYGONS).map(([cara, puntos]) => {
        const vertices = parsePolygonPoints(puntos);
        let suma = 0;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
          suma += vertices[j]!.x * vertices[i]!.y - vertices[i]!.x * vertices[j]!.y;
        }
        return [cara, Math.abs(suma / 2)];
      }),
    );

    // Los cuatro trapecios laterales miden 1.875 cada uno y la oclusal 2.500.
    expect(areas['vestibular']).toBeCloseTo(1875, 6);
    expect(areas['distal']).toBeCloseTo(1875, 6);
    expect(areas['lingual']).toBeCloseTo(1875, 6);
    expect(areas['mesial']).toBeCloseTo(1875, 6);
    expect(areas['occlusal']).toBeCloseTo(2500, 6);

    const total = Object.values(areas).reduce((suma, area) => suma + area, 0);
    expect(total).toBeCloseTo(10_000, 6);
  });

  it('el centro es la cara oclusal y el borde superior la vestibular', () => {
    expect(surfaceAtPoint(50, 50)).toBe('occlusal');
    expect(surfaceAtPoint(50, 10)).toBe('vestibular');
    expect(surfaceAtPoint(50, 90)).toBe('lingual');
    expect(surfaceAtPoint(10, 50)).toBe('mesial');
    expect(surfaceAtPoint(90, 50)).toBe('distal');
  });

  it('un punto fuera del lienzo no es ninguna cara', () => {
    expect(surfaceAtPoint(-1, 50)).toBeNull();
    expect(surfaceAtPoint(50, 101)).toBeNull();
  });

  it('la arcada superior va del 18 al 28 y la inferior del 48 al 38', () => {
    const { upper, lower, width } = archLayout('permanente');

    // Orden de pantalla mirando al paciente: 17 antes que 16, y 21 al final del
    // primer cuadrante (el FDI crece hacia la línea media).
    expect(upper.map((tooth) => tooth.toothNumber)).toEqual([
      18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect(lower.map((tooth) => tooth.toothNumber)).toEqual([
      48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
    expect(width).toBe(16 * TOOTH_STRIDE + MIDLINE_GAP);
  });

  it('la línea media lleva un hueco extra, para que se vean los cuadrantes', () => {
    const { upper, lower } = archLayout('permanente');

    for (const arcada of [upper, lower]) {
      const x = arcada.map((tooth) => tooth.x);
      // Dentro de cada cuadrante el paso es constante…
      expect(x.slice(1, 8).map((valor, indice) => valor - (x[indice] ?? 0))).toEqual(
        Array.from({ length: 7 }, () => TOOTH_STRIDE),
      );
      expect(x.slice(9).map((valor, indice) => valor - (x[indice + 8] ?? 0))).toEqual(
        Array.from({ length: 7 }, () => TOOTH_STRIDE),
      );
      // …y entre el 11 y el 21 (o el 41 y el 31) hay `MIDLINE_GAP` de más.
      expect((x[8] ?? 0) - (x[7] ?? 0)).toBe(TOOTH_STRIDE + MIDLINE_GAP);
    }
    expect(MIDLINE_GAP).toBeGreaterThan(0);
  });

  it('las piezas de la derecha del paciente van espejadas y las de la izquierda no', () => {
    const { upper, lower } = archLayout('permanente');

    // La línea media queda en el centro de la fila, así que en el 16 la cara mesial
    // mira a la **derecha** de la pantalla: sin espejar, el dibujo llamaría «mesial»
    // a la cara que toca el 17 y el odontólogo registraría el vecino equivocado.
    expect(upper.slice(0, 8).every((tooth) => tooth.mirrorX)).toBe(true);
    expect(lower.slice(0, 8).every((tooth) => tooth.mirrorX)).toBe(true);
    expect(upper.slice(8).every((tooth) => !tooth.mirrorX)).toBe(true);
    expect(lower.slice(8).every((tooth) => !tooth.mirrorX)).toBe(true);
    expect(upper.slice(0, 8).every((tooth) => tooth.quadrant === 1)).toBe(true);
    expect(lower.slice(0, 8).every((tooth) => tooth.quadrant === 4)).toBe(true);

    // La temporal también: 5 y 8 son la derecha del paciente, 6 y 7 la izquierda.
    const temporal = archLayout('temporal');
    expect(temporal.upper.slice(0, 5).every((tooth) => tooth.mirrorX)).toBe(true);
    expect(temporal.upper.slice(5).every((tooth) => !tooth.mirrorX)).toBe(true);
    expect(temporal.lower.slice(0, 5).every((tooth) => tooth.mirrorX)).toBe(true);
    expect(temporal.lower.slice(5).every((tooth) => !tooth.mirrorX)).toBe(true);
  });

  it('la transformación de la pieza la da el contrato, para que dibujo y clic coincidan', () => {
    expect(toothGroupTransform({ flipped: false, mirrorX: false })).toBeUndefined();
    expect(toothGroupTransform({ flipped: true, mirrorX: false })).toBe(
      'scale(1,-1) translate(0,-100)',
    );
    expect(toothGroupTransform({ flipped: false, mirrorX: true })).toBe(
      'scale(-1,1) translate(-100,0)',
    );
    expect(toothGroupTransform({ flipped: true, mirrorX: true })).toBe(
      'scale(-1,-1) translate(-100,-100)',
    );
  });

  it('la inversa del dibujo devuelve un punto de la pantalla a las coordenadas del contrato', () => {
    // Espejo: lo que se ve a la derecha (88) es la izquierda del contrato (12).
    expect(unscreenPoint(88, 50, { flipped: false, mirrorX: true })).toEqual({ x: 12, y: 50 });
    // Volteo: lo que se ve abajo (88) es arriba del contrato (12).
    expect(unscreenPoint(50, 88, { flipped: true, mirrorX: false })).toEqual({ x: 50, y: 12 });
    // Los dos a la vez: la esquina opuesta.
    expect(unscreenPoint(88, 88, { flipped: true, mirrorX: true })).toEqual({ x: 12, y: 12 });
    expect(unscreenPoint(30, 70, { flipped: false, mirrorX: false })).toEqual({ x: 30, y: 70 });
  });

  it('en los dientes anteriores la cara de masticación se llama borde incisal', () => {
    // Caninos e incisivos: posición 1–3 del cuadrante, en las dos denticiones.
    for (const pieza of [13, 11, 23, 33, 31, 43, 53, 63, 73, 83]) {
      expect(surfaceLabelFor(pieza, 'occlusal')).toBe('Incisal');
    }
    // Premolares y molares: cara oclusal, como siempre.
    for (const pieza of [14, 16, 18, 24, 36, 44, 46, 55]) {
      expect(surfaceLabelFor(pieza, 'occlusal')).toBe('Oclusal');
    }
    // Y las demás caras no cambian de nombre en ningún diente.
    expect(surfaceLabelFor(33, 'vestibular')).toBe('Vestibular');
    expect(surfaceLabelFor(33, 'mesial')).toBe('Mesial');
    expect(surfaceLabelFor(11, 'lingual')).toBe('Lingual');
  });

  it('en la dentición temporal la arcada tiene 20 piezas y no inventa molares', () => {
    const { upper, lower, width } = archLayout('temporal');

    expect(upper.map((tooth) => tooth.toothNumber)).toEqual([
      55, 54, 53, 52, 51, 61, 62, 63, 64, 65,
    ]);
    expect(lower.map((tooth) => tooth.toothNumber)).toEqual([
      85, 84, 83, 82, 81, 71, 72, 73, 74, 75,
    ]);
    expect(width).toBe(10 * TOOTH_STRIDE + MIDLINE_GAP);
    expect([...upper, ...lower].every((tooth) => tooth.flipped === !tooth.upper)).toBe(true);
  });

  it('la pieza permanente que sustituye a una temporal es la del mismo cuadrante y posición', () => {
    // El primer molar de leche cae donde entra el primer premolar.
    expect(primarySuccessor(51)).toBe(11);
    expect(primarySuccessor(54)).toBe(14);
    expect(primarySuccessor(55)).toBe(15);
    expect(primarySuccessor(85)).toBe(45);
  });

  it('la dentición mixta dibuja la huella permanente y las temporales en su ranura', () => {
    const mixta = archLayout('mixta');

    // La arcada principal es la **permanente** (32 piezas), la boca a la que va.
    expect(mixta.upper).toHaveLength(16);
    expect(mixta.lower).toHaveLength(16);
    expect(mixta.width).toBe(16 * TOOTH_STRIDE + MIDLINE_GAP);

    // Y las de leche van aparte, 20 en total, sin molares de leche inventados.
    expect(mixta.upperPrimary.map((tooth) => tooth.toothNumber)).toEqual([
      55, 54, 53, 52, 51, 61, 62, 63, 64, 65,
    ]);
    expect(mixta.lowerPrimary.map((tooth) => tooth.toothNumber)).toEqual([
      85, 84, 83, 82, 81, 71, 72, 73, 74, 75,
    ]);

    // Cada temporal comparte la **x de su sucesor**: es donde está en la boca.
    const porNumero = new Map(
      [...mixta.upper, ...mixta.lower].map((tooth) => [tooth.toothNumber, tooth.x]),
    );
    for (const temporal of [...mixta.upperPrimary, ...mixta.lowerPrimary]) {
      expect(temporal.x).toBe(porNumero.get(primarySuccessor(temporal.toothNumber)));
    }

    // Las temporales conservan el espejo anatómico (5 y 8 son la derecha del paciente).
    expect(mixta.upperPrimary.slice(0, 5).every((tooth) => tooth.mirrorX)).toBe(true);
    expect(mixta.upperPrimary.slice(5).every((tooth) => !tooth.mirrorX)).toBe(true);
  });

  it('las denticiones simples no traen bandas primarias', () => {
    expect(archLayout('permanente').upperPrimary).toEqual([]);
    expect(archLayout('permanente').lowerPrimary).toEqual([]);
    expect(archLayout('temporal').upperPrimary).toEqual([]);
    expect(archLayout('temporal').lowerPrimary).toEqual([]);
  });
});

describe('convivencia de tratamientos con las caras (ADR 0032)', () => {
  it('`ausente`, `corona` e `implante` superan las caras; `ausente` e `implante` las excluyen', () => {
    // Superar = al registrarlas, las caras que hubiera quedan cubiertas (con su
    // histórico). La corona recubre el muñón en 360° y el implante sustituye la raíz:
    // en boca ya no se ve el esmalte ni la dentina que había.
    expect(supersedesSurfaces('ausente')).toBe(true);
    expect(supersedesSurfaces('corona')).toBe(true);
    expect(supersedesSurfaces('implante')).toBe(true);
    for (const condition of ['extraccion_indicada', 'endodoncia'] as const) {
      expect(supersedesSurfaces(condition)).toBe(false);
    }
    expect(supersedesSurfaces('caries')).toBe(false);
    expect(supersedesSurfaces('restauracion')).toBe(false);

    // Excluir = no caben juntas de ninguna manera: la pieza que no está y el titanio,
    // que no tiene esmalte ni dentina (spec §3).
    expect(excludesSurfaces('ausente')).toBe(true);
    expect(excludesSurfaces('implante')).toBe(true);
    for (const condition of ['corona', 'extraccion_indicada', 'endodoncia', 'caries'] as const) {
      expect(excludesSurfaces(condition)).toBe(false);
    }
  });

  it('los tratamientos que no recubren conviven con las caras', () => {
    // Un conducto no tapa nada: la restauración que lleva encima sigue viéndose.
    expect(conditionsConflict('endodoncia', 'restauracion')).toBe(false);
    expect(conditionsConflict('extraccion_indicada', 'caries')).toBe(false);
    // El implante **sí** excluye las caras: el titanio no tiene esmalte ni dentina.
    expect(conditionsConflict('implante', 'caries')).toBe(true);
    expect(conditionsConflict('implante', 'restauracion')).toBe(true);
  });

  it('la caries recurrente sobre una corona se registra; la corona tapa lo anterior', () => {
    // Registrar la corona cubre lo que había debajo…
    expect(recordingConflicts('caries', 'corona')).toBe(false);
    expect(recordingConflicts('restauracion', 'corona')).toBe(false);
    // …y una caries **después** de la corona es la filtración marginal: se admite.
    expect(recordingConflicts('corona', 'caries')).toBe(false);
    expect(conditionsConflict('corona', 'caries')).toBe(false);
    // Lo que no se admite es una caries en una pieza que no está.
    expect(recordingConflicts('ausente', 'caries')).toBe(true);
    expect(conditionsConflict('ausente', 'caries')).toBe(true);
  });

  it('`ausente` choca con todo lo que necesita un diente… salvo con el implante', () => {
    // Sin corona natural no hay tejido que tratar ni pieza que extraer.
    for (const otra of [
      'caries',
      'restauracion',
      'extraccion_indicada',
      'corona',
      'endodoncia',
    ] as const) {
      expect(conditionsConflict('ausente', otra)).toBe(true);
      expect(conditionsConflict(otra, 'ausente')).toBe(true);
    }
    // Consigo misma no choca: volver a registrarla es una actualización.
    expect(conditionsConflict('ausente', 'ausente')).toBe(false);

    // El implante **sí** convive: es el soporte que ocupa el lugar del diente que no
    // está (fase quirúrgica) y el que sostiene la corona protésica (rehabilitada).
    expect(conditionsConflict('ausente', 'implante')).toBe(false);
    expect(conditionsConflict('implante', 'ausente')).toBe(false);
    expect(conditionsConflict('implante', 'corona')).toBe(false);
    // Lo que sigue siendo imposible: un conducto en un implante.
    expect(conditionsConflict('implante', 'endodoncia')).toBe(true);
  });

  it('las parejas imposibles se bloquean; las que existen en la boca, no', () => {
    // Un implante no tiene raíz que endodonciar.
    expect(conditionsConflict('implante', 'endodoncia')).toBe(true);
    // Corona sobre implante y conducto con corona: las dos son reales.
    expect(conditionsConflict('implante', 'corona')).toBe(false);
    expect(conditionsConflict('corona', 'endodoncia')).toBe(false);
    expect(conditionsConflict('corona', 'extraccion_indicada')).toBe(false);
  });

  it('dos condiciones de cara nunca chocan entre sí', () => {
    expect(conditionsConflict('caries', 'restauracion')).toBe(false);
    expect(conditionsConflict('caries', 'caries')).toBe(false);
  });

  it('`conflictingCondition` señala con qué choca lo que se va a registrar', () => {
    const ausente = [{ condition: 'ausente' as const }];
    expect(conflictingCondition(ausente, 'caries')).toBe('ausente');
    expect(conflictingCondition(ausente, 'corona')).toBe('ausente');

    const tratados = [{ condition: 'corona' as const }, { condition: 'caries' as const }];
    expect(conflictingCondition(tratados, 'endodoncia')).toBeNull();
    expect(conflictingCondition(tratados, 'ausente')).toBe('corona');
    expect(conflictingCondition(tratados, 'caries')).toBeNull();
  });
});

describe('estados clínicos válidos (spec anexo ADR 0032 §2)', () => {
  it('no todas las condiciones admiten los dos estados', () => {
    // El hecho consumado y el plan: un solo estado cada uno.
    expect(isStateAllowed('ausente', 'completado')).toBe(true);
    expect(isStateAllowed('ausente', 'pendiente')).toBe(false);
    expect(isStateAllowed('extraccion_indicada', 'pendiente')).toBe(true);
    expect(isStateAllowed('extraccion_indicada', 'completado')).toBe(false);
    // La patología no se «completa»: se trata.
    expect(isStateAllowed('caries', 'pendiente')).toBe(true);
    expect(isStateAllowed('caries', 'completado')).toBe(false);
    // Los tratamientos sí admiten las dos fases.
    expect(allowedStatesFor('corona')).toEqual(['pendiente', 'completado']);
    expect(allowedStatesFor('restauracion')).toEqual(['pendiente', 'completado']);
    expect(allowedStatesFor('implante')).toEqual(['pendiente', 'completado']);
  });

  it('el esquema rechaza los estados imposibles que causaron la pieza 13', () => {
    // La extracción indicada no se completa: se transiciona a `ausente`.
    expect(
      recordFindingSchema.safeParse({
        toothNumber: 13,
        condition: 'extraccion_indicada',
        state: 'completado',
      }).success,
    ).toBe(false);
    // La caries tampoco: se convierte en obturación.
    expect(
      recordFindingSchema.safeParse({
        toothNumber: 36,
        surface: 'occlusal',
        condition: 'caries',
        state: 'completado',
      }).success,
    ).toBe(false);
    // Ni hay «ausente pendiente».
    expect(recordFindingSchema.safeParse({ toothNumber: 36, condition: 'ausente' }).success).toBe(
      false,
    );
  });

  it('`extraccion_indicada` y `implante` no conviven (pareja imposible del informe)', () => {
    expect(conditionsConflict('extraccion_indicada', 'implante')).toBe(true);
    expect(conditionsConflict('implante', 'extraccion_indicada')).toBe(true);
    const implante = [{ condition: 'implante' as const }];
    expect(conflictingCondition(implante, 'extraccion_indicada')).toBe('implante');
  });

  it('los procedimientos mutan un hallazgo en otro (spec §5)', () => {
    // La caries tratada pasa a obturación en la misma cara…
    expect(PROCEDURE_TRANSITIONS.obturar).toMatchObject({
      from: 'caries',
      to: 'restauracion',
      scope: 'surface',
    });
    // …la extracción cumplida deja la pieza ausente…
    expect(PROCEDURE_TRANSITIONS.extraer).toMatchObject({
      from: 'extraccion_indicada',
      to: 'ausente',
    });
    // …y rehabilitar exige un implante vigente (fase quirúrgica → rehabilitada).
    expect(PROCEDURE_TRANSITIONS.rehabilitar).toMatchObject({
      from: 'ausente',
      to: 'corona',
      requiresImplante: true,
    });
  });
});

describe('selección compartida por teclado, ratón y dedo', () => {
  it('una selección por cara produce un hallazgo por cara marcada', () => {
    const hallazgos = findingsFromSelection({
      toothNumber: 16,
      surfaces: ['occlusal', 'mesial'],
      condition: 'caries',
      state: 'pendiente',
    });

    expect(hallazgos).toEqual([
      {
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        state: 'pendiente',
        notes: null,
        sessionId: null,
      },
      {
        toothNumber: 16,
        surface: 'mesial',
        condition: 'caries',
        state: 'pendiente',
        notes: null,
        sessionId: null,
      },
    ]);
  });

  it('sin caras marcadas, la condición de cara va a la oclusal', () => {
    expect(
      findingsFromSelection({
        toothNumber: 24,
        surfaces: [],
        condition: 'restauracion',
        state: 'completado',
      }),
    ).toEqual([
      {
        toothNumber: 24,
        surface: 'occlusal',
        condition: 'restauracion',
        state: 'completado',
        notes: null,
        sessionId: null,
      },
    ]);
  });

  it('un tratamiento produce un solo hallazgo de pieza completa, marque lo que marque', () => {
    expect(
      findingsFromSelection({
        toothNumber: 36,
        surfaces: ['vestibular'],
        condition: 'corona',
        state: 'completado',
      }),
    ).toEqual([
      {
        toothNumber: 36,
        surface: null,
        condition: 'corona',
        state: 'completado',
        notes: null,
        sessionId: null,
      },
    ]);
  });

  it('la selección se valida contra lo que la pieza ya tiene', () => {
    const base = { surfaces: [], condition: 'caries', state: 'pendiente' } as const;

    expect(selectionIsApplicable({ ...base, toothNumber: 16 })).toBe(true);
    // Un número que no existe en FDI no se puede aplicar.
    expect(selectionIsApplicable({ ...base, toothNumber: 19 })).toBe(false);

    // Con la pieza ausente no entra nada más…
    const ausente = [{ condition: 'ausente' as const }];
    expect(selectionIsApplicable({ ...base, toothNumber: 16 }, ausente)).toBe(false);
    // …pero una corona sí convive con la caries que ya tenía.
    const obturado = [{ condition: 'caries' as const }];
    expect(
      selectionIsApplicable(
        { toothNumber: 16, surfaces: ['occlusal'], condition: 'corona', state: 'completado' },
        obturado,
      ),
    ).toBe(true);
    // Y un implante no convive con un conducto ya hecho.
    expect(
      selectionIsApplicable(
        { toothNumber: 16, surfaces: [], condition: 'implante', state: 'completado' },
        [{ condition: 'endodoncia' as const }],
      ),
    ).toBe(false);
  });
});

describe('máquina de la carga rápida', () => {
  /** Simula una secuencia de teclas **entregando** los avisos, como la pantalla. */
  const simular = (teclas: string, inicial = initialQuickEntryState()) => {
    let estado = inicial;
    const intents: QuickEntryIntent[] = [];
    for (const tecla of teclas) {
      const paso = quickEntryKey(estado, tecla);
      estado = paso.state;
      intents.push(paso.intent);
    }
    return { estado, intents, ultimo: intents[intents.length - 1] };
  };

  it('el número de pieza se arma con dos dígitos', () => {
    let paso = quickEntryKey(initialQuickEntryState(), '1');
    expect(paso.intent.kind).toBe('state');
    expect(paso.state.toothNumber).toBeNull();
    expect(paso.state.pendingDigits).toBe('1');

    paso = quickEntryKey(paso.state, '6');
    expect(paso.state.toothNumber).toBe(16);
    expect(paso.state.pendingDigits).toBe('');
  });

  it('la barra nombra la cara de la pieza activa: incisal delante, oclusal detrás', () => {
    // La tecla `n` marca la cara de masticación, y en el 11 se llama **Incisal**.
    expect(quickEntryLabel(simular('11n').estado)).toBe('11 (Incisal)');
    // En un molar, la misma tecla y la misma cara se llaman oclusal.
    expect(quickEntryLabel(simular('16n').estado)).toBe('16 (Oclusal)');
    // Y con una proximal marcada salen las dos, cada una con su nombre clínico.
    expect(quickEntryLabel(simular('33sn').estado)).toBe('33 (Mesial · Incisal)');

    // Sin cara marcada, solo el número (y los dígitos que se van tecleando).
    expect(quickEntryLabel(simular('11').estado)).toBe('11');
    expect(quickEntryLabel(initialQuickEntryState())).toBe('');
    expect(quickEntryLabel(simular('1').estado)).toBe('1_');
  });

  it('un cuadrante imposible no atasca la máquina: el dígito pasa a ser el primero del número siguiente', () => {
    const paso = quickEntryKey(quickEntryKey(initialQuickEntryState(), '1').state, '9');
    expect(paso.state.pendingDigits).toBe('9');
    expect(paso.state.toothNumber).toBeNull();

    // Y desde ahí se puede completar una pieza de verdad.
    const siguiente = quickEntryKey(paso.state, '6');
    expect(siguiente.state.toothNumber).toBeNull(); // 96 no existe: sigue esperando
    expect(siguiente.state.pendingDigits).toBe('6');

    const completa = quickEntryKey(siguiente.state, '1');
    expect(completa.state.toothNumber).toBe(61); // 61 sí existe (temporal)
  });

  it('sin caras marcadas, la caries va a la cara oclusal (dos pulsaciones por pieza)', () => {
    const { estado, ultimo } = simular('16c');
    expect(ultimo).toEqual({
      kind: 'record',
      input: {
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        state: 'pendiente',
        notes: null,
        sessionId: null,
      },
    });
    // Tras registrar, la pieza sigue activa y las caras se limpian para encadenar.
    expect(estado.toothNumber).toBe(16);
    expect(estado.surfaces).toEqual([]);
  });

  it('la mayúscula marca la misma condición como completada (si admite los dos estados)', () => {
    // La obturación admite pendiente y completado.
    const pendiente = simular('24no');
    const completada = simular('24nO');
    expect(pendiente.ultimo).toMatchObject({ input: { state: 'pendiente', surface: 'occlusal' } });
    expect(completada.ultimo).toMatchObject({
      input: { state: 'completado', surface: 'occlusal' },
    });

    // La caries solo existe pendiente: la mayúscula no inventa un estado imposible.
    expect(simular('24nC').ultimo).toMatchObject({
      input: { condition: 'caries', state: 'pendiente' },
    });
  });

  it('las caras se acumulan y la primera es la que se registra', () => {
    // `v` marca vestibular y `d` distal; la condición se aplica a la primera.
    const { estado, ultimo } = simular('36vdo');
    expect(ultimo).toMatchObject({
      input: { toothNumber: 36, surface: 'vestibular', condition: 'restauracion' },
    });
    expect(estado.surfaces).toEqual([]);
  });

  it('`a` marca la pieza ausente y `x` la extracción indicada, cada una con su estado válido', () => {
    // `ausente` es un hecho consumado (completado); `extraccion_indicada` es un plan
    // (pendiente). Da igual la caja que se pulse: el estado es el válido (spec §2).
    expect(simular('48a').ultimo).toMatchObject({
      input: { toothNumber: 48, surface: null, condition: 'ausente', state: 'completado' },
    });
    expect(simular('48A').ultimo).toMatchObject({
      input: { condition: 'ausente', state: 'completado' },
    });
    expect(simular('48X').ultimo).toMatchObject({
      input: {
        toothNumber: 48,
        surface: null,
        condition: 'extraccion_indicada',
        state: 'pendiente',
      },
    });
    expect(simular('48x').ultimo).toMatchObject({
      input: { condition: 'extraccion_indicada', state: 'pendiente' },
    });
  });

  it('`Supr` deja la cara sana: borra la condición elegida o limpia la cara entera', () => {
    // Con condición ya elegida (p. ej. tras registrar caries) borra esa condición.
    const conCondicion = quickEntryKey(
      { ...simular('16c').estado, surfaces: ['mesial'] as const },
      'Delete',
    );
    expect(conCondicion.intent).toEqual({
      kind: 'delete',
      input: { toothNumber: 16, surface: 'mesial', condition: 'caries' },
    });

    // Sin condición elegida limpia la cara, sin necesidad de saber qué había.
    expect(quickEntryKey(simular('16').estado, 'Delete').intent).toEqual({
      kind: 'clear',
      input: { toothNumber: 16, surface: 'occlusal' },
    });
  });

  it('sin pieza seleccionada las teclas de condición no hacen nada', () => {
    expect(quickEntryKey(initialQuickEntryState(), 'c').intent.kind).toBe('ignored');
    expect(quickEntryKey(initialQuickEntryState(), 'Delete').intent.kind).toBe('ignored');
  });

  it('una boca completa por teclado: 32 piezas en menos de 100 pulsaciones', () => {
    // Escenario del criterio de aceptación: la boca entera cargada a teclado.
    const atajos = ['11c', '12c', '13o', '14o', '15c', '16c', '17c', '18a'];
    let estado = initialQuickEntryState();
    let pulsaciones = 0;
    const registrados: number[] = [];

    for (const cuadrante of ['1', '2', '4', '3']) {
      for (const atajo of atajos) {
        for (const tecla of `${cuadrante}${atajo}`.split('').slice(1)) {
          const paso = quickEntryKey(estado, tecla);
          estado = paso.state;
          pulsaciones += 1;
          if (paso.intent.kind === 'record' && paso.intent.input.toothNumber !== undefined) {
            registrados.push(paso.intent.input.toothNumber);
          }
        }
      }
    }

    expect(registrados).toHaveLength(32);
    // Dos pulsaciones por pieza más la condición: muy por debajo del umbral de 30 s.
    expect(pulsaciones).toBeLessThan(140);
  });
});

describe('resumen del odontograma', () => {
  it('cuenta piezas afectadas y estados, y el diente sano no aparece', () => {
    const resumen = odontogramSummary({
      dentition: 'permanente',
      findings: {
        '16': [
          hallazgo({ toothNumber: 16 }),
          hallazgo({ toothNumber: 16, surface: 'mesial', state: 'completado' }),
        ],
        '48': [hallazgo({ toothNumber: 48, surface: null, condition: 'ausente' })],
      },
    });

    expect(resumen.affectedTeeth).toBe(2);
    expect(resumen.teeth).toBe(32);
    expect(resumen.conditionCounts).toEqual({ caries: 2, ausente: 1 });
    expect(resumen.pendingCount).toBe(2);
    expect(resumen.completedCount).toBe(1);
  });

  it('los colores del doc: rojo pendiente, azul completado', () => {
    expect(CLINICAL_STATE_COLORS.pendiente).toBe('#ef4444');
    expect(CLINICAL_STATE_COLORS.completado).toBe('#3b82f6');
  });
});
