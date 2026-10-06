import { describe, expect, it } from 'vitest';

import {
  clinicalSessionCanClose,
  clinicalSessionContentSchema,
  clinicalSessionHasContent,
  clinicalSessionSummaryText,
  closeClinicalSessionSchema,
  createClinicalSessionSchema,
  emptyClinicalSessionContent,
  formatSessionNumber,
  SESSION_MATERIALS,
  SESSION_PROCEDURES,
  saveClinicalSessionSchema,
  sessionProcedureBlocks,
  sessionProcedureSchema,
  sessionProcedureText,
  SESSION_MATERIAL_CODES,
  SESSION_PROCEDURE_CODES,
} from './clinical-session.js';

const contenidoBase = emptyClinicalSessionContent();

describe('catálogos de la sesión', () => {
  it('los códigos y las etiquetas no se separan', () => {
    expect(SESSION_PROCEDURES.map((item) => item.code)).toEqual([...SESSION_PROCEDURE_CODES]);
    expect(SESSION_MATERIALS.map((item) => item.code)).toEqual([...SESSION_MATERIAL_CODES]);
    expect(new Set(SESSION_PROCEDURE_CODES).size).toBe(SESSION_PROCEDURE_CODES.length);
    expect(new Set(SESSION_MATERIAL_CODES).size).toBe(SESSION_MATERIAL_CODES.length);
    expect(SESSION_PROCEDURE_CODES).toContain('otros');
    expect(SESSION_MATERIAL_CODES).toContain('otros');
  });

  it('un procedimiento de fuera del catálogo no pasa', () => {
    const result = sessionProcedureSchema.safeParse({ code: 'sacar_muela' });
    expect(result.success).toBe(false);
  });

  it('«otro procedimiento» exige el texto libre', () => {
    expect(sessionProcedureSchema.safeParse({ code: 'otros' }).success).toBe(false);
    const conTexto = sessionProcedureSchema.safeParse({
      code: 'otros',
      detalle: 'Frenectomía lingual',
      toothNumber: null,
      surfaces: [],
      notas: null,
    });
    expect(conTexto.success).toBe(true);
  });

  it('las caras necesitan su pieza', () => {
    const sinPieza = sessionProcedureSchema.safeParse({
      code: 'obturacion_resina',
      surfaces: ['occlusal'],
    });
    expect(sinPieza.success).toBe(false);

    const conPieza = sessionProcedureSchema.safeParse({
      code: 'obturacion_resina',
      toothNumber: 26,
      surfaces: ['occlusal', 'mesial'],
    });
    expect(conPieza.success).toBe(true);
  });

  it('la pieza tiene que existir en FDI', () => {
    expect(sessionProcedureSchema.safeParse({ code: 'profilaxis', toothNumber: 99 }).success).toBe(
      false,
    );
  });
});

describe('signos vitales', () => {
  const guardar = (vitals: Record<string, unknown>) =>
    clinicalSessionContentSchema.safeParse({ ...contenidoBase, vitals });

  it('el vacío es «sin dato», no un cero', () => {
    const parsed = clinicalSessionContentSchema.parse(contenidoBase);
    expect(parsed.vitals).toEqual({
      taSistolica: null,
      taDiastolica: null,
      fc: null,
      temperatura: null,
      spo2: null,
      peso: null,
    });

    const conVacio = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      vitals: { peso: '', fc: null },
    });
    expect(conVacio.vitals.peso).toBeNull();
    expect(conVacio.vitals.fc).toBeNull();
  });

  it('acepta los números del formulario como texto', () => {
    const parsed = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      vitals: { taSistolica: '120', taDiastolica: '80', temperatura: '36.5', peso: '68.4' },
    });
    expect(parsed.vitals.taSistolica).toBe(120);
    expect(parsed.vitals.temperatura).toBe(36.5);
    expect(parsed.vitals.peso).toBe(68.4);
  });

  it('rechaza una tensión al revés y un valor fuera de rango', () => {
    const alReves = guardar({ taSistolica: 80, taDiastolica: 120 });
    expect(alReves.success).toBe(false);

    expect(guardar({ peso: 900 }).success).toBe(false);
    expect(guardar({ spo2: 150 }).success).toBe(false);
    expect(guardar({ temperatura: 'no la se' }).success).toBe(false);
  });

  it('la temperatura admite un decimal y no dos', () => {
    expect(guardar({ temperatura: 36.5 }).success).toBe(true);
    expect(guardar({ temperatura: 36.55 }).success).toBe(false);
  });
});

