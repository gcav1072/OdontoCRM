import {
  BRAND,
  CLINIC,
  brandRootBlock,
  brandWatermarkCss,
  brandWatermarkHtml,
  buildLetterheadView,
  letterheadCss,
  letterheadHtml,
  type BrandThemePayload,
  type ClinicIdentity,
  type CsvColumn,
  type CsvRow,
  type CsvValue,
  type ExchangeDiffSummary,
  type IgtfSummary,
} from '@odontocrm/contracts';
import { brandFontFaceCss, readImageDataUri } from '@odontocrm/kernel';

/**
 * Los **libros fiscales en PDF**: el mismo contenido que el CSV, compuesto para imprimir o firmar
 * con el **membrete del consultorio** (ADR 0064) y la marca efectiva (ADR 0060).
 *
 * Decisiones que conviene no perder de vista:
 *
 * - **No se archiva** en el almacén ni consume correlativo. La factura, el recibo y la nota son
 *   documentos fiscales por operación y se guardan al emitirse (ADR 0048); un libro es un informe
 *   que se pide cuando se necesita, así que se compone al vuelo.
 * - El papel es **carta horizontal**: el libro de ventas tiene doce columnas y en vertical no cabe
 *   sin partir los importes.
 * - El **membrete no lleva la línea del odontólogo**: un libro lo firma el representante legal, no
 *   el especialista que atendió. El CSV y el PDF de una misma petición comparten período y números.
 * - El formato de cada columna sale de una tabla **por libro** (`FORMATO_DE_COLUMNA`), no de adivinar
 *   por el valor: una columna nueva sin entrada sale como texto y su prueba lo delata.
 */

export type BookKind = 'ventas' | 'cambiario' | 'igtf';

/** Cómo se escribe cada columna en el papel. */
type ColumnFormat = 'text' | 'date' | 'money' | 'rate' | 'percent';

/**
 * Una entrada por **cada** columna de `SALES_BOOK_COLUMNS`, `IGTF_BOOK_COLUMNS` y
 * `EXCHANGE_DIFF_BOOK_COLUMNS` (lo fija `book-pdf.test.ts`): un libro no puede imprimir una columna
 * nueva sin decidir si lleva dos decimales, cuatro o ninguna.
 */
export const FORMATO_DE_COLUMNA: Readonly<
  Record<BookKind, Readonly<Record<string, ColumnFormat>>>
> = {
  ventas: {
    fecha: 'date',
    documento: 'text',
    control: 'text',
    cliente: 'text',
    rif: 'text',
    exento: 'money',
    base16: 'money',
    iva: 'money',
    total: 'money',
    tasa: 'rate',
    totalBs: 'money',
    estado: 'text',
  },
  igtf: {
    fecha: 'date',
    recibo: 'text',
    factura: 'text',
    medio: 'text',
    monto: 'money',
    alicuota: 'percent',
    percibidoPor: 'text',
    igtf: 'money',
    igtfBs: 'money',
  },
  cambiario: {
    fecha: 'date',
    documento: 'text',
    concepto: 'text',
    tasa: 'rate',
    diferencialBs: 'money',
  },
};

export const BOOK_TITLES: Readonly<Record<BookKind, string>> = {
  ventas: 'Libro de ventas',
  cambiario: 'Estado de ganancias y pérdidas por diferencial cambiario',
  igtf: 'Reporte de percepción del IGTF y destino de caja',
};

export interface BookPdfInput {
  kind: BookKind;
  /** Días de calendario (`aaaa-mm-dd`), los del período que se declara. */
  from: string;
  to: string;
  columns: readonly CsvColumn[];
  rows: readonly CsvRow[];
  /** Los resúmenes del período; en el libro de ventas no aplica. */
  summary?:
    { exchangeDiff?: ExchangeDiffSummary | null; igtf?: IgtfSummary | null } | null | undefined;
  clinic?: ClinicIdentity;
  logoDataUri?: string | null;
  brand?: BrandThemePayload | null;
  fontFaceCss?: string | null;
  /** Momento de la composición; se imprime en el pie (día de Caracas). */
  generatedAt?: Date;
}

const escapar = (texto: string): string =>
  texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** `aaaa-mm-dd` → `dd/mm/aaaa`, sin pasar por `Date` (se correría un día en Caracas). */
