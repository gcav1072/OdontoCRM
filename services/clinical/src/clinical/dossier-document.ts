import {
  BRAND,
  CLINICAL_ALERT_LABELS,
  CLINICAL_STATE_LABELS,
  CLINIC,
  CONDITION_LABELS,
  brandStyles,
  brandWatermarkCss,
  brandWatermarkHtml,
  clinicContactLine,
  clinicFullAddress,
  formatSessionNumber,
  sessionProcedureText,
  surfaceLabelFor,
  type ClinicalAlert,
  type ClinicalPatientSnapshot,
  type ClinicalSessionContent,
  type ClinicDentist,
  type ClinicIdentity,
  type Dentition,
  type PrescriptionSummary,
  type ToothFindingRecord,
} from '@odontocrm/contracts';
import { brandFontFaceCss, readImageDataUri } from '@odontocrm/kernel';

import { odontogramSection } from './dossier-odontogram.js';
import { qrSvg } from '../prescriptions/qr.js';

/**
 * El **dossier del expediente**: un PDF A4 foliado con la filiación del paciente, sus
 * alertas clínicas, el odontograma, la evolución de todas sus sesiones y su historial
 * farmacológico. Es lo que se entrega cuando el paciente pide su historial o cuando se
 * remite a un especialista: hasta ahora había que imprimir cada pieza por separado.
 *
 * La plantilla sale del **mismo membrete y la misma marca** que el récipe y el reporte
 * (`brandStyles()`), y el odontograma lo dibuja `odontogramSection` con la geometría
 * compartida. Lo que se compone al final —el HTML— se le pasa a Chromium, que es quien
 * folia las páginas (el folio no se puede escribir con CSS: Chromium no soporta
 * `counter(page)` en los márgenes de `@page`).
 */

export interface DossierDocumentInput {
  /** Correlativo formateado (`EXP-000001`). */
  number: string;
  issuedAt: Date;
  patient: ClinicalPatientSnapshot | null;
  /** Alertas derivadas de la anamnesis (alergias, crónicos, anticoagulantes). */
  alerts: readonly ClinicalAlert[];
  odontogram: {
    dentition: Dentition | null;
    findings: Record<string, readonly ToothFindingRecord[]>;
  };
  /** Sesiones **cerradas**, de la más antigua a la más reciente (la evolución). */
  sessions: readonly DossierSessionEntry[];
  /** Récipes emitidos, del más reciente al más antiguo. */
  prescriptions: readonly DossierPrescriptionEntry[];
  dentist: ClinicDentist | null;
  /** URL que abre el QR de verificación; si falta, el dossier sale sin QR. */
  verificationUrl: string | null;
  /** Ruta del logo relativa a la raíz del repositorio (respaldo si no hay `logoDataUri`). */
  logoPath: string | null;
  /** La identidad del consultorio leída por el servicio; si falta, se usa `CLINIC`. */
  clinic?: ClinicIdentity | null;
  /** Logo ya incrustado como `data:` URI; si falta, se lee `logoPath`. */
  logoDataUri?: string | null;
}

export interface DossierSessionEntry {
  sessionNumber: number;
  closedAt: string | null;
  content: ClinicalSessionContent;
}

export interface DossierPrescriptionEntry {
  summary: PrescriptionSummary;
  /** Nombres de los medicamentos, en el orden del récipe. */
  medications: readonly string[];
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** `aaaa-mm-dd` (o ISO) → `dd/mm/aaaa`, sin pasar por `Date` (se correría un día). */
const shortDate = (value: string): string => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return iso === null ? value : `${iso[3] ?? ''}/${iso[2] ?? ''}/${iso[1] ?? ''}`;
};

