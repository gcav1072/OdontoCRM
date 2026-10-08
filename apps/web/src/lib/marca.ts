import { BRAND } from '@odontocrm/contracts';

/**
 * El **logo del consultorio** en la interfaz, resuelto a una URL que el navegador
 * puede pintar (el membrete del odontograma y de la historia clínica que se imprimen
 * desde el navegador, no desde el servidor).
 *
 * **¿Por qué un `import.meta.glob`?** Porque el logo es un archivo del repositorio
 * (`assets/clinic/logo.svg`, configurable en `BRAND.logoPath`) y Vite solo resuelve
 * importaciones con una ruta **literal**. Glob deja que el archivo siga siendo el de
 * la marca —y que valga `.svg`, `.png` o `.jpg`— sin duplicar el binario ni añadir un
 * `public/` que habría que mantener sincronizado: en la compilación, Vite copia la
 * imagen al paquete y devuelve su URL.
 *
 * Es el **mismo archivo** que el servidor incrusta en el récipe, el dossier, el
 * reporte y los documentos de cobro: el logo del papel y el de la pantalla no pueden
 * separarse.
 */
const modulos = import.meta.glob('../../../../assets/clinic/*.{svg,png,jpg,jpeg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** El nombre del archivo sin la carpeta: `assets/clinic/logo.svg` → `logo.svg`. */
const nombreDeArchivo = (ruta: string): string => ruta.split(/[\\/]/).pop() ?? ruta;

const urlPorNombre: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(modulos).map(([ruta, url]) => [nombreDeArchivo(ruta), url]),
);

/**
 * URL de la imagen cuyo archivo corresponde a `path` (la ruta de la marca), o `null`
 * si no hay logo o el archivo no está en `assets/clinic/`. Con `null`, el membrete
 * sale **sin logo** en vez de romperse, igual que en los PDF.
 */
export const logoUrlFor = (path: string | null | undefined): string | null => {
  if (path === null || path === undefined || path.trim() === '') return null;
  return urlPorNombre[nombreDeArchivo(path)] ?? null;
};

/** El logo del membrete (`BRAND.logoPath`), como URL para la interfaz. */
export const clinicLogoUrl = (): string | null => logoUrlFor(BRAND.logoPath);