describe('documento de la sesión', () => {
  it('la sesión vacía es válida y estable', () => {
    const parsed = clinicalSessionContentSchema.parse(contenidoBase);
    expect(parsed).toEqual(contenidoBase);
    expect(clinicalSessionHasContent(parsed)).toBe(false);
    expect(clinicalSessionCanClose(parsed)).toBe(false);
  });

  it('una sesión con motivo ya se puede cerrar', () => {
    const conMotivo = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      motivo: 'Control de la obturación',
    });
    expect(clinicalSessionHasContent(conMotivo)).toBe(true);
    expect(clinicalSessionCanClose(conMotivo)).toBe(true);
  });

  it('un procedimiento cuenta como contenido y describe la pieza y las caras', () => {
    const conProcedimiento = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      procedimientos: [
        { code: 'obturacion_resina', toothNumber: 26, surfaces: ['occlusal', 'mesial'] },
      ],
    });
    expect(clinicalSessionHasContent(conProcedimiento)).toBe(true);
    expect(sessionProcedureText(conProcedimiento.procedimientos[0]!)).toBe(
      'Obturación con resina compuesta · pieza 26 (Oclusal, Mesial)',
    );
  });

  it('en incisivos y caninos la cara de masticación se llama borde incisal', () => {
    const enIncisivo = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      procedimientos: [{ code: 'obturacion_resina', toothNumber: 11, surfaces: ['occlusal'] }],
    });
    expect(sessionProcedureText(enIncisivo.procedimientos[0]!)).toContain('(Incisal)');
  });

  it('el resumen dice cuántos procedimientos hay, sin inventar', () => {
    expect(clinicalSessionSummaryText(contenidoBase)).toBe('Consulta sin procedimientos');
    expect(
      clinicalSessionSummaryText(
        clinicalSessionContentSchema.parse({ ...contenidoBase, motivo: 'Dolor en 46' }),
      ),
    ).toBe('Consulta: Dolor en 46');

    const tres = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      procedimientos: [
        { code: 'profilaxis' },
        { code: 'aplicacion_fluor' },
        { code: 'sellante', toothNumber: 36 },
      ],
    });
    expect(clinicalSessionSummaryText(tres)).toContain('3 procedimientos');
  });

  it('el número de sesión se formatea sin guardarse formateado', () => {
    expect(formatSessionNumber(1)).toBe('S-000001');
    expect(formatSessionNumber(123456)).toBe('S-123456');
  });
});

describe('entradas de la API', () => {
  it('abrir una sesión sin cita es válido, y `null` se normaliza', () => {
    expect(createClinicalSessionSchema.parse({})).toEqual({ appointmentId: null, motivo: null });
    expect(createClinicalSessionSchema.parse({ appointmentId: null }).appointmentId).toBeNull();
    expect(createClinicalSessionSchema.safeParse({ appointmentId: 'no-es-un-uuid' }).success).toBe(
      false,
    );
  });

  it('el autoguardado manda el documento completo', () => {
    const ok = saveClinicalSessionSchema.safeParse({ content: contenidoBase });
    expect(ok.success).toBe(true);
    expect(saveClinicalSessionSchema.safeParse({}).success).toBe(false);
    expect(saveClinicalSessionSchema.safeParse({ content: { motivo: 'x' } }).success).toBe(false);
  });

  it('cerrar exige confirmación', () => {
    expect(closeClinicalSessionSchema.safeParse({}).success).toBe(false);
    expect(closeClinicalSessionSchema.parse({ confirm: true })).toEqual({
      confirm: true,
      closureNote: null,
    });
  });
});

describe('lo que el evento publica de una sesión cerrada (ADR 0041)', () => {
  it('lleva código, detalle, pieza y caras de cada procedimiento', () => {
    const procedimientos = clinicalSessionContentSchema.parse({
      ...contenidoBase,
      procedimientos: [
        { code: 'obturacion_resina', toothNumber: 26, surfaces: ['occlusal', 'mesial'] },
        { code: 'profilaxis' },
        {
          code: 'otros',
          detalle: 'Sellado de fosas profundo',
          toothNumber: 36,
          surfaces: ['occlusal'],
        },
      ],
    }).procedimientos;

    expect(sessionProcedureBlocks(procedimientos)).toEqual([
      {
        code: 'obturacion_resina',
        detail: null,
        toothNumber: 26,
        surfaces: ['occlusal', 'mesial'],
      },
      { code: 'profilaxis', detail: null, toothNumber: null, surfaces: [] },
      {
        code: 'otros',
        detail: 'Sellado de fosas profundo',
        toothNumber: 36,
        surfaces: ['occlusal'],
      },
    ]);
  });

  it('una sesión sin procedimientos publica una lista vacía, no `undefined`', () => {
    // El borrador de factura itera la lista: `undefined` lo obligaría a defenderse.
    expect(sessionProcedureBlocks([])).toEqual([]);
  });
});
