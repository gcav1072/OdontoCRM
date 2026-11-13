import { describe, expect, it } from 'vitest';

import {
  acceptConsentSchema,
  anamnesisSectionSchema,
  clinicalAlerts,
  clinicalEvolutionSessionSummarySchema,
  clinicalRecordDetailSchema,
  clinicalSectionIsComplete,
  createAmendmentSchema,
  diagnosisSectionSchema,
  evolutionSectionSchema,
  hasPenicillinAllergy,
  intraoralExamSectionSchema,
  missingSignatureSections,
  motivoConsultaSectionSchema,
  saveClinicalSectionSchema,
  signMedicalRecordSchema,
  syncPlanWithDiagnosis,
  treatmentPlanProcedureSchema,
  treatmentPlanSectionSchema,
} from './clinical.js';

/** UUIDs fijos: el contrato exige `id` y el test no debe depender de aleatoriedad. */
const DIAG_ID = '00000000-0000-4000-8000-000000000001';
const DIAG_ID_2 = '00000000-0000-4000-8000-000000000002';
const DIAG_ID_HUERFANO = '00000000-0000-4000-8000-000000000009';

const anamnesisBase = anamnesisSectionSchema.parse({
  alergias: { items: [], otros: null },
  patologicos: { items: [], otros: null },
  medicamentos: { items: [], otros: null },
  cirugias: { items: [], otros: null },
  familiares: { items: [], otros: null },
  habitos: { items: [], otros: null },
});

describe('catálogos tipificados y «otros»', () => {
  it('una casilla desconocida no pasa la validación', () => {
    const result = anamnesisSectionSchema.safeParse({
      ...anamnesisBase,
      alergias: { items: ['chocolate'], otros: null },
    });
    expect(result.success).toBe(false);
  });

  it('«otros» exige el texto libre', () => {
    const sinTexto = anamnesisSectionSchema.safeParse({
      ...anamnesisBase,
      alergias: { items: ['otros'], otros: null },
    });
    expect(sinTexto.success).toBe(false);

    const conTexto = anamnesisSectionSchema.safeParse({
      ...anamnesisBase,
      alergias: { items: ['penicilina', 'otros'], otros: 'Metamizol' },
    });
    expect(conTexto.success).toBe(true);
  });
});

describe('contenido mínimo por sección', () => {
  it('el motivo de consulta exige un relato con sustancia', () => {
    const corto = motivoConsultaSectionSchema.safeParse({ relato: 'duele' });
    expect(corto.success).toBe(false);

    const valido = motivoConsultaSectionSchema.parse({
      relato: 'Me duele la muela desde hace tres días',
    });
    expect(clinicalSectionIsComplete('motivo_consulta', valido)).toBe(true);
  });

  it('«sin antecedentes» deja la anamnesis completa sin casillas', () => {
    const sin = anamnesisSectionSchema.parse({ ...anamnesisBase, sinAntecedentes: true });
    expect(clinicalSectionIsComplete('anamnesis', sin)).toBe(true);

    const vacia = anamnesisSectionSchema.parse(anamnesisBase);
    expect(clinicalSectionIsComplete('anamnesis', vacia)).toBe(false);
  });

  it('el plan de tratamiento necesita procedimientos con descripción', () => {
    const vacio = treatmentPlanSectionSchema.parse({ procedimientos: [] });
    expect(clinicalSectionIsComplete('plan_tratamiento', vacio)).toBe(false);

    // Un ítem vinculado nace vacío para completarlo en el plan: el borrador es
    // válido, pero la sección no está lista para firmar.
    const porCompletar = treatmentPlanSectionSchema.parse({
      procedimientos: [{ diagnosticoId: DIAG_ID, descripcion: '' }],
    });
    expect(porCompletar.procedimientos[0]?.descripcion).toBe('');
    expect(clinicalSectionIsComplete('plan_tratamiento', porCompletar)).toBe(false);

    const conProcedimiento = treatmentPlanSectionSchema.parse({
      procedimientos: [{ descripcion: 'Obturación en 26', prioridad: 'alta' }],
    });
    expect(clinicalSectionIsComplete('plan_tratamiento', conProcedimiento)).toBe(true);
  });

  it('el diagnóstico exige ítems con descripción', () => {
    expect(clinicalSectionIsComplete('diagnostico', diagnosisSectionSchema.parse({}))).toBe(false);
    expect(
      diagnosisSectionSchema.safeParse({ items: [{ id: DIAG_ID, descripcion: 'Ca' }] }).success,
    ).toBe(false);

    const conItem = diagnosisSectionSchema.parse({
      items: [{ id: DIAG_ID, descripcion: 'Caries oclusal', piezas: '26' }],
    });
    expect(clinicalSectionIsComplete('diagnostico', conItem)).toBe(true);
  });
});

