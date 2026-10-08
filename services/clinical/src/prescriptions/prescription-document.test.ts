import { describe, expect, it } from 'vitest';

import {
  birthLine,
  prescriptionHtml,
  type PrescriptionDocumentInput,
} from './prescription-document.js';
import { qrSvg } from './qr.js';

/**
 * El texto del récipe, comprobado donde se lee: la línea del paciente.
 *
 * El documento lo firma una persona real y lo lee el paciente; decirle «nacido» a una
 * paciente es un error que se ve en el papel (pasó: «María … nacido el 1988-04-12»).
 */

const base: PrescriptionDocumentInput = {
  number: 'RX-000007',
  issuedAt: new Date('2026-10-04T14:30:00Z'),
  patientName: 'María Pérez Gómez',
  patientDocument: 'V-12345678',
  patientBirthDate: '1988-04-12',
  patientSex: 'F',
  patientAge: 38,
  dentist: {
    username: 'egomez',
    fullName: 'Od. Erika Gómez',
    mpps: 'MPPS 12345',
    specialty: 'Odontología general',
    licenseNumber: null,
    email: null,
  },
  items: [
    {
      medicationName: 'Amoxicilina',
      presentation: 'Tabletas 500 mg',
      route: 'Vía oral',
      dose: '500 mg',
      frequency: 'cada 8 horas',
      duration: '7 días',
      instructions: 'Después de las comidas',
      quantity: '21 tabletas',
    },
  ],
  generalInstructions: 'Volver si el dolor no cede en 48 horas.',
  verificationUrl: 'http://127.0.0.1:5173/verificar/ABCDE-FGHJK',
  logoPath: null,
};

describe('la línea del paciente', () => {
  it('una paciente dice «nacida»', () => {
    expect(birthLine('1988-04-12', 'F')).toBe('nacida el 12/04/1988');
  });

  it('un paciente dice «nacido»', () => {
    expect(birthLine('1988-04-12', 'M')).toBe('nacido el 12/04/1988');
  });

  it('sin sexo (o «otro») se usa la forma que sirve para cualquiera', () => {
    expect(birthLine('1988-04-12', null)).toBe('nació el 12/04/1988');
    expect(birthLine('1988-04-12', 'O')).toBe('nació el 12/04/1988');
    expect(birthLine('1988-04-12', '')).toBe('nació el 12/04/1988');
  });

  it('sin fecha de nacimiento no se imprime la línea', () => {
    expect(birthLine(null, 'F')).toBeNull();
    expect(birthLine('  ', 'F')).toBeNull();
  });

  it('una fecha que no viene en ISO se imprime tal cual, sin inventar', () => {
    expect(birthLine('12/04/1988', 'F')).toBe('nacida el 12/04/1988');
    expect(birthLine('abril de 1988', 'M')).toBe('nacido el abril de 1988');
  });
});

describe('el récipe impreso', () => {
  it('lleva la marca de agua del consultorio, con el contenido por encima', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('class="brand-watermark"');
    expect(html).toContain('class="brand-doc"');
  });
  it('la paciente sale con su edad y su nacimiento concordados', async () => {
    const html = await prescriptionHtml(base);
    expect(html).toContain('Paciente:');
    expect(html).toContain('María Pérez Gómez');
    expect(html).toContain('38 años');
    expect(html).toContain('nacida el 12/04/1988');
    expect(html).not.toContain('nacido el');
  });

  it('el paciente hombre sale concordado al revés', async () => {
    const html = await prescriptionHtml({ ...base, patientName: 'José Pérez', patientSex: 'M' });
    expect(html).toContain('nacido el 12/04/1988');
    expect(html).not.toContain('nacida el');
  });

  it('sin sexo conocido el papel no supone nada', async () => {
    const html = await prescriptionHtml({ ...base, patientSex: null });
    expect(html).toContain('nació el 12/04/1988');
    expect(html).not.toContain('nacido');
    expect(html).not.toContain('nacida');
  });

  it('el récipe no lleva diagnóstico ni datos clínicos de más', async () => {
    const html = await prescriptionHtml(base);
    // Lo que sí lleva: medicamento, dosis, frecuencia, indicaciones y la firma.
    expect(html).toContain('Amoxicilina');
    expect(html).toContain('500 mg');
    expect(html).toContain('cada 8 horas');
    expect(html).toContain('Od. Erika Gómez');
    expect(html).toContain('MPPS 12345');
    expect(html).toContain('RX-000007');
    // El QR lleva dentro el enlace de verificación: se compara con el que genera
    // el propio módulo del QR (el enlace no se imprime como texto a propósito: lo
    // lee el teléfono, y quien no tenga teléfono usa el número de arriba).
    expect(html).toContain(qrSvg('http://127.0.0.1:5173/verificar/ABCDE-FGHJK'));
  });
});
