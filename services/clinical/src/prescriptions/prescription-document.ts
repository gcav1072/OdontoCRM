import {
  BRAND,
  CLINIC,
  MEDICATION_ROUTES,
  brandStyles,
  brandWatermarkCss,
  brandWatermarkHtml,
  clinicContactLine,
  clinicDentistLine,
  clinicFullAddress,
  medicationRouteLabel,
  type BrandThemePayload,
  type ClinicDentist,
  type ClinicIdentity,
  type MedicationRoute,
} from '@odontocrm/contracts';
import { brandFontFaceCss, readImageDataUri } from '@odontocrm/kernel';

import { qrSvg } from './qr.js';

/**
 * El HTML del **récipe** ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)).
 *
 * Sale en una **hoja carta apaisada** partida en dos mitades verticales: a la
 * izquierda la **copia de la farmacia** (qué dispensar) y a la derecha la **copia del
 * paciente** (las indicaciones, con el QR). Las dos mitades llevan membrete, la línea
 * del especialista y su firma.
 *
 * Es una plantilla de una sola pieza: el membrete sale de la **sección editable del
 * consultorio** (`packages/contracts/src/clinic.ts`) y lo que esté en `null`
 * simplemente no se imprime. El documento no lleva diagnóstico ni historia clínica:
 * un récipe dice qué tomar, no qué tiene el paciente.
 *
 * Se renderiza con Chromium (`renderPrescriptionPdf`) usando
 * `@page { size: letter landscape }`.
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
  /** Código de verificación con su guion (`ABCDE-FGHJK`), como lo lee quien verifica. */
  verifyCode: string | null;
  /** Ruta del logo relativa a la raíz del repositorio (respaldo si no hay `logoDataUri`). */
  logoPath: string | null;
  /**
   * La identidad del consultorio tal como la leyó el servicio (la de la base o el
   * respaldo del código). Si falta, se usa `CLINIC`.
   */
  clinic?: ClinicIdentity | null;
  /** Logo ya incrustado como `data:` URI; si falta, se lee `logoPath`. */
  logoDataUri?: string | null;
  /**
   * La **marca efectiva** de los imprimibles (ADR 0060). Si falta, se usa `BRAND` (el
   * respaldo del código): los documentos ya emitidos y las pruebas siguen igual.
   */
  brand?: BrandThemePayload | null;
  /** Las `@font-face` ya resueltas por identity (con los `.woff2` incrustados). */
  fontFaceCss?: string | null;
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

/** ¿El valor guardado es una de las vías del catálogo? Protege los récipes ya emitidos. */
const esViaCatalogo = (value: string): value is MedicationRoute =>
  (MEDICATION_ROUTES as readonly string[]).includes(value);

/**
 * La **vía** como se lee en el papel.
 *
 * En la base se guarda el **código** (`oral`, `topica`…), así que el récipe lo traduce
 * con `medicationRouteLabel`. Si viniera un valor que no es del catálogo (un récipe ya
 * emitido con otra forma), se imprime tal cual en vez de rotularlo «Otra vía».
 */
export const routeText = (route: string | null): string | null => {
  const valor = route?.trim() ?? '';
  if (valor === '') return null;
  return esViaCatalogo(valor) ? medicationRouteLabel(valor) : valor;
};

/**
 * La vía para el renglón «Vía: …» de la copia de la farmacia.
 *
 * El rótulo del campo ya dice «Vía», así que se le quita el prefijo al valor para no
 * leer «Vía: Vía oral»: «Vía oral» → «Oral», «Otra vía» → «Otra».
 */
const viaParaCampo = (via: string): string => {
  const sinPrefijo = via.replace(/^vía\s+/i, '');
  return sinPrefijo.charAt(0).toUpperCase() + sinPrefijo.slice(1);
};

/** Fecha larga en la zona del consultorio: «04 de octubre de 2026». */
const longDate = (value: Date): string =>
  new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Caracas',
  }).format(value);

