import {
  clinicalSessionContentSchema,
  formatPrescriptionNumber,
  formatSessionNumber,
  type ClinicalSessionContent,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { dossierHtml, type DossierDocumentInput } from './dossier-document.js';

/**
 * El dossier es lo que se le entrega a un especialista o al paciente que pide su
 * historial, así que lo que hay que fijar aquí es **qué lleva y qué no**: que reúna
 * las cuatro piezas (filiación, odontograma, evolución y farmacia), que las alertas
 * clínicas se vean, y que **escape** lo que viene de los datos —hay nombres de
 * paciente y de medicamento—, porque es HTML que se le pasa a Chromium.
 */

const contenido = (input: Partial<ClinicalSessionContent> = {}): ClinicalSessionContent =>
  clinicalSessionContentSchema.parse(input);

const base = (): DossierDocumentInput => ({
  number: 'EXP-000003',
  issuedAt: new Date('2026-10-07T13:00:00Z'),
  patient: {
    id: '11111111-1111-4111-8111-111111111111',
    fullName: 'María Pérez Gómez',
    document: 'V-12345678',
    birthDate: '1988-04-12',
    age: 38,
    sex: 'F',
    phone: '0414-1234567',
    address: 'Av. Principal, Casa 4',
    occupation: 'Docente',
  },
  alerts: [{ code: 'alergia_penicilina', detail: null }],
  odontogram: {
    dentition: 'permanente',
    findings: {
      '26': [
        {
          id: 'f1',
          toothNumber: 26,
          surface: 'occlusal',
          condition: 'caries',
          state: 'pendiente',
          notes: null,
          recordedByUsername: 'egomez',
          recordedAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          sessionId: null,
          resolvedAt: null,
        },
        {
          id: 'f2',
          toothNumber: 26,
          surface: null,
          condition: 'endodoncia',
          state: 'completado',
          notes: null,
          recordedByUsername: 'egomez',
          recordedAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-01T10:00:00.000Z',
          sessionId: null,
          resolvedAt: null,
        },
      ],
    },
  },
  sessions: [
    {
      sessionNumber: 1,
      closedAt: '2026-10-01T15:00:00.000Z',
      content: contenido({
        motivo: 'Dolor en la 26',
        procedimientos: [
          {
            code: 'endodoncia_multirradicular',
            detalle: null,
            toothNumber: 26,
            surfaces: [],
            notas: null,
          },
        ],
        diagnostico: 'Pulpitis irreversible',
      }),
    },
  ],
  prescriptions: [
    {
      summary: {
        id: 'p1',
        number: formatPrescriptionNumber(7),
        prescriptionNumber: 7,
        sessionId: 's1',
        patientId: '11111111-1111-4111-8111-111111111111',
        status: 'emitida',
        issuedAt: '2026-10-01T15:05:00.000Z',
        issuedByUsername: 'egomez',
        itemCount: 1,
        verifyCode: 'ABCDE-FGHJK',
        hasPdf: true,
        printCount: 0,
        lastPrintedAt: null,
        annulledAt: null,
        annulReason: null,
        createdAt: '2026-10-01T15:05:00.000Z',
        updatedAt: '2026-10-01T15:05:00.000Z',
      },
      medications: ['Amoxicilina'],
    },
  ],
  dentist: {
    username: 'egomez',
    fullName: 'Od. Erika Gómez',
    mpps: 'MPPS 12345',
    specialty: 'Odontología general',
    licenseNumber: null,
    email: null,
  },
  verificationUrl: 'http://127.0.0.1:5173/verificar-expediente/ABCDE-FGHJK',
  logoPath: null,
});

describe('el dossier del expediente', () => {
  it('reúne las cuatro secciones con el correlativo y la fecha del consultorio', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain('EXP-000003');
    expect(html).toContain('07/10/2026 09:00');
    expect(html).toContain('Filiación y alertas');
    expect(html).toContain('Odontograma diagnóstico');
    expect(html).toContain('Evolución cronológica');
    expect(html).toContain('Historial farmacológico');
  });

  it('lleva los datos del paciente y su edad', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain('María Pérez Gómez');
    expect(html).toContain('V-12345678');
    expect(html).toContain('12/04/1988');
    expect(html).toContain('38 años');
  });

  it('las alertas clínicas salen destacadas y en su idioma', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain('Alertas clínicas');
    expect(html).toContain('Alergia a la penicilina');
  });

  it('sin alertas lo dice, en vez de dejar la sección vacía', async () => {
    const html = await dossierHtml({ ...base(), alerts: [] });
    expect(html).toContain('Sin alergias ni antecedentes de riesgo');
    expect(html).not.toContain('Alertas clínicas');
  });

  it('la evolución trae el número de sesión, los procedimientos y el diagnóstico', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain(formatSessionNumber(1));
    expect(html).toContain('Pulpitis irreversible');
    expect(html).toContain('Endodoncia multirradicular');
  });

  it('la farmacia trae el récipe, sus medicamentos y su código de verificación', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain('RX-000007');
    expect(html).toContain('Amoxicilina');
    expect(html).toContain('ABCDE-FGHJK');
  });

  it('el odontograma se dibuja en SVG y la tabla de hallazgos nombra la condición', async () => {
    const html = await dossierHtml(base());
    // Las dos arcadas, con las piezas y sus números.
    expect(html).toContain('Arcada superior');
    expect(html).toContain('Arcada inferior');
    expect(html).toContain('>26</text>');
    // La caries tiene cara (oclusal) y la endodoncia es de pieza completa.
    expect(html).toContain('Oclusal');
    expect(html).toContain('Pieza completa');
    expect(html).toContain('Caries');
    expect(html).toContain('Endodoncia');
  });

  it('sin odontograma el hueco se explica y no se dibuja nada', async () => {
    const html = await dossierHtml({
      ...base(),
      odontogram: { dentition: null, findings: {} },
    });
    expect(html).toContain('todavía no tiene odontograma');
    expect(html).not.toContain('<svg viewBox');
  });

  it('la dentición mixta dibuja también las bandas temporales', async () => {
    const html = await dossierHtml({
      ...base(),
      odontogram: { dentition: 'mixta', findings: base().odontogram.findings },
    });
    expect(html).toContain('Dentición mixta');
    expect(html).toContain('Dentición temporal · arcada superior');
  });

  it('escapa lo que viene de los datos (nombres que podrían traer HTML)', async () => {
    const html = await dossierHtml({
      ...base(),
      patient: { ...base().patient!, fullName: 'Ana <script>alert(1)</script>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('el sello lleva el QR de verificación y el profesional que responde', async () => {
    const html = await dossierHtml(base());
    expect(html).toContain('<svg');
    expect(html).toContain('Od. Erika Gómez');
    expect(html).toContain('MPPS 12345');
  });

  it('el pie de página folia las hojas y repite el correlativo', async () => {
    const html = await dossierHtml(base());
    void html;
    const { dossierFooterTemplate } = await import('./dossier-document.js');
    const pie = dossierFooterTemplate('EXP-000003');
    expect(pie).toContain('pageNumber');
    expect(pie).toContain('totalPages');
    expect(pie).toContain('EXP-000003');
  });
});
