import {
  BRAND,
  CLINIC,
  brandRootBlock,
  brandWatermarkCss,
  brandWatermarkHtml,
  buildLetterheadView,
  clinicDentistLine,
  formatRateMicros,
  letterheadCss,
  letterheadHtml,
  paymentMethodLabel,
  type ClinicDentist,
  type ClinicIdentity,
  type BrandThemePayload,
} from '@odontocrm/contracts';
import { brandFontFaceCss, readImageDataUri } from '@odontocrm/kernel';

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
  /** Logo ya incrustado (`data:` URI); si falta, se lee el del repositorio. */
  logoDataUri?: string | null;
  /** Odontólogo que responde por el documento; su línea va en el membrete. */
  dentist?: ClinicDentist | null;
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
  /** La tasa de la **Fecha Valor** del cobro ($T_{\text{pago}}$). */
  rateMicros: number;
  /** La tasa **congelada de la factura** ($T_{\text{emisión}}$): la del Libro de Ventas. */
  rateEmissionMicros: number;
  /** Fecha Valor: el día del comprobante bancario al que aplica la tasa (ADR 0069). */
  effectiveDate: string;
  /** Imputación histórica a la tasa de emisión: lo que extingue la cuenta nominal. */
  historicalVesCentimos: number;
  /** Diferencial cambiario realizado (positivo = ganancia; negativo = pérdida). */
  exchangeDiffVesCentimos: number;
  imputationPolicy: string;
  fxDifferenceCentsUsd: number;
  igtf: {
    applies: boolean;
    perceivedBy: string | null;
    basisPoints: number;
    amountCentsUsd: number;
    amountVesCentimos: number;
    /** En qué moneda lo entregó el paciente (ADR 0069); `null` si la clínica no lo percibe. */
    collectedCurrency: 'USD' | 'VES' | null;
    paymentMethod: string | null;
    paymentReference: string | null;
  };
  totalCentsUsd: number;
  balanceCentsUsd: number;
  receivedByUsername: string;
  /** La **marca efectiva** de los imprimibles (ADR 0060). Si falta, se usa `BRAND`. */
  brand?: BrandThemePayload | null;
  /** Las `@font-face` ya resueltas por identity (con los `.woff2` incrustados). */
  fontFaceCss?: string | null;
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
  const logo = input.logoDataUri ?? (await readImageDataUri(clinic.logoPath ?? BRAND.logoPath));
  const marcaDeAgua = brandWatermarkHtml(logo ?? (await readImageDataUri(BRAND.watermarkPath)));
  // El odontólogo que responde por el documento, en el membrete.
  const lineaDentista = clinicDentistLine(input.dentist ?? null);
  // El bloque de identidad sale del membrete compartido (ADR 0064): lo encabeza el **nombre
  // del consultorio** y la razón social va de subtítulo, como en el resto de los imprimibles.
  const membrete = buildLetterheadView(
    clinic,
    lineaDentista,
    input.brand?.letterhead ?? BRAND.letterhead,
    { subtitle: clinic.legalName },
  );
  /** La Fecha Valor es un día (`AAAA-MM-DD`): se imprime en el papel como cualquier fecha fiscal. */
  const fechaValor = fechaFiscal(new Date(`${input.effectiveDate}T12:00:00-04:00`));
  /** El desglose del diferencial solo se explica en cobros en bolívares (ADR 0069, Escuela A). */
  const conDesglose =
    input.tenderedCurrency === 'VES' &&
    input.exchangeDiffVesCentimos !== 0 &&
    input.imputationPolicy === 'tasa_del_pago';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapar(`Recibo ${input.receiptLabel}`)}</title>