describe('bloqueo de firma sin secciones obligatorias', () => {
  it('una historia vacía no se puede firmar y enumera lo que falta', () => {
    const faltantes = missingSignatureSections({});
    expect(faltantes).toContain('motivo_consulta');
    expect(faltantes).toContain('diagnostico');
    expect(faltantes.length).toBeGreaterThan(3);
  });

  it('con las secciones obligatorias completas no falta ninguna', () => {
    const faltantes = missingSignatureSections({
      motivo_consulta: { relato: 'Dolor en el molar inferior derecho' },
      anamnesis: { sinAntecedentes: true },
      examen_extraoral: { tejidosBlandos: 'normal' },
      examen_intraoral: { encias: 'normal' },
      diagnostico: {
        items: [{ id: DIAG_ID, descripcion: 'Pulpitis irreversible', piezas: '46' }],
      },
      plan_tratamiento: {
        procedimientos: [{ diagnosticoId: DIAG_ID, descripcion: 'Endodoncia 46' }],
      },
    });
    expect(faltantes).toEqual([]);
  });

  it('un diagnóstico sin su tratamiento en el plan bloquea la firma', () => {
    const faltantes = missingSignatureSections({
      motivo_consulta: { relato: 'Dolor en el molar inferior derecho' },
      anamnesis: { sinAntecedentes: true },
      examen_extraoral: { tejidosBlandos: 'normal' },
      examen_intraoral: { encias: 'normal' },
      diagnostico: {
        items: [
          { id: DIAG_ID, descripcion: 'Pulpitis irreversible', piezas: '46' },
          { id: DIAG_ID_2, descripcion: 'Caries en 26', piezas: '26' },
        ],
      },
      plan_tratamiento: {
        procedimientos: [{ diagnosticoId: DIAG_ID, descripcion: 'Endodoncia 46' }],
      },
    });
    expect(faltantes).toContain('plan_tratamiento');
    // No se duplica aunque la sección ya estuviera en la lista por otra razón.
    expect(faltantes.filter((key) => key === 'plan_tratamiento')).toHaveLength(1);
  });
});

describe('examen intraoral: relación molar y canina (v1.2)', () => {
  it('«sin dato» no cuenta como hallazgo evaluado', () => {
    const sinDato = intraoralExamSectionSchema.parse({
      relacionMolar: 'sin_dato',
      relacionCanina: 'sin_dato',
    });
    expect(clinicalSectionIsComplete('examen_intraoral', sinDato)).toBe(false);

    const evaluado = intraoralExamSectionSchema.parse({
      relacionMolar: 'tipo_i',
      relacionCanina: 'sin_dato',
    });
    expect(clinicalSectionIsComplete('examen_intraoral', evaluado)).toBe(true);
  });

  it('solo admite los tipos de Angle y normaliza el vacío a null', () => {
    expect(intraoralExamSectionSchema.safeParse({ relacionMolar: 'normal' }).success).toBe(false);
    expect(intraoralExamSectionSchema.parse({}).relacionMolar).toBeNull();
    expect(intraoralExamSectionSchema.parse({ relacionCanina: 'tipo_iii' }).relacionCanina).toBe(
      'tipo_iii',
    );
  });
});