export const fechaDelLibro = (valor: string): string => {
  const [anio = '', mes = '', dia = ''] = valor.split('-');
  return dia === '' || mes === '' || anio === '' ? valor : `${dia}/${mes}/${anio}`;
};

const decimales = (valor: number, cuantos: number): string =>
  valor.toLocaleString('es-VE', {
    minimumFractionDigits: cuantos,
    maximumFractionDigits: cuantos,
  });

/** Lo que se escribe en una celda según el tipo de columna (y el valor, que viene del CSV). */
export const celdaDelLibro = (valor: CsvValue, formato: ColumnFormat | undefined): string => {
  if (valor === null || valor === undefined || valor === '') return '';
  if (formato === 'date' && typeof valor === 'string') return fechaDelLibro(valor);
  if (typeof valor !== 'number') return String(valor);
  if (formato === 'rate') return decimales(valor, 4);
  if (formato === 'percent') return decimales(valor, 2);
  // `money` y el texto numérico sin formato explícito: dos decimales, como el CSV.
  return formato === 'money' ? decimales(valor, 2) : String(valor).replace('.', ',');
};

/** Fecha y hora en el día del consultorio: «18/10/2026 09:31». */
const fechaHora = (iso: Date): string => {
  const partes = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(iso);
  const valor = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${valor('day')}/${valor('month')}/${valor('year')} ${valor('hour')}:${valor('minute')}`;
};

const estilos = (fontFaces: string, brand: BrandThemePayload | null | undefined): string => `
  ${fontFaces}
  ${brandRootBlock(brand ?? BRAND)}
  ${brandWatermarkCss()}
  ${letterheadCss()}
  /* El libro de ventas tiene doce columnas: en vertical no cabe sin partir los importes. */
  @page { size: letter landscape; margin: 12mm 12mm 16mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: var(--brand-font-doc-body); font-size: 8.5pt; color: var(--brand-ink); margin: 0; }
  .cabecera { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; border-bottom: 1pt solid var(--brand-ink); padding-bottom: 2.5mm; }
  .cabecera > .brand-lh { flex: 1 1 auto; min-width: 0; }
  .doc-meta { text-align: right; font-size: 8pt; color: var(--brand-ink-muted); min-width: 55mm; }
  .doc-meta p { margin: 0.5mm 0; }
  h1 { font-family: var(--brand-font-doc-title); font-size: 13pt; font-weight: var(--brand-font-doc-title-weight); color: var(--brand-primary); margin: 4mm 0 0; }
  .periodo { font-size: 8.5pt; color: var(--brand-ink-muted); margin: 1mm 0 0; }
  /* La cabecera de la tabla se repite en cada página: un libro de 30 días ocupa varias. */
  thead { display: table-header-group; }
  table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  th { text-align: left; background: var(--brand-table-head-bg); color: var(--brand-primary); font-size: 7pt; text-transform: uppercase; letter-spacing: 0.15mm; padding: 1.2mm 1.6mm; border-bottom: 0.3mm solid var(--brand-line); }
  td { padding: 1.1mm 1.6mm; border-bottom: 0.2mm solid var(--brand-line-soft); }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .resumen { display: flex; flex-wrap: wrap; gap: 3mm; margin-top: 4mm; }
  .resumen .kpi { border: 0.25mm solid var(--brand-line); border-radius: 1.5mm; padding: 2mm 3mm; min-width: 38mm; flex: 1 1 38mm; }
  .resumen .kpi-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; color: var(--brand-ink-muted); margin: 0; }
  .resumen .kpi-value { font-size: 12pt; font-weight: 700; margin: 0.6mm 0 0; }
  .vacio { margin-top: 6mm; font-size: 9pt; color: var(--brand-ink-muted); }
  .nota { margin-top: 4mm; font-size: 7.5pt; color: var(--brand-ink-subtle); }
