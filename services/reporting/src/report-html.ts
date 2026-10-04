import {
  CLINIC,
  clinicContactLine,
  clinicFullAddress,
  type ReportDocument,
} from '@odontocrm/contracts';

/**
 * Plantilla HTML imprimible del reporte: es lo que Chromium convierte en PDF
 * (`page.setContent` + `page.pdf`, A4 **horizontal**).
 *
 * Lleva el membrete del consultorio —el mismo dato editable que usan el récipe y las
 * pantallas (`packages/contracts/src/clinic.ts`)—, los KPIs, las gráficas **no**
 * (un PDF con gráficas vectoriales de Recharts exigiría un navegador con la
 * interfaz montada; aquí va lo que se decide: cifras y tabla), la tabla completa y
 * las notas del documento.
 */

/** Escapa el texto que va al HTML: hay nombres de paciente en la tabla. */
const escapeHtml = (valor: string): string =>
  valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const numero = (valor: number | string | null): string => {
  if (valor === null) return '—';
  if (typeof valor === 'number') {
    return Number.isInteger(valor) ? String(valor) : String(valor).replace('.', ',');
  }
  return valor;
};

/** `aaaa-mm-dd` → `dd/mm/aaaa` (sin pasar por `Date`: se correría un día). */
const fecha = (valor: string): string => {
  const [anio = '', mes = '', dia = ''] = valor.split('-');
  return `${dia}/${mes}/${anio}`;
};

/** Fecha y hora del consultorio: «04/10/2026 09:31». */
const fechaHora = (iso: string): string => {
  const partes = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const valor = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((parte) => parte.type === tipo)?.value ?? '';
  return `${valor('day')}/${valor('month')}/${valor('year')} ${valor('hour')}:${valor('minute')}`;
};

const estilos = `
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #17202a; margin: 0; }
  .letterhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; border-bottom: 0.6mm solid #1f6f6b; padding-bottom: 3mm; }
  .clinic-name { font-size: 14pt; font-weight: 700; color: #14504d; margin: 0; }
  .clinic-line { font-size: 8pt; color: #4a5560; margin: 0.6mm 0 0; }
  .doc-meta { text-align: right; font-size: 8pt; color: #4a5560; min-width: 60mm; }
  h1 { font-size: 13pt; margin: 4mm 0 0; color: #14504d; }
  .subtitle { font-size: 8.5pt; color: #4a5560; margin: 1mm 0 0; }
  .kpis { display: flex; flex-wrap: wrap; gap: 3mm; margin-top: 4mm; }
  .kpi { border: 0.25mm solid #cfdedd; border-radius: 1.5mm; padding: 2mm 3mm; min-width: 34mm; flex: 1 1 34mm; }
  .kpi-label { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; color: #4a5560; margin: 0; }
  .kpi-value { font-size: 13pt; font-weight: 700; margin: 0.8mm 0 0; }
  .kpi-hint { font-size: 7pt; color: #6b7680; margin: 0.6mm 0 0; }
  .kpi.good .kpi-value { color: #14663f; }
  .kpi.warn .kpi-value { color: #8a5a00; }
  .kpi.bad .kpi-value { color: #97231f; }
  h2 { font-size: 10pt; color: #14504d; margin: 5mm 0 1.5mm; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  th { text-align: left; background: #eef5f4; color: #14504d; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.2mm; padding: 1.4mm 2mm; border-bottom: 0.3mm solid #cfdedd; }
  td { padding: 1.4mm 2mm; border-bottom: 0.2mm solid #e3e9ea; }
  td.num, th.num { text-align: right; }
  .notes { margin-top: 4mm; font-size: 7.5pt; color: #4a5560; }
  .notes li { margin-bottom: 0.8mm; }
  .footer { margin-top: 5mm; font-size: 7pt; color: #6b7680; }
`;

/**
 * HTML completo del reporte. Se devuelve como cadena (no se escribe en disco): el
 * navegador lo recibe con `page.setContent` y de ahí sale el PDF.
 */
