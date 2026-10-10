import { describe, expect, it } from 'vitest';

import {
  emptyFormValues,
  patientFormSchema,
  representanteVacio,
  type PatientFormValues,
} from './patients';

/**
 * Reglas del formulario de paciente que no deben depender de la interfaz: el
 * **representante** es obligatorio solo para menores y el documento se valida aquí
 * para no perder lo tecleado.
 */

const base = (overrides: Partial<PatientFormValues> = {}): PatientFormValues => ({
  ...emptyFormValues('V', '12345678', 'Juan Pérez'),
  birthDate: '1985-07-20',
  sex: 'M',
  phone: '0412-1234567',
  ...overrides,
});

describe('patientFormSchema — representante del menor', () => {
  it('un adulto sin representante es válido', () => {
    const resultado = patientFormSchema.safeParse(base());
    expect(resultado.success).toBe(true);
  });

  it('un adulto con representante vacío sigue siendo válido (campo opcional)', () => {
    const resultado = patientFormSchema.safeParse(base({ guardian: undefined }));
    expect(resultado.success).toBe(true);
  });

  it('un menor sin representante falla y el error apunta al nombre', () => {
    const resultado = patientFormSchema.safeParse(base({ birthDate: '2015-07-20' }));
    expect(resultado.success).toBe(false);
    if (resultado.success) return;
    const rutas = resultado.error.issues.map((issue) => issue.path.join('.'));
    expect(rutas).toContain('guardian.fullName');
  });

  it('un menor con representante completo es válido', () => {
    const resultado = patientFormSchema.safeParse(
      base({
        birthDate: '2015-07-20',
        guardian: {
          fullName: 'María Pérez',
          docType: 'V',
          docNumber: '87654321',
          relationship: 'Madre',
          phone: '0414-7654321',
        },
      }),
    );
    expect(resultado.success).toBe(true);
  });

  it('una fecha vacía o inválida NO pide representante', () => {
    // Un `Date` inválido da 0 años y `isMinor` lo leería como recién nacido.
    for (const birthDate of ['', 'hoy', 'no-es-fecha']) {
      const resultado = patientFormSchema.safeParse(base({ birthDate }));
      expect(resultado.success).toBe(false);
      if (resultado.success) continue;
      const rutas = resultado.error.issues.map((issue) => issue.path.join('.'));
      expect(rutas).toContain('birthDate');
      expect(rutas).not.toContain('guardian.fullName');
    }
  });

  it('un adulto con otro campo pendiente no pide representante', () => {
    const resultado = patientFormSchema.safeParse(base({ sex: '' }));
    expect(resultado.success).toBe(false);
    if (resultado.success) return;
    const rutas = resultado.error.issues.map((issue) => issue.path.join('.'));
    expect(rutas).toContain('sex');
    expect(rutas).not.toContain('guardian.fullName');
  });
});

describe('representanteVacio', () => {
  it('sin representante, o con todos los campos en blanco, está vacío', () => {
    expect(representanteVacio(undefined)).toBe(true);
    expect(representanteVacio(null)).toBe(true);
    expect(representanteVacio({ fullName: '', relationship: '' })).toBe(true);
    // El tipo de documento por defecto no cuenta como dato.
    expect(
      representanteVacio({ fullName: ' ', docType: 'V', relationship: '', docNumber: '' }),
    ).toBe(true);
  });

  it('basta un dato para que deje de estar vacío', () => {
    expect(representanteVacio({ fullName: 'María Pérez', relationship: '' })).toBe(false);
    expect(representanteVacio({ fullName: '', relationship: 'Madre' })).toBe(false);
    expect(representanteVacio({ fullName: '', relationship: '', phone: '0414-0000000' })).toBe(
      false,
    );
  });
});
