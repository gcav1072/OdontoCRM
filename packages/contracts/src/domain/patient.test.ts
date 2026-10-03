import { describe, expect, it } from 'vitest';

import {
  ageFromBirthDate,
  changePatientStatusSchema,
  cleanText,
  createPatientSchema,
  documentKey,
  formatDocument,
  isMinor,
  normalizeDocNumber,
  normalizePhone,
  parseDocumentText,
  patientAuditPayloadSchema,
  SENSITIVE_PATIENT_FIELDS,
  updatePatientSchema,
  validateDocument,
} from './patient.js';

describe('normalización del documento', () => {
  it('V-12345678, «v 12.345.678» y «12345678» son el mismo documento', () => {
    const keys = ['V-12345678', 'v 12.345.678', '12345678', ' V.12345678 '].map((value) => {
      const parsed = parseDocumentText(value);
      return documentKey(parsed.type, parsed.number);
    });

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('V:12345678');
  });

  it('un texto con letras pegadas al número no pasa la validación', () => {
    const parsed = parseDocumentText('VE12345678');
    expect(validateDocument(parsed.type, parsed.number).ok).toBe(false);
  });

  it('respeta el tipo cuando se escribe el prefijo', () => {
    expect(parseDocumentText('E-87654321')).toEqual({ type: 'E', number: '87654321' });
    expect(parseDocumentText('p a123456')).toEqual({ type: 'P', number: 'A123456' });
    expect(parseDocumentText('SC-0042')).toEqual({ type: 'SC', number: '0042' });
  });

  it('usa el tipo por defecto cuando no hay prefijo', () => {
    expect(parseDocumentText('12345678', 'E')).toEqual({ type: 'E', number: '12345678' });
  });

  it('normaliza y formatea para mostrar', () => {
    expect(normalizeDocNumber(' 12.345-678 ')).toBe('12345678');
    expect(formatDocument('V', '12.345.678')).toBe('V-12345678');
  });
});

describe('validación del documento', () => {
  it('acepta cédulas de 6 a 8 dígitos (V y E)', () => {
    expect(validateDocument('V', '123456').ok).toBe(true);
    expect(validateDocument('V', '12345678').ok).toBe(true);
    expect(validateDocument('E', '87654321').ok).toBe(true);
  });

  it('rechaza cédulas fuera de rango, con letras o todo ceros', () => {
    expect(validateDocument('V', '12345').ok).toBe(false);
    expect(validateDocument('V', '123456789').ok).toBe(false);
    expect(validateDocument('V', 'V1234567').message).toContain('6 y 8 dígitos');
    expect(validateDocument('V', '00000000').ok).toBe(false);
    expect(validateDocument('V', '').ok).toBe(false);
    expect(validateDocument('E', '12A45678').ok).toBe(false);
  });

  it('acepta pasaportes y códigos de menor sin cédula', () => {
    expect(validateDocument('P', 'A123456').ok).toBe(true);
    expect(validateDocument('P', '12345').ok).toBe(true);
    expect(validateDocument('P', 'AB').ok).toBe(false);
    expect(validateDocument('SC', '0042').ok).toBe(true);
    expect(validateDocument('SC', '12').ok).toBe(false);
  });
});

describe('teléfono de Venezuela', () => {
  it('normaliza los formatos que escribe la gente', () => {
    expect(normalizePhone('0412-1234567')).toBe('+584121234567');
    expect(normalizePhone('+58 412 123 45 67')).toBe('+584121234567');
    expect(normalizePhone('4121234567')).toBe('+584121234567');
    expect(normalizePhone('(0212) 555.12.34')).toBe('+582125551234');
  });

  it('deja vacío lo que no tiene dígitos', () => {
    expect(normalizePhone('sin teléfono')).toBe('');
  });
});

describe('edad y minoría de edad', () => {
  it('calcula los años cumplidos', () => {
    const at = new Date('2026-10-02T12:00:00Z');
    expect(ageFromBirthDate('2020-10-02', at)).toBe(6);
    expect(ageFromBirthDate('2020-10-03', at)).toBe(5);
    expect(ageFromBirthDate('1990-05-15', at)).toBe(36);
    expect(ageFromBirthDate('fecha-mala', at)).toBe(0);
  });

  it('considera menor a quien no ha cumplido 18', () => {
    const at = new Date('2026-10-02T12:00:00Z');
    expect(isMinor('2010-01-01', at)).toBe(true);
    expect(isMinor('2008-10-03', at)).toBe(true);
    expect(isMinor('2008-10-02', at)).toBe(false);
  });
});

