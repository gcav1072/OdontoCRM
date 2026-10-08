import {
  BRAND,
  CLINIC,
  brandRootBlock,
  brandWatermarkCss,
  brandWatermarkHtml,
  formatRateMicros,
  type ClinicIdentity,
} from '@odontocrm/contracts';
import { readImageDataUri } from '@odontocrm/kernel';

import { fechaFiscal } from './invoice-pdf.js';

/**
 * La **nota de crédito** (Art. 22 y 23 de la Providencia 0071): el documento que deja sin efecto una
 * factura ya emitida. No la sustituye ni la tapa: la **referencia** con fecha, número y monto
 * copiados, porque la factura puede anularse después y la referencia tiene que seguir legible.
 */
export interface CreditNotePdfInput {
  clinic?: ClinicIdentity;
  /** `NC-000001`. */
  creditNoteLabel: string;
  issuedAt: Date;
  /** La factura que queda sin efecto, con sus datos **copiados**. */
  invoice: { numberLabel: string; issuedAt: Date; totalCentsUsd: number };
  patient: { name: string; docType: string; docNumber: string };
  reason: string;
  totalCentsUsd: number;
  totalVesCentimos: number;
  rateMicros: number;
  issuedByUsername: string;
}

const escapar = (texto: string | null | undefined): string =>
  String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const dinero = (cents: number): string =>
  (cents / 100).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const renderCreditNoteHtml = async (input: CreditNotePdfInput): Promise<string> => {
  const clinic = input.clinic ?? CLINIC;
  const logo = await readImageDataUri(clinic.logoPath ?? BRAND.logoPath);
  const marcaDeAgua = brandWatermarkHtml(await readImageDataUri(BRAND.watermarkPath));

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapar(`Nota de crédito ${input.creditNoteLabel}`)}</title>
<style>
  ${brandRootBlock()}
  ${brandWatermarkCss()}
  @page { size: A4 portrait; margin: 16mm 14mm; }
  body { font-family: var(--brand-font-doc); font-size: 10pt; color: var(--brand-ink); margin: 0; }
  h1 { font-size: 14pt; margin: 0 0 1mm; letter-spacing: .04em; color: var(--brand-primary); }
  .cabecera { display: flex; justify-content: space-between; border-bottom: 1.2pt solid var(--brand-ink); padding-bottom: 3mm; }
  .emisor { display: flex; align-items: flex-start; gap: 5mm; }
  .emisor .logo { height: var(--brand-logo-height-mm); width: auto; }
  .nombre { font-weight: 700; color: var(--brand-primary); }
  .dato { color: var(--brand-ink-muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
  td { padding: 1.6mm 1mm; border-bottom: .5pt solid var(--brand-line-soft); }
  td.etiqueta { color: var(--brand-ink-muted); width: 55mm; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .total td { border-top: 1pt solid var(--brand-ink); font-weight: 700; font-size: 12pt; }
  .leyendas { margin-top: 5mm; font-size: 8pt; color: var(--brand-ink-strong); }
  .pie { margin-top: 8mm; font-size: 8pt; color: var(--brand-ink-muted); }
</style>
</head>
<body>
  ${marcaDeAgua}
  <div class="brand-doc">
  <div class="cabecera">
    <div class="emisor">
      ${logo === null ? '' : `<img class="logo" src="${logo}" alt="Logo del consultorio">`}
      <div>
        <div class="nombre">${escapar(clinic.legalName)}</div>
        <div class="dato">${escapar(clinic.name)}</div>
        <div class="dato">RIF: ${escapar(clinic.rif)}</div>
        <div class="dato">${escapar(`${clinic.address}, ${clinic.city}`)}</div>
      </div>
    </div>
    <div style="text-align:right">
      <h1>NOTA DE CRÉDITO</h1>
      <div class="dato">N° ${escapar(input.creditNoteLabel)}</div>
      <div class="dato">Fecha: ${fechaFiscal(input.issuedAt)}</div>
    </div>
  </div>

  <table>
    <tr><td class="etiqueta">Paciente</td><td>${escapar(input.patient.name)}</td></tr>
    <tr><td class="etiqueta">Documento</td><td>${escapar(`${input.patient.docType}-${input.patient.docNumber}`)}</td></tr>
    <tr><td class="etiqueta">Factura que queda sin efecto</td><td>N° ${escapar(input.invoice.numberLabel)} del ${fechaFiscal(input.invoice.issuedAt)}</td></tr>
    <tr><td class="etiqueta">Monto de esa factura</td><td class="num">US$ ${dinero(input.invoice.totalCentsUsd)}</td></tr>
    <tr><td class="etiqueta">Motivo</td><td>${escapar(input.reason)}</td></tr>
    <tr><td class="etiqueta">Tipo de cambio aplicado</td><td class="num">${escapar(formatRateMicros(input.rateMicros))} Bs./USD</td></tr>
    <tr class="total"><td class="etiqueta">Monto acreditado</td><td class="num">US$ ${dinero(input.totalCentsUsd)} · Bs. ${dinero(input.totalVesCentimos)}</td></tr>
  </table>

  <div class="leyendas">
    <p>Esta nota deja sin efecto la operación documentada en la factura citada, conforme al artículo 22 de la Providencia SNAT/2011/0071. La factura anulada se conserva.</p>
  </div>

  <div class="pie">Emitida por: ${escapar(input.issuedByUsername)}</div>
  </div>
</body>
</html>`;
};
