import { describe, expect, it } from 'vitest';

import {
  acceptConsentSchema,
  anamnesisSectionSchema,
  clinicalAlerts,
  clinicalSectionIsComplete,
  createAmendmentSchema,
  diagnosisSectionSchema,
  hasPenicillinAllergy,
  missingSignatureSections,
  motivoConsultaSectionSchema,
  saveClinicalSectionSchema,
  signMedicalRecordSchema,
  treatmentPlanSectionSchema,
} from './clinical.js';

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

  it('el plan de tratamiento necesita al menos un procedimiento', () => {
    const vacio = treatmentPlanSectionSchema.parse({ procedimientos: [] });
    expect(clinicalSectionIsComplete('plan_tratamiento', vacio)).toBe(false);

    const conProcedimiento = treatmentPlanSectionSchema.parse({
      procedimientos: [{ descripcion: 'Obturación en 26', prioridad: 'alta' }],
    });
    expect(clinicalSectionIsComplete('plan_tratamiento', conProcedimiento)).toBe(true);
  });

  it('el diagnóstico exige un diagnóstico principal', () => {
    expect(diagnosisSectionSchema.safeParse({ principal: '' }).success).toBe(false);
    expect(
      clinicalSectionIsComplete(
        'diagnostico',
        diagnosisSectionSchema.parse({ principal: 'Caries' }),
      ),
    ).toBe(true);
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
      diagnostico: { principal: 'Pulpitis irreversible' },
      plan_tratamiento: { procedimientos: [{ descripcion: 'Endodoncia 46' }] },
    });
    expect(faltantes).toEqual([]);
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