export const reportHtml = (documento: ReportDocument): string => {
  const contactos = clinicContactLine(CLINIC);
  const lineasMembrete = [
    clinicFullAddress(CLINIC),
    CLINIC.rif === null ? null : `RIF ${CLINIC.rif}`,
    contactos === '' ? null : contactos,
  ]
    .filter((linea): linea is string => linea !== null)
    .map((linea) => `<p class="clinic-line">${escapeHtml(linea)}</p>`)
    .join('');

  const kpis = documento.kpis
    .map(
      (kpi) => `
      <div class="kpi ${kpi.tone}">
        <p class="kpi-label">${escapeHtml(kpi.label)}</p>
        <p class="kpi-value">${escapeHtml(numero(kpi.value))}${kpi.unit === null ? '' : ` ${escapeHtml(kpi.unit)}`}</p>
        ${kpi.hint === null ? '' : `<p class="kpi-hint">${escapeHtml(kpi.hint)}</p>`}
      </div>`,
    )
    .join('');

  const columnas = documento.table.columns
    .map(
      (columna) =>
        `<th class="${columna.type === 'number' || columna.type === 'percent' ? 'num' : ''}">${escapeHtml(columna.label)}</th>`,
    )
    .join('');

  const filas = documento.table.rows
    .map(
      (fila) => `
      <tr>${documento.table.columns
        .map((columna) => {
          const valor = fila[columna.key] ?? null;
          const texto =
            columna.type === 'date' && typeof valor === 'string' ? fecha(valor) : numero(valor);
          const clase = columna.type === 'number' || columna.type === 'percent' ? 'num' : '';
          return `<td class="${clase}">${escapeHtml(texto)}</td>`;
        })
        .join('')}</tr>`,
    )
    .join('');

  const notas = documento.notes.map((nota) => `<li>${escapeHtml(nota)}</li>`).join('');

  const filtros = [
    documento.filters.ageMin === undefined && documento.filters.ageMax === undefined
      ? null
      : `edad ${String(documento.filters.ageMin ?? 0)}–${String(documento.filters.ageMax ?? 120)}`,
    documento.filters.sex === undefined ? null : `sexo ${documento.filters.sex}`,
    documento.filters.status === undefined ? null : `estado ${documento.filters.status}`,
  ]
    .filter((parte): parte is string => parte !== null)
    .join(' · ');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(documento.title)}</title>
<style>${estilos}</style>
</head>
<body>
  <header class="letterhead">
    <div>
      <p class="clinic-name">${escapeHtml(CLINIC.name)}</p>
      ${lineasMembrete}
    </div>
    <div class="doc-meta">
      <p class="clinic-line">Generado el ${escapeHtml(fechaHora(documento.generatedAt))}</p>
      <p class="clinic-line">Del ${escapeHtml(fecha(documento.range.from))} al ${escapeHtml(fecha(documento.range.to))}</p>
      ${filtros === '' ? '' : `<p class="clinic-line">${escapeHtml(filtros)}</p>`}
    </div>
  </header>

  <h1>${escapeHtml(documento.title)}</h1>
  <p class="subtitle">${escapeHtml(documento.subtitle)}</p>

  ${documento.kpis.length === 0 ? '' : `<section class="kpis">${kpis}</section>`}

  <h2>Detalle</h2>
  ${
    documento.table.rows.length === 0
      ? '<p class="subtitle">Sin filas que imprimir en el período seleccionado.</p>'
      : `<table><thead><tr>${columnas}</tr></thead><tbody>${filas}</tbody></table>`
  }

  ${notas === '' ? '' : `<section class="notes"><h2>Notas</h2><ul>${notas}</ul></section>`}

  <p class="footer">${escapeHtml(CLINIC.name)} · OdontoCRM · informe generado por el servicio de reportes</p>
</body>
</html>`;
};