`;

const kpi = (etiqueta: string, valor: string): string =>
  `<div class="kpi"><p class="kpi-label">${escapar(etiqueta)}</p><p class="kpi-value">${escapar(valor)}</p></div>`;

/** El resumen en el papel: los mismos números que la pantalla de la caja. */
const resumenHtml = (input: BookPdfInput): string => {
  const bloques: string[] = [];
  const cambiario = input.summary?.exchangeDiff;
  const igtf = input.summary?.igtf;

  if (input.kind === 'cambiario' && cambiario != null) {
    bloques.push(
      kpi('Ganancias', `Bs. ${decimales(cambiario.gananciasVesCentimos / 100, 2)}`),
      kpi('Pérdidas', `Bs. ${decimales(cambiario.perdidasVesCentimos / 100, 2)}`),
      kpi('Reversiones', `Bs. ${decimales(cambiario.reversionesVesCentimos / 100, 2)}`),
      kpi('Neto del período', `Bs. ${decimales(cambiario.netoVesCentimos / 100, 2)}`),
    );
  }
  if (input.kind === 'igtf' && igtf != null) {
    bloques.push(
      kpi('Base en divisas', `US$ ${decimales(igtf.baseDivisasCentsUsd / 100, 2)}`),
      kpi('IGTF causado', `US$ ${decimales(igtf.igtfCentsUsd / 100, 2)}`),
      kpi('Arqueo Caja Divisas', `US$ ${decimales(igtf.igtfCajaDivisasCentsUsd / 100, 2)}`),
      kpi('Arqueo Banco/Caja Bs.', `Bs. ${decimales(igtf.igtfCajaBsVesCentimos / 100, 2)}`),
    );
  }
  return bloques.length === 0 ? '' : `<section class="resumen">${bloques.join('')}</section>`;
};

export const renderBookHtml = async (input: BookPdfInput): Promise<string> => {
  const clinic = input.clinic ?? CLINIC;
  const logo = input.logoDataUri ?? (await readImageDataUri(clinic.logoPath ?? BRAND.logoPath));
  const marcaDeAgua = brandWatermarkHtml(logo ?? (await readImageDataUri(BRAND.watermarkPath)));
  // Sin línea de odontólogo: el libro lo respalda el consultorio, no el especialista de turno.
  const membrete = buildLetterheadView(clinic, null, input.brand?.letterhead ?? BRAND.letterhead);
  const formatos = FORMATO_DE_COLUMNA[input.kind];

  const columnas = input.columns
    .map((columna) => {
      const formato = formatos[columna.key];
      const clase = formato === 'money' || formato === 'rate' || formato === 'percent' ? 'num' : '';
      return `<th class="${clase}">${escapar(columna.label)}</th>`;
    })
    .join('');

  const filas = input.rows
    .map(
      (fila) =>
        `<tr>${input.columns
          .map((columna) => {
            const formato = formatos[columna.key];
            const clase =
              formato === 'money' || formato === 'rate' || formato === 'percent' ? 'num' : '';
            return `<td class="${clase}">${escapar(celdaDelLibro(fila[columna.key], formato))}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');

  const sinFilas = input.rows.length === 0;
  const generado = fechaHora(input.generatedAt ?? new Date());

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapar(BOOK_TITLES[input.kind])}</title>
<style>${estilos(input.fontFaceCss ?? (await brandFontFaceCss()), input.brand)}</style>
</head>
<body>
  ${marcaDeAgua}
  <div class="brand-doc">
  <header class="cabecera">
    ${letterheadHtml(membrete, logo, { rule: false })}
    <div class="doc-meta">
      <p>Generado el ${escapar(generado)}</p>
      <p>Del ${escapar(fechaDelLibro(input.from))} al ${escapar(fechaDelLibro(input.to))}</p>
    </div>
  </header>

  <h1>${escapar(BOOK_TITLES[input.kind])}</h1>
  <p class="periodo">Período del ${escapar(fechaDelLibro(input.from))} al ${escapar(fechaDelLibro(input.to))} · días del consultorio (America/Caracas)</p>

  ${
    sinFilas
      ? '<p class="vacio">Sin operaciones en el período seleccionado.</p>'
      : `<table><thead><tr>${columnas}</tr></thead><tbody>${filas}</tbody></table>`
  }

  ${resumenHtml(input)}

  ${
    input.kind === 'ventas'
      ? '<p class="nota">Las notas de crédito entran con el monto en negativo y el documento que dejan sin efecto: el libro cuenta lo que pasó, no lo que sobrevivió (Art. 75 de la Providencia SNAT/2011/0071).</p>'
      : ''
  }
  </div>
</body>
</html>`;
};
