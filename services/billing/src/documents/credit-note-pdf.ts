import { CLINIC, formatRateMicros, type ClinicIdentity } from '@odontocrm/contracts';

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

export const renderCreditNoteHtml = (input: CreditNotePdfInput): string => {
  const clinic = input.clinic ?? CLINIC;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapar(`Nota de crédito ${input.creditNoteLabel}`)}</title>
<style>
  @page { size: A4 portrait; margin: 16mm 14mm; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #111; margin: 0; }
  h1 { font-size: 14pt; margin: 0 0 1mm; letter-spacing: .04em; }
  .cabecera { display: flex; justify-content: space-between; border-bottom: 1.2pt solid #111; padding-bottom: 3mm; }
  .nombre { font-weight: 700; }
  .dato { color: #333; }
  table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
  td { padding: 1.6mm 1mm; border-bottom: .5pt solid #ddd; }
  td.etiqueta { color: #444; width: 55mm; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .total td { border-top: 1pt solid #111; font-weight: 700; font-size: 12pt; }
  .leyendas { margin-top: 5mm; font-size: 8pt; color: #222; }
  .pie { margin-top: 8mm; font-size: 8pt; color: #444; }
</style>
</head>
<body>
  <div class="cabecera">
    <div>
      <div class="nombre">${escapar(clinic.legalName)}</div>
      <div class="dato">RIF: ${escapar(clinic.rif)}</div>
      <div class="dato">${escapar(`${clinic.address}, ${clinic.city}`)}</div>
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
</body>
</html>`;
};
