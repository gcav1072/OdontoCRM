import {
  CLINIC,
  formatRateMicros,
  rateToMicros,
  vesCentimosFromUsd,
  type BillingDraftItem,
  type ClinicIdentity,
  type InvoiceTotals,
} from '@odontocrm/contracts';

/**
 * La **factura** en A4, compuesta una sola vez y archivada (ADR 0048).
 *
 * Todo lo que exige la Providencia SNAT/2011/0071, Art. 13, está en el papel: la denominación, la
 * **numeración consecutiva y única** y el **número de control preimpreso** con su rango, los datos del
 * emisor (razón social, RIF y domicilio fiscal), la fecha en **DDMMAAAA**, el cliente, la descripción
 * con la letra (E) en lo exento y (G) en lo gravado, la **base desglosada por alícuota con el total
 * exento aparte**, el IVA, el total general, las **dos cantidades con el tipo de cambio** (num. 14) y
 * los datos de la imprenta.
 *
 * Con **formas libres** la plantilla se imprime *sobre* la forma: el membrete, el RIF del emisor y el
 * control **ya vienen impresos**, así que este HTML los repite para que el archivo archivado se
 * explique solo, y la calibración del `@page` decide qué se pisa y qué no (§6 del plan).
 */

export interface InvoicePdfInput {
  /** Perfil del consultorio; por defecto, el genérico del contrato (Tarea 0 lo llevará al entorno). */
  clinic?: ClinicIdentity;
  series: string;
  numberLabel: string;
  controlNumber: string | null;
  /** Rango asignado a la forma: «desde el N° … hasta el N° …» (Art. 13 num. 4). */
  controlRange: { from: string; to: string } | null;
  issuedAt: Date;
  patient: {
    name: string;
    docType: string;
    docNumber: string;
    taxId: string | null;
    fiscalAddress: string | null;
  };
  items: readonly BillingDraftItem[];
  totals: InvoiceTotals;
  rateMicros: number;
  /** Datos de la imprenta que autorizó las formas (Art. 13 nums. 15 y 16). */
  printer: {
    name: string;
    rif: string;
    authorizationRef: string;
    authorizationDate: string;
    printDate: string;
  } | null;
  /** El IGTF de esta instalación (contribuyente ordinario, no SPE): no percibido. */
  igtfNote: string;
  /** `true` para las copias: llevan «sin derecho a crédito fiscal» (Art. 13 num. 13). */
  esCopia?: boolean;
}

const escapar = (texto: string | null | undefined): string =>
  String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Céntimos a la forma venezolana: `1234` → `12,34`. */
const dinero = (cents: number): string =>
  (cents / 100).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * La fecha como la pide la Providencia: `DDMMAAAA` (Art. 34), y en el **día de Caracas** —el del
 * hecho imponible—, no en el del reloj del servidor: uno en UTC imprimiría el día equivocado.
 */
export const fechaFiscal = (fecha: Date): string => {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha);
  const [anio = '', mes = '', dia = ''] = iso.split('-');
  return `${dia}${mes}${anio}`;
};

/** Puntos básicos a la forma que se imprime: `1600` → `16,00`. */
const porcentaje = (basisPoints: number): string =>
  (basisPoints / 100).toFixed(2).replace('.', ',');

const partida = (item: BillingDraftItem, rateMicros: number): string => {
  const letra = item.taxCategory === 'general' ? '(G)' : '(E)';
  const pieza =
    item.toothNumber === null
      ? ''
      : ` · pieza ${String(item.toothNumber)}${item.surfaces === null || item.surfaces.length === 0 ? '' : ` (${item.surfaces.join(', ')})`}`;
  return `<tr>
    <td>${escapar(item.description)}${escapar(pieza)} <strong>${letra}</strong></td>
    <td class="num">${String(item.quantity)}</td>
    <td class="num">${dinero(item.unitPriceCentsUsd)}</td>
    <td class="num">${dinero(item.totalPriceCentsUsd)}</td>
    <td class="num">${dinero(vesCentimosFromUsd(item.totalPriceCentsUsd, rateMicros))}</td>
  </tr>`;
};

