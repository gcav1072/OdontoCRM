import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CLINIC,
  clinicContactLine,
  clinicFullAddress,
  type ClinicDentist,
} from '@odontocrm/contracts';

import { qrSvg } from './qr.js';

/**
 * El HTML del **récipe A5** ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)).
 *
 * Es una plantilla de una sola pieza: el membrete sale de la **sección editable del
 * consultorio** (`packages/contracts/src/clinic.ts`) y lo que esté en `null`
 * simplemente no se imprime. El documento no lleva diagnóstico ni historia clínica:
 * un récipe dice qué tomar, no qué tiene el paciente.
 *
 * Se renderiza con Chromium (`renderPrescriptionPdf`) usando `@page { size: A5 }`.
 */

export interface PrescriptionDocumentItem {
  medicationName: string;
  presentation: string | null;
  route: string | null;
  dose: string;
  frequency: string;
  duration: string | null;
  instructions: string | null;
  quantity: string | null;
}

export interface PrescriptionDocumentInput {
  number: string;
  issuedAt: Date;
  patientName: string;
  patientDocument: string;
  patientBirthDate: string | null;
  /** `M` / `F` / `O` (o `null`): decide la concordancia de «nacido / nacida». */
  patientSex: string | null;
  patientAge: number | null;
  dentist: ClinicDentist | null;
  items: readonly PrescriptionDocumentItem[];
  generalInstructions: string | null;
  /** URL que abre el QR; si falta, el récipe sale sin QR (no se inventa). */
  verificationUrl: string | null;
  /** Ruta del logo relativa a la raíz del repositorio. */
  logoPath: string | null;
}

/** Fecha como se lee en el papel: `1988-04-12` → `12/04/1988`. */
const shortDate = (value: string): string => {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return partes === null ? value : `${partes[3] ?? ''}/${partes[2] ?? ''}/${partes[1] ?? ''}`;
};

/**
 * Línea del nacimiento: «nacida el 12/04/1988».
 *
 * El sexo del paciente decide la concordancia. El récipe lo firma una persona real y
 * lo lee el paciente: decirle «nacido» a una paciente es un error que se ve en el
 * papel. Si el sexo no consta (o es «otro»), se usa la forma que sirve para
 * cualquiera —«nació el …»— en vez de suponer.
 */
export const birthLine = (birthDate: string | null, sex: string | null): string | null => {
  if (birthDate === null || birthDate.trim() === '') return null;
  const fecha = `el ${shortDate(birthDate)}`;
  if (sex === 'F') return `nacida ${fecha}`;
  if (sex === 'M') return `nacido ${fecha}`;
  return `nació ${fecha}`;
};

/** Escapa el texto que va al HTML: el nombre del paciente lo escribe una persona. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Fecha larga en la zona del consultorio: «04 de octubre de 2026». */
const longDate = (value: Date): string =>
  new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Caracas',
  }).format(value);

/** El logo se incrusta como data URI: el PDF no depende de rutas al abrirse. */
const logoDataUri = async (logoPath: string | null): Promise<string | null> => {
  if (logoPath === null) return null;
  try {
    const data = await readFile(resolve(logoPath));
    const extension =
      logoPath.toLowerCase().endsWith('.jpg') || logoPath.toLowerCase().endsWith('.jpeg')
        ? 'jpeg'
        : 'png';
    return `data:image/${extension};base64,${data.toString('base64')}`;
  } catch {
    // Sin archivo no hay logo: el membrete sale igual (y `letterheadMissingFields` avisa).
    return null;
  }
};

const styles = `
  @page { size: A5; margin: 8mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #17202a; margin: 0; }
  .letterhead { display: flex; align-items: flex-start; gap: 6mm; border-bottom: 0.6mm solid #1f6f6b; padding-bottom: 3mm; }
  .logo { height: 18mm; width: auto; }
  .letterhead-text { flex: 1; }
  .clinic-name { font-size: 13pt; font-weight: 700; color: #14504d; margin: 0; }
  .clinic-line { font-size: 8pt; color: #4a5560; margin: 0.6mm 0 0; }
  .rx { display: flex; justify-content: space-between; align-items: baseline; margin-top: 3mm; }
  .rx-title { font-size: 12pt; font-weight: 700; letter-spacing: 0.4mm; margin: 0; }
  .rx-number { font-size: 9pt; color: #4a5560; }
  .patient { margin-top: 2mm; font-size: 9pt; }
  .patient strong { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; font-size: 9pt; }
  th { text-align: left; background: #eef5f4; color: #14504d; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.2mm; padding: 1.6mm 2mm; border-bottom: 0.3mm solid #cfdedd; }
  td { padding: 1.8mm 2mm; border-bottom: 0.2mm solid #e3e9ea; vertical-align: top; }
  .med { font-weight: 600; }
  .detail { color: #46535f; font-size: 8pt; }
  .instructions { margin-top: 3mm; font-size: 8.5pt; }
  .instructions h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.2mm; color: #14504d; margin: 0 0 1mm; }
  .footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 6mm; margin-top: 10mm; }
  .signature { text-align: center; font-size: 8.5pt; min-width: 62mm; }
  .signature-line { border-top: 0.3mm solid #17202a; margin-bottom: 1.5mm; }
  .signature-name { font-weight: 600; }
  .signature-detail { font-size: 7.5pt; color: #4a5560; }
  .verify { text-align: center; font-size: 6.5pt; color: #4a5560; }
  .verify svg { width: 22mm; height: 22mm; display: block; margin: 0 auto 1mm; }
  .verify code { font-size: 7pt; letter-spacing: 0.3mm; }
  .note { margin-top: 2mm; font-size: 7pt; color: #6b7680; }
`;