/** Fecha y hora del consultorio: «07/10/2026 09:31». */
const dateTime = (value: Date | string): string => {
  const partes = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value);
  const val = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${val('day')}/${val('month')}/${val('year')} ${val('hour')}:${val('minute')}`;
};

const estilos = (fontFaces: string): string => `
  ${fontFaces}
  ${brandStyles()}
  ${brandWatermarkCss()}
  @page { size: A4; }
  * { box-sizing: border-box; }
  /* Los márgenes del papel los fija el PDF (page.pdf → marginMm): tienen que dejar
     sitio al folio, y el folio solo lo dibuja Chromium (displayHeaderFooter). */
  .letterhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; border-bottom: 0.6mm solid var(--brand-accent); padding-bottom: 3mm; }
  .letterhead-brand { display: flex; align-items: flex-start; gap: 6mm; }
  .logo { height: var(--brand-logo-height-mm); width: auto; }
  .clinic-name { font-family: var(--brand-font-doc-title); font-size: 14pt; font-weight: 700; color: var(--brand-primary); margin: 0; }
  .clinic-line { font-size: 8pt; color: var(--brand-ink-muted); margin: 0.6mm 0 0; }
  .doc-meta { text-align: right; font-size: 8pt; color: var(--brand-ink-muted); min-width: 55mm; }
  .doc-number { font-family: var(--brand-font-doc-title); font-size: 12pt; font-weight: 700; color: var(--brand-primary); margin: 0; }
  h1 { font-family: var(--brand-font-doc-title); font-size: 13pt; margin: 4mm 0 0; color: var(--brand-primary); }
  .subtitle { font-size: 8.5pt; color: var(--brand-ink-muted); margin: 1mm 0 0; }
  h2 { font-family: var(--brand-font-doc-title); font-size: 10pt; color: var(--brand-primary); margin: 5mm 0 1.5mm; border-bottom: 0.2mm solid var(--brand-line); padding-bottom: 0.8mm; }
  .filiacion { display: flex; flex-wrap: wrap; gap: 1mm 8mm; font-size: 8.5pt; margin-top: 2mm; }
  .filiacion dt { color: var(--brand-ink-muted); font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; margin: 0; }
  .filiacion dd { margin: 0.3mm 0 1mm; font-weight: 600; }
  .alertas { margin-top: 2mm; padding: 2mm 3mm; border: 0.3mm solid var(--brand-bad); border-radius: 1.5mm; }
  .alertas h3 { margin: 0 0 1mm; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.2mm; color: var(--brand-bad); }
  .alertas ul { margin: 0; padding-left: 4mm; font-size: 8.5pt; }
  .sin-alertas { font-size: 8pt; color: var(--brand-ink-subtle); margin-top: 2mm; }
  .odo-denticion { font-size: 8pt; color: var(--brand-ink-muted); margin: 2mm 0 1mm; }
  .arch { margin: 0 0 2mm; }
  .arch figcaption { font-size: 7pt; color: var(--brand-ink-subtle); margin-bottom: 0.5mm; }
  .arch svg { width: 100%; height: auto; }
  .odo-legend { display: flex; flex-wrap: wrap; gap: 1mm 5mm; list-style: none; margin: 1mm 0 0; padding: 0; font-size: 7.5pt; color: var(--brand-ink-muted); }
  .odo-legend li { display: flex; align-items: center; gap: 1.2mm; }
  .swatch { display: inline-block; width: 3mm; height: 3mm; border-radius: 0.6mm; border: 0.2mm solid var(--brand-line); }
  .swatch.empty { background: transparent; }
  .odo-simbolo { width: 3.4mm; height: 3.4mm; }
  .vacio { font-size: 8.5pt; color: var(--brand-ink-subtle); }
  .hallazgos { margin-top: 2mm; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  th { text-align: left; background: var(--brand-table-head-bg); color: var(--brand-primary); font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; padding: 1.4mm 2mm; border-bottom: 0.3mm solid var(--brand-line); }
  td { padding: 1.4mm 2mm; border-bottom: 0.2mm solid var(--brand-line-soft); vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.detalle { color: var(--brand-ink-strong); font-size: 7.5pt; }
  .pie { display: flex; align-items: flex-end; justify-content: space-between; gap: 6mm; margin-top: 6mm; }
  .firma { font-size: 8.5pt; text-align: center; min-width: 62mm; }
  .firma-line { border-top: 0.3mm solid var(--brand-ink); margin-bottom: 1.5mm; }
  .firma-name { font-weight: 600; }
  .firma-detail { font-size: 7.5pt; color: var(--brand-ink-muted); }
  .sello { font-size: 7pt; color: var(--brand-ink-muted); max-width: 90mm; }
  .sello code { font-size: 7pt; letter-spacing: 0.2mm; }
  .verify { text-align: center; font-size: 6.5pt; color: var(--brand-ink-muted); }
  .verify svg { width: 22mm; height: 22mm; display: block; margin: 0 auto 1mm; }
`;

/**
 * Pie de página **de cada hoja**: el folio y el correlativo.
 *
 * Chromium repite esta plantilla en todas las páginas y sustituye `pageNumber` y
 * `totalPages`. Es la única forma de numerar el papel: en los márgenes de `@page`,
 * `counter(page)` no está soportado.
 */
export const dossierFooterTemplate = (number: string): string =>
  `<div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7pt;color:#6b7680;padding:0 14mm;display:flex;justify-content:space-between">` +
  `<span>Expediente ${escapeHtml(number)} · OdontoCRM</span>` +
  `<span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>` +
  '</div>';

const filaProcedimientos = (content: ClinicalSessionContent): string => {
  if (content.procedimientos.length === 0) return '—';
  return content.procedimientos
    .map((procedimiento) => escapeHtml(sessionProcedureText(procedimiento)))
    .join('; ');
};

const filaDiagnostico = (content: ClinicalSessionContent): string => {
  const partes = [content.motivo, content.diagnostico].filter(
    (texto): texto is string => typeof texto === 'string' && texto.trim() !== '',
  );
  return partes.length === 0 ? '—' : partes.map(escapeHtml).join(' · ');
};

/**
 * Tabla de hallazgos: **lo que el dibujo no dice**.
 *
 * El SVG del odontograma enseña las caras teñidas por estado, pero no el *nombre* de la
 * condición —y las que afectan a la pieza completa (extracción, corona…) no tienen cara
 * que teñir y solo salen aquí—. Sin esta tabla, el dossier llevaría un dibujo bonito y
 * mudo.
 */
const tablaHallazgos = (findings: Record<string, readonly ToothFindingRecord[]>): string => {
  const filas = Object.entries(findings)
    .map(([pieza, lista]) => ({ pieza: Number(pieza), lista }))
    .sort((izquierda, derecha) => izquierda.pieza - derecha.pieza)
    .flatMap(({ pieza, lista }) =>
      [...lista]
        .sort((izquierda, derecha) =>
          (izquierda.surface ?? '').localeCompare(derecha.surface ?? ''),
        )
        .map(
          (hallazgo) => `
      <tr>
        <td class="num">${String(pieza)}</td>
        <td>${escapeHtml(hallazgo.surface === null ? 'Pieza completa' : (surfaceLabelFor(pieza, hallazgo.surface) ?? hallazgo.surface))}</td>
        <td>${escapeHtml(CONDITION_LABELS[hallazgo.condition] ?? hallazgo.condition)}</td>
        <td class="detalle">${escapeHtml(CLINICAL_STATE_LABELS[hallazgo.state] ?? hallazgo.state)}</td>
      </tr>`,
        ),
    )
    .join('');

  if (filas === '') return '';
  return `<div class="hallazgos"><table><thead><tr><th>Pieza</th><th>Cara</th><th>Condición</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table></div>`;
};

/**
 * HTML completo del dossier. Se devuelve como cadena: Chromium lo convierte en PDF y el
 * servicio lo archiva con su huella.
 */
export const dossierHtml = async (input: DossierDocumentInput): Promise<string> => {
  const consultorio = input.clinic ?? CLINIC;
  const logo = input.logoDataUri ?? (await readImageDataUri(input.logoPath));
  // La marca de agua usa el **logo efectivo** (el subido o el del repositorio).
  const marcaDeAgua = brandWatermarkHtml(logo ?? (await readImageDataUri(BRAND.watermarkPath)));
  const paciente = input.patient;
  const odontograma = odontogramSection(input.odontogram);

  const filiacion: [string, string][] = [
    ['Paciente', paciente?.fullName ?? 'Sin ficha disponible'],
    ['Documento', paciente?.document ?? '—'],
    [
      'Nacimiento',
      paciente?.birthDate === undefined || paciente?.birthDate === ''
        ? '—'
        : `${shortDate(paciente.birthDate)}${paciente.age === null ? '' : ` (${String(paciente.age)} años)`}`,
    ],
    ['Teléfono', paciente?.phone ?? '—'],
    ['Dirección', paciente?.address ?? '—'],
    ['Ocupación', paciente?.occupation ?? '—'],
  ];

  const alertas =
    input.alerts.length === 0
      ? '<p class="sin-alertas">Sin alergias ni antecedentes de riesgo registrados en la anamnesis.</p>'
      : `<div class="alertas"><h3>Alertas clínicas</h3><ul>${input.alerts
          .map((alerta) => {
            const etiqueta = CLINICAL_ALERT_LABELS[alerta.code] ?? alerta.code;
            return `<li>${escapeHtml(alerta.detail === null ? etiqueta : `${etiqueta}: ${alerta.detail}`)}</li>`;
          })
          .join('')}</ul></div>`;

  const filasSesiones = input.sessions
    .map(
      (sesion) => `
      <tr>
        <td class="num">${escapeHtml(formatSessionNumber(sesion.sessionNumber))}</td>
        <td class="num">${sesion.closedAt === null ? '—' : escapeHtml(shortDate(sesion.closedAt))}</td>
        <td>${filaProcedimientos(sesion.content)}</td>
        <td class="detalle">${filaDiagnostico(sesion.content)}</td>
      </tr>`,
    )
    .join('');

  const filasRecipes = input.prescriptions
    .map(
      (entrada) => `
      <tr>
        <td class="num">${escapeHtml(entrada.summary.number ?? '—')}</td>
        <td class="num">${entrada.summary.issuedAt === null ? '—' : escapeHtml(shortDate(entrada.summary.issuedAt))}</td>
        <td class="detalle">${escapeHtml(entrada.summary.status)}</td>
        <td>${entrada.medications.map(escapeHtml).join('; ')}</td>
        <td class="num">${escapeHtml(entrada.summary.verifyCode ?? '—')}</td>
      </tr>`,
    )
    .join('');

  const dentista = input.dentist;
  const firmaDetalle = [
    dentista?.mpps ?? null,
    dentista?.specialty ?? null,
    dentista?.licenseNumber ?? null,
  ]
    .filter((linea): linea is string => linea !== null && linea.trim() !== '')
    .map(escapeHtml)
    .join(' · ');

  const verificacion =
    input.verificationUrl === null
      ? ''
      : `<div class="verify">${qrSvg(input.verificationUrl)}<code>${escapeHtml(input.number)}</code><div>Verifica este expediente en la web del consultorio</div></div>`;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Expediente ${escapeHtml(input.number)}</title><style>${estilos(await brandFontFaceCss())}</style></head>
<body>
  ${marcaDeAgua}
  <div class="brand-doc">
  <header class="letterhead">
    <div class="letterhead-brand">
      ${logo === null ? '' : `<img class="logo" src="${logo}" alt="Logo del consultorio">`}
      <div>
        <p class="clinic-name">${escapeHtml(consultorio.name)}</p>
        ${consultorio.legalName === null ? '' : `<p class="clinic-line">${escapeHtml(consultorio.legalName)}</p>`}
        <p class="clinic-line">${escapeHtml(clinicFullAddress(consultorio))}</p>
        ${consultorio.rif === null ? '' : `<p class="clinic-line">RIF ${escapeHtml(consultorio.rif)}</p>`}
        ${clinicContactLine(consultorio) === '' ? '' : `<p class="clinic-line">${escapeHtml(clinicContactLine(consultorio))}</p>`}
      </div>
    </div>
    <div class="doc-meta">
      <p class="doc-number">${escapeHtml(input.number)}</p>
      <p class="clinic-line">Emitido el ${escapeHtml(dateTime(input.issuedAt))}</p>
    </div>
  </header>

  <h1>Expediente clínico</h1>
  <p class="subtitle">Resumen consolidado: filiación, odontograma, evolución y farmacia. Documento informativo: no sustituye a la historia clínica.</p>

  <h2>Filiación y alertas</h2>
  <dl class="filiacion">
    ${filiacion.map(([etiqueta, valor]) => `<div><dt>${escapeHtml(etiqueta)}</dt><dd>${escapeHtml(valor)}</dd></div>`).join('')}
  </dl>
  ${alertas}

  <h2>Odontograma diagnóstico</h2>
  <p class="subtitle">${
    odontograma.empty
      ? 'Sin hallazgos registrados.'
      : `${String(odontograma.summary.affectedTeeth)} pieza(s) con hallazgos · ${String(odontograma.summary.pendingCount)} pendiente(s) · ${String(odontograma.summary.completedCount)} realizado(s).`
  }</p>
  ${odontograma.html}
  ${tablaHallazgos(input.odontogram.findings)}

  <h2>Evolución cronológica</h2>
  ${
    input.sessions.length === 0
      ? '<p class="vacio">Todavía no hay sesiones clínicas cerradas.</p>'
      : `<table><thead><tr><th>Sesión</th><th>Fecha</th><th>Procedimientos</th><th>Motivo / diagnóstico</th></tr></thead><tbody>${filasSesiones}</tbody></table>`
  }

  <h2>Historial farmacológico</h2>
  ${
    input.prescriptions.length === 0
      ? '<p class="vacio">No se han emitido récipes a este paciente.</p>'
      : `<table><thead><tr><th>Récipe</th><th>Fecha</th><th>Estado</th><th>Medicamentos</th><th>Código</th></tr></thead><tbody>${filasRecipes}</tbody></table>`
  }

  <section class="pie">
    <div class="sello">
      <p>Documento emitido por el sistema del consultorio y archivado con su huella digital.
      La verificación del código confirma que el papel es auténtico; no contiene datos clínicos.</p>
      <p>${dentista === null ? '' : `Profesional responsable: ${escapeHtml(dentista.fullName)}`}</p>
    </div>
    ${verificacion}
    <div class="firma">
      <div class="firma-line"></div>
      <p class="firma-name">${escapeHtml(dentista?.fullName ?? 'Odontólogo tratante')}</p>
      <p class="firma-detail">${firmaDetalle}</p>
    </div>
  </section>
  </div>
</body>
</html>`;
};