describe('sincronización diagnóstico ↔ plan (v1.2)', () => {
  const diagnostico = (
    items: { id: string; descripcion: string; piezas: string | null }[],
  ): Record<string, unknown> => ({ items, saludBucalGeneral: null, observaciones: null });

  const plan = (procedimientos: Record<string, unknown>[]): Record<string, unknown> => ({
    procedimientos,
    alternativas: null,
    aceptacionPaciente: null,
    observaciones: null,
  });

  it('cada diagnóstico abre su procedimiento vacío con la pieza del diagnóstico', () => {
    const sincronizado = syncPlanWithDiagnosis(
      diagnostico([
        { id: DIAG_ID, descripcion: 'Caries en 16 y 26', piezas: '16, 26' },
        { id: DIAG_ID_2, descripcion: 'Gingivitis', piezas: null },
      ]),
      plan([]),
    );
    expect(sincronizado['procedimientos']).toEqual([
      {
        diagnosticoId: DIAG_ID,
        descripcion: '',
        prioridad: 'media',
        pieza: '16, 26',
        presupuesto: null,
      },
      {
        diagnosticoId: DIAG_ID_2,
        descripcion: '',
        prioridad: 'media',
        pieza: null,
        presupuesto: null,
      },
    ]);
  });

  it('respeta lo escrito, deriva la pieza del diagnóstico y borra los huérfanos', () => {
    const sincronizado = syncPlanWithDiagnosis(
      diagnostico([
        { id: DIAG_ID, descripcion: 'Caries en 16 y 26', piezas: '16, 26' },
        { id: DIAG_ID_2, descripcion: 'Gingivitis', piezas: null },
      ]),
      plan([
        {
          diagnosticoId: DIAG_ID,
          descripcion: 'Obturación',
          prioridad: 'alta',
          pieza: '16',
          presupuesto: 120,
        },
        {
          diagnosticoId: DIAG_ID_HUERFANO,
          descripcion: 'Procedimiento de un diagnóstico borrado',
          prioridad: 'media',
          pieza: null,
          presupuesto: null,
        },
        {
          diagnosticoId: null,
          descripcion: 'Limpieza general',
          prioridad: 'baja',
          pieza: 'toda la boca',
          presupuesto: null,
        },
      ]),
    );
    expect(sincronizado['procedimientos']).toEqual([
      {
        diagnosticoId: DIAG_ID,
        descripcion: 'Obturación',
        prioridad: 'alta',
        pieza: '16, 26',
        presupuesto: 120,
      },
      {
        diagnosticoId: DIAG_ID_2,
        descripcion: '',
        prioridad: 'media',
        pieza: null,
        presupuesto: null,
      },
      {
        diagnosticoId: null,
        descripcion: 'Limpieza general',
        prioridad: 'baja',
        pieza: 'toda la boca',
        presupuesto: null,
      },
    ]);
  });

  it('el resultado sincronizado es válido como borrador del plan', () => {
    const sincronizado = syncPlanWithDiagnosis(
      diagnostico([{ id: DIAG_ID, descripcion: 'Caries en 26', piezas: '26' }]),
      plan([]),
    );
    const parsed = treatmentPlanSectionSchema.parse(sincronizado);
    expect(parsed.procedimientos).toHaveLength(1);
    expect(parsed.procedimientos[0]).toMatchObject({
      diagnosticoId: DIAG_ID,
      descripcion: '',
      pieza: '26',
      prioridad: 'media',
    });
  });

  it('el procedimiento suelto admite presupuesto y prioridad; el vacío usa defaults', () => {
    const parsed = treatmentPlanProcedureSchema.parse({ descripcion: 'Limpieza' });
    expect(parsed).toMatchObject({
      diagnosticoId: null,
      descripcion: 'Limpieza',
      prioridad: 'media',
      pieza: null,
      presupuesto: null,
    });
  });
});

