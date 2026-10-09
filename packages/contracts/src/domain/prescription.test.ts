import { describe, expect, it } from 'vitest';

import {
  annulPrescriptionSchema,
  clinicalAttachmentKindLabel,
  clinicalAttachmentSchema,
  createPrescriptionSchema,
  formatPrescriptionNumber,
  medicationRouteLabel,
  medicationSchema,
  prescriptionIsDraft,
  prescriptionStatusLabel,
  prescriptionVerificationResultSchema,
  prescriptionVerificationSchema,
} from './prescription.js';

const recetaValida = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  items: [
    {
      medicationName: 'Amoxicilina',
      presentation: 'Tabletas 500 mg',
      route: 'oral',
      dose: '500 mg',
      frequency: 'cada 8 horas',
      duration: '7 días',
      instructions: 'Después de las comidas',
      quantity: '21 tabletas',
    },
  ],
  generalInstructions: 'Volver si el dolor no cede.',
};

describe('el récipe como documento', () => {
  it('el número se formatea a seis dígitos', () => {
    expect(formatPrescriptionNumber(1)).toBe('RX-000001');
    expect(formatPrescriptionNumber(123456)).toBe('RX-123456');
  });

  it('un récipe necesita al menos un medicamento', () => {
    const vacio = createPrescriptionSchema.safeParse({ ...recetaValida, items: [] });
    expect(vacio.success).toBe(false);

    const ok = createPrescriptionSchema.parse(recetaValida);
    expect(ok.items).toHaveLength(1);
    // El medicamento sin dosis no se acepta: no es un récipe, es una lista.
    expect(
      createPrescriptionSchema.safeParse({
        ...recetaValida,
        items: [{ medicationName: 'Ibuprofeno', dose: '', frequency: 'cada 8 horas' }],
      }).success,
    ).toBe(false);
  });

  it('el nombre del medicamento es obligatorio y la vía viene del catálogo', () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...recetaValida,
        items: [{ medicationName: 'A', dose: '1', frequency: 'cada 8 horas' }],
      }).success,
    ).toBe(false);

    const inventada = createPrescriptionSchema.safeParse({
      ...recetaValida,
      items: [
        {
          medicationName: 'Amoxicilina',
          dose: '500 mg',
          frequency: 'cada 8 horas',
          route: 'nasal',
        },
      ],
    });
    expect(inventada.success).toBe(false);
  });

  it('el borrador se distingue del documento emitido', () => {
    expect(prescriptionIsDraft('borrador')).toBe(true);
    expect(prescriptionIsDraft('emitida')).toBe(false);
    expect(prescriptionIsDraft('anulada')).toBe(false);
    expect(prescriptionStatusLabel('emitida')).toBe('Emitida');
    expect(prescriptionStatusLabel('anulada')).toBe('Anulada');
  });

  it('anular exige el motivo', () => {
    expect(annulPrescriptionSchema.safeParse({ reason: 'no' }).success).toBe(false);
    expect(annulPrescriptionSchema.parse({ reason: 'dosis equivocada' }).reason).toBe(
      'dosis equivocada',
    );
  });
});

describe('la verificación pública', () => {
  const valida = {
    valid: true as const,
    code: 'ABCDE-FGHJK',
    clinicName: 'Consultorio Sonrisa',
    issuedAt: '2026-10-04T14:30:00.000Z',
    dentistName: 'Od. José Pérez',
    dentistMpps: 'MPPS 12345',
    patientReference: 'María P.',
    status: 'emitida' as const,
    itemCount: 2,
  };

  it('la respuesta válida distingue «no consta» de un error', () => {
    const resultado = prescriptionVerificationResultSchema.parse(valida);
    expect(resultado.valid).toBe(true);

    const ausente = prescriptionVerificationResultSchema.parse({
      valid: false,
      code: 'ZZZZZ-ZZZZZ',
    });
    expect(ausente.valid).toBe(false);
  });

  it('lo que se publica NO lleva datos clínicos', () => {
    // El esquema es la última barrera: si alguien añadiera el diagnóstico o los
    // medicamentos, esta prueba lo diría.
    const campos = Object.keys(prescriptionVerificationSchema.shape).sort();
    expect(campos).toEqual([
      'clinicName',
      'code',
      'dentistMpps',
      'dentistName',
      'issuedAt',
      'itemCount',
      'patientReference',
      'status',
      'valid',
    ]);
  });
});

describe('catálogo y adjuntos', () => {
  it('el medicamento del catálogo llega con sus presentaciones y vías', () => {
    const medicamento = medicationSchema.parse({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Ibuprofeno',
      presentations: ['Tabletas 400 mg'],
      routes: ['oral'],
      usualDose: '400 mg',
      usualFrequency: 'cada 8 horas',
      usualDuration: '5 días',
      indications: 'Dolor e inflamación',
      isActive: true,
    });
    expect(medicationRouteLabel(medicamento.routes[0] ?? null)).toBe('Vía oral');
    expect(medicationRouteLabel(null)).toBeNull();
  });

  it('el adjunto guarda su tipo, su pieza y su pie de foto', () => {
    const adjunto = clinicalAttachmentSchema.parse({
      id: '33333333-3333-4333-8333-333333333333',
      sessionId: '11111111-1111-4111-8111-111111111111',
      patientId: '44444444-4444-4444-8444-444444444444',
      kind: 'radiografia',
      originalName: 'periapical-36.png',
      mime: 'image/png',
      size: 1024,
      sha256: 'a'.repeat(64),
      caption: 'Periapical de la 36',
      toothNumber: 36,
      uploadedByUsername: 'prueba',
      createdAt: '2026-10-04T14:30:00.000Z',
    });
    expect(clinicalAttachmentKindLabel(adjunto.kind)).toBe('Radiografía');
    expect(clinicalAttachmentKindLabel('foto_clinica')).toBe('Foto clínica');
  });
});
