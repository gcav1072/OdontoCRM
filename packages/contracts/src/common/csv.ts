/**
 * Construcción de CSV para las exportaciones del sistema.
 *
 * Reglas (pensadas para que el archivo **abra bien en Excel en español**):
 * - **BOM UTF-8** al principio: sin él, Excel en Windows lee el archivo como
 *   `windows-1252` y «María Peña» sale como «MarÃ­a PeÃ±a».
 * - Separador **`;`**: con coma decimal, Excel en español interpreta la coma
 *   como separador de columnas y parte cada fila.
 * - Comillas dobles alrededor del campo cuando contiene el separador, comillas
 *   o saltos de línea (y se duplican las comillas internas, RFC 4180).
 * - Fin de línea **CRLF**, que es lo que espera Excel en Windows.
 *
 * Al ser una función pura, vive aquí y no en un servicio: la usan los reportes
 * y la auditoría, y las dos exportaciones comparten las mismas pruebas.
 */

export const CSV_BOM = '\uFEFF';
export const CSV_SEPARATOR = ';';
export const CSV_NEWLINE = '\r\n';

export interface CsvColumn {
  key: string;
  label: string;
}

export type CsvValue = string | number | null | undefined;
export type CsvRow = Readonly<Record<string, CsvValue>>;

/** Formatea un número con **coma decimal** (lo que espera Excel en español). */
export const csvNumber = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace('.', ',');
};

/** Escapa un valor para una celda de CSV. */
export const csvCell = (value: CsvValue): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? csvNumber(value) : value;
  // Los saltos de línea dentro de una celda se aplanan a un espacio: el CSV
  // sigue siendo válido, pero una fila no se parte en dos al abrirlo.
  const flat = text.replace(/\r?\n/g, ' ');
  // Solo se entrecomilla lo que rompería la fila (el separador), lo que lleva
  // comillas o los espacios de sobra. **La coma decimal no se entrecomilla a
  // propósito**: `"0,85"` es texto para Excel y la columna dejaría de sumar.
  const needsQuotes = flat.includes(CSV_SEPARATOR) || flat.includes('"') || flat !== flat.trim();
  return needsQuotes ? `"${flat.replaceAll('"', '""')}"` : flat;
};

/**
 * Arma el CSV completo. La cabecera sale de las etiquetas de las columnas (en
 * español, como el resto de lo que ve el personal) y las filas del mismo orden.
 */
export const buildCsv = (columns: readonly CsvColumn[], rows: readonly CsvRow[]): string => {
  const header = columns.map((column) => csvCell(column.label)).join(CSV_SEPARATOR);
  const body = rows.map((row) =>
    columns.map((column) => csvCell(row[column.key])).join(CSV_SEPARATOR),
  );
  return [CSV_BOM + header, ...body].join(CSV_NEWLINE) + CSV_NEWLINE;
};