describe('evolución clínica y sesiones cerradas (v1.2)', () => {
  it('la sección evolución solo guarda el cuadro manual', () => {
    expect(evolutionSectionSchema.parse({}).observaciones).toBeNull();
    expect(clinicalSectionIsComplete('evolucion', { observaciones: 'Control favorable' })).toBe(
      true,
    );
    expect(clinicalSectionIsComplete('evolucion', {})).toBe(false);
  });

  it('el resumen de una sesión cerrada lleva fecha, diagnóstico, tratamientos y observaciones', () => {
    const sesion = clinicalEvolutionSessionSummarySchema.parse({
      id: DIAG_ID,
      sessionNumber: 3,
      fecha: '2026-11-13T10:00:00.000Z',
      diagnostico: 'Pulpitis en 46',
      tratamientos: ['Endodoncia 46'],
      observaciones: 'Sin complicaciones',
    });
    expect(sesion).toMatchObject({
      sessionNumber: 3,
      diagnostico: 'Pulpitis en 46',
      tratamientos: ['Endodoncia 46'],
      observaciones: 'Sin complicaciones',
    });
  });

  it('el detalle de la historia siempre trae la evolución (aunque no venga en el payload)', () => {
    const parsed = clinicalRecordDetailSchema.parse({
      id: DIAG_ID,
      patientId: DIAG_ID_2,
      status: 'borrador',
      openedAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
      signedAt: null,
      signedByUsername: null,
      amendmentCount: 0,
      completedSections: [],
      missingSections: [],
      consentAccepted: false,
      alerts: [],
      patient: null,
      sections: {},
      amendments: [],
      consent: null,
    });
    expect(parsed.evolutionSessions).toEqual([]);
  });
});

describe('alertas clínicas', () => {
  it('la alergia a penicilina se resalta', () => {
    const sections = {
      anamnesis: {
        ...anamnesisBase,
        alergias: { items: ['penicilina'], otros: null },
      },
    };
    expect(hasPenicillinAllergy(sections)).toBe(true);
    expect(clinicalAlerts(sections).map((alert) => alert.code)).toContain('alergia_penicilina');
  });

  it('el «otros» de la anamnesis viaja como detalle de la alerta', () => {
    const sections = {
      anamnesis: {
        ...anamnesisBase,
        medicamentos: { items: ['otros'], otros: 'Warfarina' },
      },
    };
    const alerta = clinicalAlerts(sections).find((item) => item.code === 'medicamento_otro');
    expect(alerta?.detail).toBe('Warfarina');
  });
});

describe('firma, adendas y consentimiento', () => {
  it('la firma exige confirmación explícita', () => {
    expect(signMedicalRecordSchema.safeParse({}).success).toBe(false);
    expect(signMedicalRecordSchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it('una adenda exige motivo y texto', () => {
    expect(createAmendmentSchema.safeParse({ content: 'Corrección' }).success).toBe(false);
    expect(
      createAmendmentSchema.safeParse({ reason: 'Error de tecleo', content: 'Corrección' }).success,
    ).toBe(true);
  });

  it('el consentimiento registra quién acepta y su relación', () => {
    const result = acceptConsentSchema.parse({
      accepted: true,
      acceptedByName: 'María Pérez',
      relationship: 'paciente',
      witnessName: null,
      notes: null,
    });
    expect(result.accepted).toBe(true);
  });
});

describe('guardado de secciones', () => {
  it('el cuerpo guardado es un objeto de campos', () => {
    expect(saveClinicalSectionSchema.safeParse({ content: { relato: 'x' } }).success).toBe(true);
    expect(saveClinicalSectionSchema.safeParse({ content: 7 }).success).toBe(false);
  });

  it('un procedimiento con presupuesto negativo no pasa', () => {
    const result = treatmentPlanSectionSchema.safeParse({
      procedimientos: [{ descripcion: 'Limpieza', presupuesto: -1 }],
    });
    expect(result.success).toBe(false);
  });
});