describe('texto libre', () => {
  it('colapsa espacios y quita caracteres de control', () => {
    expect(cleanText('  María   Pérez\u0000 ')).toBe('María Pérez');
    expect(cleanText('Juan\nPérez\tGómez')).toBe('Juan Pérez Gómez');
  });

  it('conserva comillas y guiones: son datos, no SQL', () => {
    const name = "Robert'); DROP TABLE patients;--";
    expect(cleanText(name)).toBe(name);
  });
});

describe('alta de paciente', () => {
  const base = {
    docType: 'V',
    docNumber: '12.345.678',
    fullName: '  María   Pérez ',
    birthDate: '1990-05-15',
    sex: 'F',
    phone: '0412-1234567',
  };

  it('normaliza el documento, el nombre y el teléfono', () => {
    const parsed = createPatientSchema.parse(base);
    expect(parsed.docNumber).toBe('12345678');
    expect(parsed.fullName).toBe('María Pérez');
    expect(parsed.phone).toBe('+584121234567');
    expect(parsed.email).toBeNull();
  });

  it('acepta un nombre con apóstrofo y una nota con signos', () => {
    const parsed = createPatientSchema.parse({
      ...base,
      fullName: "O'Brien Fernández",
      notes: "Alergia a penicilina; usar '<' con cuidado",
    });
    expect(parsed.fullName).toBe("O'Brien Fernández");
    expect(parsed.notes).toContain('<');
  });

  it('exige representante para un menor de edad', () => {
    const menor = { ...base, birthDate: '2018-03-01' };
    expect(createPatientSchema.safeParse(menor).success).toBe(false);

    const conRepresentante = createPatientSchema.parse({
      ...menor,
      guardian: { fullName: 'Ana Pérez', relationship: 'Madre', phone: '0414-1112233' },
    });
    expect(conRepresentante.guardian?.fullName).toBe('Ana Pérez');
    expect(conRepresentante.guardian?.phone).toBe('+584141112233');
  });

  it('rechaza documento inválido, fecha futura, sexo desconocido y teléfono corto', () => {
    expect(createPatientSchema.safeParse({ ...base, docNumber: '123' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, birthDate: '2999-01-01' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, birthDate: 'no-es-fecha' }).success).toBe(
      false,
    );
    expect(createPatientSchema.safeParse({ ...base, sex: 'X' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, phone: '123' }).success).toBe(false);
  });

  it('rechaza un correo mal escrito', () => {
    expect(createPatientSchema.safeParse({ ...base, email: 'correo-malo' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...base, email: 'ana@ejemplo.com' }).success).toBe(true);
  });
});

describe('edición de paciente', () => {
  it('exige motivo: sin él no se guarda', () => {
    expect(updatePatientSchema.safeParse({ fullName: 'Otro Nombre' }).success).toBe(false);
    const parsed = updatePatientSchema.parse({
      fullName: 'Otro Nombre',
      reason: 'corrección de dedo',
    });
    expect(parsed.reason).toBe('corrección de dedo');
  });

  it('el cambio de estado también exige motivo', () => {
    expect(changePatientStatusSchema.safeParse({ status: 'inactivo' }).success).toBe(false);
    expect(
      changePatientStatusSchema.safeParse({ status: 'inactivo', reason: 'se mudó de ciudad' })
        .success,
    ).toBe(true);
  });
});

describe('carga de auditoría del paciente', () => {
  it('valida la carga que viaja por el outbox', () => {
    const payload = patientAuditPayloadSchema.parse({
      patientId: globalThis.crypto.randomUUID(),
      document: 'V-12345678',
      fullName: 'María Pérez',
      action: 'updated',
      changedFields: ['phone'],
      before: { phone: '+584121234567' },
      after: { phone: '+584141112233' },
      reason: 'cambió de número',
      actorId: null,
      actorUsername: 'recepcion',
      ip: '127.0.0.1',
      userAgent: 'vitest',
      requestId: 'req-1',
    });

    expect(payload.changedFields).toContain('phone');
    expect(SENSITIVE_PATIENT_FIELDS).toContain('fullName');
    expect(SENSITIVE_PATIENT_FIELDS).toContain('birthDate');
  });
});