/**
 * HTML completo del récipe. Se devuelve como cadena (no se escribe en disco): el
 * navegador lo recibe con `page.setContent` y de ahí sale el PDF.
 */
export const prescriptionHtml = async (input: PrescriptionDocumentInput): Promise<string> => {
  const logo = await logoDataUri(input.logoPath);
  const telefono = clinicContactLine(CLINIC);

  const lineasMembrete = [
    clinicFullAddress(CLINIC),
    CLINIC.rif === null ? null : `RIF ${CLINIC.rif}`,
    telefono === '' ? null : telefono,
    CLINIC.website,
  ]
    .filter((line): line is string => line !== null && line.trim() !== '')
    .map((line) => `<p class="clinic-line">${escapeHtml(line)}</p>`)
    .join('');

  const paciente = [
    input.patientAge === null ? null : `${String(input.patientAge)} años`,
    birthLine(input.patientBirthDate, input.patientSex),
  ]
    .filter((line): line is string => line !== null)
    .join(' · ');

  const filas = input.items
    .map((item) => {
      const detalles = [
        item.presentation,
        item.route,
        item.duration === null ? null : `por ${item.duration}`,
        item.quantity === null ? null : `cantidad: ${item.quantity}`,
        item.instructions,
      ]
        .filter((line): line is string => line !== null && line.trim() !== '')
        .map(escapeHtml)
        .join(' · ');

      return `
        <tr>
          <td>
            <span class="med">${escapeHtml(item.medicationName)}</span>
            ${detalles === '' ? '' : `<div class="detail">${detalles}</div>`}
          </td>
          <td>${escapeHtml(item.dose)}</td>
          <td>${escapeHtml(item.frequency)}</td>
        </tr>`;
    })
    .join('');

  const odontologo = input.dentist;
  const firmaDetalle = [
    odontologo?.mpps === null || odontologo?.mpps === undefined ? null : odontologo.mpps,
    odontologo?.specialty ?? null,
    odontologo?.licenseNumber ?? null,
  ]
    .filter((line): line is string => line !== null && line.trim() !== '')
    .map(escapeHtml)
    .join(' · ');

  const verificacion =
    input.verificationUrl === null
      ? ''
      : `<div class="verify">
           ${qrSvg(input.verificationUrl)}
           <code>${escapeHtml(input.number)}</code>
           <div>Verifica este récipe en la web del consultorio</div>
         </div>`;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Récipe ${escapeHtml(input.number)}</title><style>${styles}</style></head>
<body>
  <header class="letterhead">
    ${logo === null ? '' : `<img class="logo" src="${logo}" alt="Logo del consultorio">`}
    <div class="letterhead-text">
      <p class="clinic-name">${escapeHtml(CLINIC.name)}</p>
      ${CLINIC.legalName === null ? '' : `<p class="clinic-line">${escapeHtml(CLINIC.legalName)}</p>`}
      ${lineasMembrete}
    </div>
  </header>

  <section class="rx">
    <h1 class="rx-title">RÉCIPE</h1>
    <span class="rx-number">N.º ${escapeHtml(input.number)} · ${escapeHtml(longDate(input.issuedAt))}</span>
  </section>

  <p class="patient">
    <strong>Paciente:</strong> ${escapeHtml(input.patientName)} ·
    <strong>Documento:</strong> ${escapeHtml(input.patientDocument)}${paciente === '' ? '' : ` · ${escapeHtml(paciente)}`}
  </p>

  <table>
    <thead>
      <tr><th>Medicamento</th><th>Dosis</th><th>Frecuencia</th></tr>
    </thead>
    <tbody>${filas}</tbody>
  </table>

  ${
    input.generalInstructions === null || input.generalInstructions.trim() === ''
      ? ''
      : `<section class="instructions"><h2>Indicaciones generales</h2>${escapeHtml(input.generalInstructions).replace(/\n/g, '<br>')}</section>`
  }

  <div class="footer">
    <div>${verificacion}</div>
    <div class="signature">
      <div class="signature-line"></div>
      <div class="signature-name">${escapeHtml(odontologo?.fullName ?? '')}</div>
      <div class="signature-detail">${firmaDetalle === '' ? 'Odontólogo' : firmaDetalle}</div>
    </div>
  </div>

  <p class="note">
    Documento emitido por el sistema del consultorio. Conserva este récipe: el código del recuadro
    permite comprobar su autenticidad.
  </p>
</body>
</html>`;
};