export const renderInvoiceHtml = (input: InvoicePdfInput): string => {
  const clinic = input.clinic ?? CLINIC;
  const fecha = fechaFiscal(input.issuedAt);
  const enBs = (cents: number): number => vesCentimosFromUsd(cents, input.rateMicros);

  // La base gravada se desglosa **por alícuota** (Art. 13 num. 10); hoy solo hay una general.
  const porAlicuota = new Map<number, number>();
  for (const item of input.items) {
    if (item.taxCategory !== 'general') continue;
    porAlicuota.set(
      item.taxRateBasisPoints,
      (porAlicuota.get(item.taxRateBasisPoints) ?? 0) + item.totalPriceCentsUsd,
    );
  }
  const gravadas = [...porAlicuota.entries()].sort((a, b) => a[0] - b[0]);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapar(`Factura ${input.numberLabel}`)}</title>
<style>
  /* Una factura = una página (Art. 33). Los márgenes se miden sobre la forma física. */
  @page { size: A4 portrait; margin: 14mm 12mm 12mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; color: #111; margin: 0; }
  h1 { font-size: 13pt; margin: 0; letter-spacing: .04em; }
  .cabecera { display: flex; justify-content: space-between; gap: 8mm; border-bottom: 1.2pt solid #111; padding-bottom: 3mm; }
  .emisor { max-width: 95mm; }
  .emisor .nombre { font-weight: 700; font-size: 11pt; }
  .emisor .dato { color: #333; }
  .documento { text-align: right; min-width: 60mm; }
  .documento .numero { font-size: 12pt; font-weight: 700; }
  .documento .control { font-weight: 600; }
  .bloque { margin-top: 3mm; display: flex; justify-content: space-between; gap: 8mm; }
  .caja { border: .6pt solid #999; padding: 2mm; }
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  th, td { border-bottom: .5pt solid #ccc; padding: 1.4mm 1mm; text-align: left; }
  th { background: #f2f2f2; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .03em; }
  .num { text-align: right; white-space: nowrap; }
  .totales { margin-top: 3mm; display: flex; justify-content: flex-end; }
  .totales table { width: 95mm; }
  .totales td { border: none; padding: .8mm 1mm; }
  .totales .fila-total td { border-top: 1pt solid #111; font-weight: 700; font-size: 11pt; }
  .leyendas { margin-top: 4mm; font-size: 8pt; color: #222; }
  .leyendas p { margin: 1mm 0; }
  .igtf { border: .6pt dashed #666; padding: 2mm; margin-top: 3mm; font-size: 8pt; }
  .copia { margin-top: 3mm; font-weight: 700; font-size: 8.5pt; }
  .imprenta { margin-top: 4mm; border-top: .6pt solid #111; padding-top: 2mm; font-size: 7.5pt; color: #333; }
  .faltantes { margin-top: 2mm; font-size: 8pt; color: #8a1c1c; font-weight: 600; }
</style>
</head>
<body>
  <div class="cabecera">
    <div class="emisor">
      <div class="nombre">${escapar(clinic.legalName)}</div>
      <div class="dato">${escapar(clinic.name)}</div>
      <div class="dato">RIF: ${escapar(clinic.rif)}</div>
      <div class="dato">${escapar(`${clinic.address}, ${clinic.city}`)}</div>
    </div>
    <div class="documento">
      <h1>FACTURA</h1>
      <div class="numero">N° ${escapar(input.numberLabel)}</div>
      ${input.controlNumber === null ? '' : `<div class="control">N° de control: ${escapar(input.controlNumber)}</div>`}
      ${input.controlRange === null ? '' : `<div class="dato">Rango autorizado: desde el N° ${escapar(input.controlRange.from)} hasta el N° ${escapar(input.controlRange.to)}</div>`}
      <div class="dato">Fecha de emisión: ${fecha}</div>
    </div>
  </div>

  <div class="bloque">
    <div class="caja" style="flex: 1">
      <div><strong>Cliente:</strong> ${escapar(input.patient.name)}</div>
      <div><strong>${input.patient.taxId === null ? 'Cédula' : 'RIF'}:</strong> ${escapar(input.patient.taxId ?? `${input.patient.docType}-${input.patient.docNumber}`)}</div>
      ${input.patient.fiscalAddress === null ? '' : `<div><strong>Domicilio fiscal:</strong> ${escapar(input.patient.fiscalAddress)}</div>`}
    </div>
    <div class="caja" style="flex: 1">
      <div><strong>Moneda de cuenta:</strong> USD (dólar de los Estados Unidos)</div>
      <div><strong>Tipo de cambio:</strong> ${escapar(formatRateMicros(input.rateMicros))} Bs./USD</div>
      <div><strong>Pago:</strong> en bolívares a la tasa de la fecha de pago</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Descripción</th>
        <th class="num">Cant.</th>
        <th class="num">P. unit. US$</th>
        <th class="num">Total US$</th>
        <th class="num">Total Bs.</th>
      </tr>
    </thead>
    <tbody>
      ${input.items.map((item) => partida(item, input.rateMicros)).join('\n')}
    </tbody>
  </table>

  <div class="totales">
    <table>
      <tr><td>Total exento</td><td class="num">US$ ${dinero(input.totals.exemptAmountCentsUsd)}</td><td class="num">Bs. ${dinero(enBs(input.totals.exemptAmountCentsUsd))}</td></tr>
      ${gravadas
        .map(
          ([puntos, base]) =>
            `<tr><td>Base gravada al ${porcentaje(puntos)} %</td><td class="num">US$ ${dinero(base)}</td><td class="num">Bs. ${dinero(enBs(base))}</td></tr>`,
        )
        .join('')}
      <tr><td>IVA</td><td class="num">US$ ${dinero(input.totals.ivaAmountCentsUsd)}</td><td class="num">Bs. ${dinero(enBs(input.totals.ivaAmountCentsUsd))}</td></tr>
      <tr class="fila-total"><td>Total general</td><td class="num">US$ ${dinero(input.totals.totalCentsUsd)}</td><td class="num">Bs. ${dinero(enBs(input.totals.totalCentsUsd))}</td></tr>
    </table>
  </div>

  <div class="igtf">${escapar(input.igtfNote)}</div>

  <div class="leyendas">
    <p>Servicios exentos de IVA — Art. 19, numeral 6 de la Ley de IVA. La letra (E) marca las partidas exentas y (G) las gravadas.</p>
    <p>Montos en VES calculados a la tasa oficial BCV de la fecha de emisión (Art. 25 Ley IVA, Prov. 0071 Art. 13 num. 14). Si el pago se efectúa en fecha posterior, la obligación en bolívares se liquidará a la tasa oficial BCV vigente a la fecha del pago (Convenio Cambiario N.º 1, Art. 8.a).</p>
    ${input.esCopia ? '<p class="copia">COPIA — SIN DERECHO A CRÉDITO FISCAL</p>' : ''}
  </div>

  <div class="imprenta">
    ${
      input.printer === null
        ? 'Documento emitido por el sistema del consultorio.'
        : `Forma libre autorizada — Imprenta: ${escapar(input.printer.name)} · RIF ${escapar(input.printer.rif)} ·
           Providencia ${escapar(input.printer.authorizationRef)} del ${escapar(input.printer.authorizationDate)} ·
           Fecha de elaboración de la forma: ${escapar(input.printer.printDate)}`
    }
  </div>
</body>
</html>`;
};

/** El aviso de IGTF que va en el papel mientras la clínica no sea Sujeto Pasivo Especial. */
export const IGTF_NO_PERCIBIDO =
  'IGTF: no percibido por la clínica (contribuyente ordinario, no calificado como Sujeto Pasivo Especial). No forma parte del monto de esta factura.';

/** Micros desde la cadena tecleada — se usa en las pruebas y en el recálculo del papel. */
export const microsDeTasa = (rate: string): number => rateToMicros(rate);