<style>
  ${brandRootBlock(input.brand ?? BRAND)}
  ${input.fontFaceCss ?? (await brandFontFaceCss())}
  ${brandWatermarkCss()}
  ${letterheadCss()}
  @page { size: letter portrait; margin: 16mm 14mm; }
  body { font-family: var(--brand-font-doc-body); font-size: 10pt; color: var(--brand-ink); margin: 0; }
  h1 { font-family: var(--brand-font-doc-title); font-size: 14pt; font-weight: var(--brand-font-doc-title-weight); margin: 0 0 1mm; letter-spacing: .04em; color: var(--brand-primary); }
  .cabecera { display: flex; justify-content: space-between; border-bottom: 1.2pt solid var(--brand-ink); padding-bottom: 3mm; }
  .cabecera > .brand-lh { min-width: 0; }
  .dato { color: var(--brand-ink-muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 5mm; }
  td { padding: 1.6mm 1mm; border-bottom: .5pt solid var(--brand-line-soft); }
  td.etiqueta { color: var(--brand-ink-muted); width: 55mm; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .saldo td { border-top: 1pt solid var(--brand-ink); font-weight: 700; font-size: 12pt; }
  .desglose { margin-top: 2mm; }
  .desglose td { font-size: 9pt; }
  .igtf { margin-top: 4mm; border: .6pt dashed var(--brand-ink-subtle); padding: 2mm; font-size: 8.5pt; }
  .leyendas { margin-top: 5mm; font-size: 8pt; color: var(--brand-ink-strong); }
  .pie { margin-top: 8mm; font-size: 8pt; color: var(--brand-ink-muted); }
</style>
</head>
<body>
  ${marcaDeAgua}
  <div class="brand-doc">
  <div class="cabecera">
    ${letterheadHtml(membrete, logo, { rule: false })}
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
    <tr><td class="etiqueta">Fecha valor del pago</td><td>${fechaValor}</td></tr>
    <tr><td class="etiqueta">Monto entregado</td><td class="num">${input.tenderedCurrency === 'USD' ? 'US$' : 'Bs.'} ${dinero(input.tenderedAmount)}</td></tr>
    <tr><td class="etiqueta">Tasa BCV aplicada (fecha valor)</td><td class="num">${escapar(formatRateMicros(input.rateMicros))} Bs./USD</td></tr>
    <tr><td class="etiqueta">Tasa de emisión de la factura</td><td class="num">${escapar(formatRateMicros(input.rateEmissionMicros))} Bs./USD</td></tr>
    <tr><td class="etiqueta">Imputado a la deuda</td><td class="num">US$ ${dinero(input.amountCentsUsd)} · Bs. ${dinero(input.historicalVesCentimos)}</td></tr>
    ${
      input.fxDifferenceCentsUsd === 0
        ? ''
        : `<tr><td class="etiqueta">Diferencia cambiaria</td><td class="num">US$ ${dinero(input.fxDifferenceCentsUsd)}</td></tr>`
    }
    <tr><td class="etiqueta">Total de la factura</td><td class="num">US$ ${dinero(input.totalCentsUsd)}</td></tr>
    <tr class="saldo"><td class="etiqueta">Saldo pendiente</td><td class="num">US$ ${dinero(input.balanceCentsUsd)}</td></tr>
  </table>

  ${
    conDesglose
      ? `<table class="desglose">
    <tr><td class="etiqueta">Imputación a la factura (tasa de emisión ${escapar(formatRateMicros(input.rateEmissionMicros))})</td><td class="num">Bs. ${dinero(input.historicalVesCentimos)}</td></tr>
    <tr><td class="etiqueta">Ajuste por diferencial cambiario (tasa ${escapar(formatRateMicros(input.rateMicros))}) — ${input.exchangeDiffVesCentimos > 0 ? 'ganancia cambiaria' : 'pérdida cambiaria'}</td><td class="num">${input.exchangeDiffVesCentimos > 0 ? '+' : '−'} Bs. ${dinero(Math.abs(input.exchangeDiffVesCentimos))}</td></tr>
    <tr class="saldo"><td class="etiqueta">Total recibido en caja/banco</td><td class="num">Bs. ${dinero(input.tenderedAmount)}</td></tr>
  </table>`
      : ''
  }

  ${
    input.igtf.applies
      ? `<div class="igtf">${
          input.igtf.perceivedBy === 'banco'
            ? `IGTF ${porcentaje(input.igtf.basisPoints)} % sobre la base en divisas: lo debita el banco (no se cobra en caja).`
            : `Base imponible en divisas: US$ ${dinero(input.amountCentsUsd)} · IGTF (${porcentaje(input.igtf.basisPoints)} %): US$ ${dinero(input.igtf.amountCentsUsd)} (Bs. ${dinero(input.igtf.amountVesCentimos)}) — percibido en: ${
                input.igtf.collectedCurrency === 'USD'
                  ? 'divisas (Caja Divisas)'
                  : `bolívares (Banco/Caja Bs.${
                      input.igtf.paymentReference === null
                        ? ''
                        : ` · ${escapar(input.igtf.paymentMethod ?? 'pago')} ${escapar(input.igtf.paymentReference)}`
                    })`
              }. No forma parte del monto de la factura: es dinero de terceros que se entera.`
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