const styles = (fontFaces: string, brand: BrandThemePayload | null | undefined): string => `
  ${fontFaces}
  ${brandStyles(brand ?? BRAND)}
  ${brandWatermarkCss()}
  @page { size: letter landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  /* El cuerpo (fuente y tinta) lo pone brandStyles(), la marca compartida con el
     reporte y el dossier: el membrete del consultorio no sale de dos colores. */
  /* La hoja va **apaisada y partida en dos mitades verticales**: a la izquierda la
     copia de la farmacia, a la derecha la del paciente. La altura es la imprimible de
     una carta apaisada con márgenes de 8 mm (215,9 − 16 ≈ 200 mm); fijarla permite
     anclar la firma abajo en cada mitad (margin-top: auto). */
  .sheet { display: flex; height: 199mm; }
  .half { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .half + .half { border-left: 0.3mm dashed var(--brand-line); padding-left: 6mm; }
  .half:first-child { padding-right: 6mm; }
  .letterhead { display: flex; align-items: flex-start; gap: 4mm; border-bottom: 0.6mm solid var(--brand-accent); padding-bottom: 2.5mm; }
  .logo { height: 12mm; width: auto; }
  .letterhead-text { flex: 1; min-width: 0; }
  .clinic-name { font-family: var(--brand-font-doc-title); font-size: 11pt; font-weight: var(--brand-font-doc-title-weight); color: var(--brand-primary); margin: 0; }
  .clinic-line { font-size: 7.5pt; color: var(--brand-ink-muted); margin: 0.5mm 0 0; }
  /* La línea del especialista va en el membrete, bajo la dirección y el teléfono. */
  .clinic-dentist { font-size: 7.5pt; color: var(--brand-ink-strong); margin: 0.8mm 0 0; }
  .rx { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; margin-top: 3mm; }
  .rx-title { font-family: var(--brand-font-doc-title); font-size: 13pt; font-weight: var(--brand-font-doc-title-weight); letter-spacing: 0.4mm; margin: 0; color: var(--brand-primary); }
  .rx-number { font-size: 8pt; color: var(--brand-ink-muted); text-align: right; }
  .patient { margin-top: 2mm; font-size: 8.5pt; }
  .patient strong { font-weight: 600; }
  /* Copia de la farmacia (izquierda): un bloque por medicamento. */
  .rp-items { margin-top: 3.5mm; }
  .rp-item { margin-top: 3.5mm; }
  .rp-item:first-child { margin-top: 0; }
  .rp-med { font-weight: 700; text-decoration: underline; font-size: 10.5pt; margin: 0 0 1mm; }
  .rp-line { font-size: 9pt; margin: 0.4mm 0 0; }
  .rp-line strong { font-weight: 600; }
  .rp-code { margin-top: 4mm; font-size: 8pt; color: var(--brand-ink-muted); }
  .rp-code code { font-size: 8.5pt; letter-spacing: 0.3mm; color: var(--brand-ink-strong); }
  /* Copia del paciente (derecha): la tabla de siempre. */
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; font-size: 8pt; }
  th { text-align: left; background: var(--brand-table-head-bg); color: var(--brand-primary); font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; padding: 1.4mm 1.6mm; border-bottom: 0.3mm solid var(--brand-line); }
  td { padding: 1.5mm 1.6mm; border-bottom: 0.2mm solid var(--brand-line-soft); vertical-align: top; }
  /* Anchos fijos para que «500 mg» y «cada 8 horas» no se partan en dos renglones. */
  th:nth-child(2), td:nth-child(2) { width: 18mm; }
  th:nth-child(3), td:nth-child(3) { width: 28mm; }
  .med { font-weight: 600; }
  .detail { color: var(--brand-ink-strong); font-size: 7.5pt; }
  .instructions { margin-top: 3mm; font-size: 8pt; }
  .instructions h2 { font-family: var(--brand-font-doc-title); font-size: 8pt; font-weight: var(--brand-font-doc-title-weight); text-transform: uppercase; letter-spacing: 0.2mm; color: var(--brand-primary); margin: 0 0 1mm; }
  /* La firma se ancla al pie de su mitad; el especialista ya va en el membrete, así que
     bajo la línea solo queda el nombre. */
  .signature { text-align: center; font-size: 8.5pt; min-width: 48mm; margin-top: auto; padding-top: 6mm; }
  .signature-line { border-top: 0.3mm solid var(--brand-ink); margin-bottom: 1.2mm; }
  .signature-name { font-weight: 600; }
  .footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 4mm; margin-top: auto; padding-top: 6mm; }
  .footer .signature { margin-top: 0; padding-top: 0; }
  .verify { text-align: center; font-size: 6pt; color: var(--brand-ink-muted); }
  .verify svg { width: 19mm; height: 19mm; display: block; margin: 0 auto 1mm; }
  .verify code { font-size: 6.5pt; letter-spacing: 0.3mm; }
  .note { margin-top: 1.5mm; font-size: 6.5pt; color: var(--brand-ink-subtle); }
`;

/**
 * HTML completo del récipe. Se devuelve como cadena (no se escribe en disco): el
 * navegador lo recibe con `page.setContent` y de ahí sale el PDF.
 */
