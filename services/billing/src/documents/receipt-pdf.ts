import {
  BRAND,
  CLINIC,
  brandRootBlock,
  brandWatermarkCss,
  brandWatermarkHtml,
  formatRateMicros,
  paymentMethodLabel,
  type ClinicIdentity,
} from '@odontocrm/contracts';
import { readImageDataUri } from '@odontocrm/kernel';

import { fechaFiscal } from './invoice-pdf.js';

/**
 * El **recibo** de un cobro: el papel que se le da al paciente cuando paga.
 *
 * No es una factura (esa ya se emitió), así que no lleva número de control ni desglose fiscal: dice
 * **qué se pagó, con qué medio, a qué tasa se imputó y cuánto queda debiendo**. El IGTF aparece solo
 * cuando aplica: mientras la clínica no sea Sujeto Pasivo Especial, el recibo lo dice.
 */
export interface ReceiptPdfInput {
  clinic?: ClinicIdentity;
  /** `REC-000001`. */
  receiptLabel: string;
  /** `A-000123`, la factura que se está pagando. */
  invoiceLabel: string;
  paidAt: Date;
  patient: { name: string; docType: string; docNumber: string };
  method: string;
  tenderedAmount: number;
  tenderedCurrency: 'USD' | 'VES';
  amountCentsUsd: number;
  rateMicros: number;
  imputationPolicy: string;
  fxDifferenceCentsUsd: number;
  igtf: {
    applies: boolean;
    perceivedBy: string | null;
    basisPoints: number;
    amountCentsUsd: number;
    amountVesCentimos: number;
  };
  totalCentsUsd: number;
  balanceCentsUsd: number;
  receivedByUsername: string;
}

const escapar = (texto: string | null | undefined): string =>
  String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const dinero = (cents: number): string =>
  (cents / 100).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const porcentaje = (basisPoints: number): string =>
  (basisPoints / 100).toFixed(2).replace('.', ',');

export const renderReceiptHtml = async (input: ReceiptPdfInput): Promise<string> => {
  const clinic = input.clinic ?? CLINIC;
  const logo = await readImageDataUri(clinic.logoPath ?? BRAND.logoPath);
  const marcaDeAgua = brandWatermarkHtml(await readImageDataUri(BRAND.watermarkPath));
  const enBs = (cents: number): string =>
    dinero(Math.round((cents * input.rateMicros) / 1_000_000));

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapar(`Recibo ${input.receiptLabel}`)}</title>
<style>
  ${brandRootBlock()}
  ${brandWatermarkCss()}
  @page { size: A4 portrait; margin: 16mm 14mm; }
  body { font-family: var(--brand-font-doc); font-size: 10pt; color: var(--brand-ink); margin: 0; }
  h1 { font-size: 14pt; margin: 0 0 1mm; letter-spacing: .04em; color: var(--brand-primary); }
  .cabecera { display: flex; justify-content: space-between; border-bottom: 1.2pt solid var(--brand-ink); padding-bottom: 3mm; }
  .emisor { display: flex; align-items: flex-start; gap: 5mm; }
  .emisor .logo { height: var(--brand-logo-height-mm); width: auto; }
  .emisor .nombre { font-weight: 700; color: var(--brand-primary); }
  .dato { color: var(--brand-ink-muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
  td { padding: 1.6mm 1mm; border-bottom: .5pt solid var(--brand-line-soft); }
  td.etiqueta { color: var(--brand-ink-muted); width: 55mm; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .saldo td { border-top: 1pt solid var(--brand-ink); font-weight: 700; font-size: 12pt; }
  .igtf { margin-top: 4mm; border: .6pt dashed var(--brand-ink-subtle); padding: 2mm; font-size: 8.5pt; }
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
      <h1>RECIBO</h1>
      <div class="dato">N° ${escapar(input.receiptLabel)}</div>
      <div class="dato">Fecha: ${fechaFiscal(input.paidAt)}</div>
      <div class="dato">Factura: ${escapar(input.invoiceLabel)}</div>
    </div>
  </div>

  <table>
    <tr><td class="etiqueta">Paciente</td><td>${escapar(input.patient.name)}</td></tr>
    <tr><td class="etiqueta">Documento</td><td>${escapar(`${input.patient.docType}-${input.patient.docNumber}`)}</td></tr>
    <tr><td class="etiqueta">Medio de pago</td><td>${escapar(paymentMethodLabel(input.method))}</td></tr>
    <tr><td class="etiqueta">Monto entregado</td><td class="num">${input.tenderedCurrency === 'USD' ? 'US$' : 'Bs.'} ${dinero(input.tenderedAmount)}</td></tr>
    <tr><td class="etiqueta">Tasa aplicada</td><td class="num">${escapar(formatRateMicros(input.rateMicros))} Bs./USD</td></tr>
    <tr><td class="etiqueta">Imputado a la deuda</td><td class="num">US$ ${dinero(input.amountCentsUsd)} · Bs. ${enBs(input.amountCentsUsd)}</td></tr>
    ${
      input.fxDifferenceCentsUsd === 0
        ? ''
        : `<tr><td class="etiqueta">Diferencia cambiaria</td><td class="num">US$ ${dinero(input.fxDifferenceCentsUsd)}</td></tr>`
    }
    <tr><td class="etiqueta">Total de la factura</td><td class="num">US$ ${dinero(input.totalCentsUsd)}</td></tr>
    <tr class="saldo"><td class="etiqueta">Saldo pendiente</td><td class="num">US$ ${dinero(input.balanceCentsUsd)}</td></tr>
  </table>

  ${
    input.igtf.applies
      ? `<div class="igtf">IGTF ${porcentaje(input.igtf.basisPoints)} %: ${
          input.igtf.perceivedBy === 'banco'
            ? 'lo debita el banco (no se cobra en caja)'
            : `percibido por la clínica: US$ ${dinero(input.igtf.amountCentsUsd)} · Bs. ${dinero(input.igtf.amountVesCentimos)}`
        }</div>`
      : '<div class="igtf">IGTF: no percibido (la clínica no está calificada como Sujeto Pasivo Especial). No forma parte de este cobro.</div>'
  }

  <div class="leyendas">
    <p>El pago en bolívares se imputó según la política «${escapar(input.imputationPolicy)}» a la tasa oficial BCV de la fecha del pago (Convenio Cambiario N.º 1, Art. 8.a).</p>
    <p>Este recibo no sustituye a la factura: la factura emitida es el documento fiscal.</p>
  </div>

  <div class="pie">Recibido por: ${escapar(input.receivedByUsername)}</div>
  </div>
</body>
</html>`;
};
