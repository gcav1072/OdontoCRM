import { BRAND, type BrandFontFile } from '@odontocrm/contracts';

/**
 * Las fuentes del consultorio en la interfaz: los **mismos** archivos que el servidor
 * incrusta en los PDF (récipe, dossier, reporte, factura). Viven en
 * `assets/clinic/fonts/` y los declara la marca (`BRAND.fonts`).
 *
 * **¿Por qué un `import.meta.glob`?** Porque Vite solo resuelve importaciones con una
 * ruta **literal** y el glob deja que el nombre del archivo siga siendo el de la marca
 * sin duplicar el binario ni mantener un `public/`: en la compilación, Vite copia cada
 * `.woff2` al paquete y devuelve su URL. Es el mismo patrón del logo (`lib/marca.ts`) y
 * la misma razón: el papel del navegador y el del servidor no pueden separarse.
 *
 * Sin esto, la historia clínica y el odontograma que imprime el navegador saldrían con
 * la fuente del sistema en vez de con la del récipe, en cualquier equipo que no tenga
 * la familia instalada.
 */
const modulos = import.meta.glob('../../../../assets/clinic/fonts/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** El nombre del archivo sin la carpeta: `assets/clinic/fonts/x.woff2` → `x.woff2`. */
const nombreDeArchivo = (ruta: string): string => ruta.split(/[\\/]/).pop() ?? ruta;

const urlPorNombre: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(modulos).map(([ruta, url]) => [nombreDeArchivo(ruta), url]),
);

/** Una regla `@font-face` por archivo declarado en la marca, con la URL que resuelve Vite. */
const reglaDe = (file: BrandFontFile): string => {
  const url = urlPorNombre[nombreDeArchivo(file.path)];
  if (url === undefined) return '';
  return `@font-face{font-family:'${BRAND.fonts.family}';font-style:${file.style};font-weight:${String(
    file.weight,
  )};font-display:swap;src:url(${url}) format('woff2');}`;
};

/** Todas las reglas `@font-face` de la marca, como texto. */
export const fuentesCss = (): string =>
  BRAND.fonts.files
    .map(reglaDe)
    .filter((regla) => regla !== '')
    .join('\n');

let aplicadas = false;

/**
 * Declara las fuentes de la marca en el documento (`<style>` con sus `@font-face`) una
 * sola vez. Se llama al arrancar la SPA, antes del primer render: así el membrete y los
 * imprimibles del navegador ya tienen la tipografía cuando se pintan.
 */
export const aplicarFuentesDocumento = (): void => {
  if (aplicadas || typeof document === 'undefined') return;
  aplicadas = true;
  const estilo = document.createElement('style');
  estilo.dataset['odontocrm'] = 'fuentes-marca';
  estilo.textContent = fuentesCss();
  document.head.append(estilo);
};