export const prescriptionHtml = async (input: PrescriptionDocumentInput): Promise<string> => {
  const consultorio = input.clinic ?? CLINIC;
  const logo = input.logoDataUri ?? (await readImageDataUri(input.logoPath));
  // La marca de agua usa el **logo efectivo** (el subido o el del repositorio): si no
  // hay ninguno, `brandWatermarkHtml` devuelve cadena vacía y el récipe sale sin velo.
  const marcaDeAgua = brandWatermarkHtml(logo ?? (await readImageDataUri(BRAND.watermarkPath)));
  const telefono = clinicContactLine(consultorio);
  const odontologo = input.dentist;
  const lineaDentista = clinicDentistLine(odontologo);

  const lineasMembrete = [
    clinicFullAddress(consultorio),
    consultorio.rif === null ? null : `RIF ${consultorio.rif}`,
    telefono === '' ? null : telefono,
    consultorio.website,
  ]
    .filter((line): line is string => line !== null && line.trim() !== '')
    .map((line) => `<p class="clinic-line">${escapeHtml(line)}</p>`)
    .join('');

  // El membrete se repite en cada mitad: cada copia se puede desprender y sigue siendo
  // un documento con su identidad. La línea del especialista va bajo dirección/teléfono.
  const membrete = `
  <header class="letterhead">
    ${logo === null ? '' : `<img class="logo" src="${logo}" alt="Logo del consultorio">`}
    <div class="letterhead-text">
      <p class="clinic-name">${escapeHtml(consultorio.name)}</p>
      ${consultorio.legalName === null ? '' : `<p class="clinic-line">${escapeHtml(consultorio.legalName)}</p>`}
      ${lineasMembrete}
      ${lineaDentista === '' ? '' : `<p class="clinic-dentist">${escapeHtml(lineaDentista)}</p>`}
    </div>
  </header>`;

  const paciente = [
    input.patientAge === null ? null : `${String(input.patientAge)} años`,
    birthLine(input.patientBirthDate, input.patientSex),
  ]
    .filter((line): line is string => line !== null)
    .join(' · ');

  const pacienteLinea = `
  <p class="patient">
    <strong>Paciente:</strong> ${escapeHtml(input.patientName)} ·
    <strong>Documento:</strong> ${escapeHtml(input.patientDocument)}${paciente === '' ? '' : ` · ${escapeHtml(paciente)}`}
  </p>`;

  const numeroFecha = `N.º ${escapeHtml(input.number)} · ${escapeHtml(longDate(input.issuedAt))}`;

  // La firma la comparten las dos mitades: el especialista ya está en el membrete, así
  // que bajo la línea solo va su nombre.
  const firma = `
    <div class="signature">
      <div class="signature-line"></div>
      <div class="signature-name">${escapeHtml(odontologo?.fullName ?? '')}</div>
    </div>`;

  // ── Copia de la farmacia (izquierda): qué dispensar, sin posología ni indicaciones ──
  const itemsFarmacia = input.items
    .map((item) => {
      const via = routeText(item.route);
      const lineas: [string, string][] = [];
      if (item.presentation !== null && item.presentation.trim() !== '') {
        lineas.push(['Presentación', item.presentation]);
      }
      if (via !== null) lineas.push(['Vía', viaParaCampo(via)]);
      lineas.push(['Dosis', item.dose]);
      return `
      <div class="rp-item">
        <p class="rp-med">${escapeHtml(item.medicationName)}</p>
        ${lineas
          .map(
            ([etiqueta, valor]) =>
              `<p class="rp-line"><strong>${etiqueta}:</strong> ${escapeHtml(valor)}</p>`,
          )
          .join('')}
      </div>`;
    })
    .join('');

  const codigo =
    input.verifyCode === null
      ? ''
      : `<p class="rp-code">Código de verificación: <code>${escapeHtml(input.verifyCode)}</code></p>`;

  // ── Copia del paciente (derecha): las indicaciones, con la tabla y el QR de siempre ──
  const filas = input.items
    .map((item) => {
      const detalles = [
        item.presentation,
        routeText(item.route),
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
<head><meta charset="utf-8"><title>Récipe ${escapeHtml(input.number)}</title><style>${styles(input.fontFaceCss ?? (await brandFontFaceCss()), input.brand)}</style></head>
<body>
  ${marcaDeAgua}
  <div class="brand-doc">
  <div class="sheet">

    <section class="half">
      ${membrete}

      <section class="rx">
        <h1 class="rx-title">RÉCIPE</h1>
        <span class="rx-number">${numeroFecha}</span>
      </section>

      ${pacienteLinea}

      <div class="rp-items">${itemsFarmacia}</div>

      ${codigo}

      ${firma}
    </section>

    <section class="half">
      ${membrete}

      <section class="rx">
        <h1 class="rx-title">INDICACIONES</h1>
        <span class="rx-number">${numeroFecha}</span>
      </section>

      ${pacienteLinea}

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
        ${firma}
      </div>

      <p class="note">
        Documento emitido por el sistema del consultorio. Conserva este récipe: el código del recuadro
        permite comprobar su autenticidad.
      </p>
    </section>

  </div>
  </div>
</body>
</html>`;
};
