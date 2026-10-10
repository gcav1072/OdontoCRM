# Logo del consultorio y fuentes de los imprimibles

Esta carpeta tiene **dos** cosas: el logo **de respaldo** y los archivos de las **fuentes** de los
documentos.

## El logo

Deja aquí el logo de respaldo: `assets/clinic/logo.svg`. **Desde el ADR 0056 el logo de verdad se
sube desde la aplicación** (Mi perfil del titular, o `/usuarios` el administrador) y se guarda en el
almacén; el de esta carpeta se usa **mientras no se haya subido ninguno** (una instalación recién
puesta, la base caída).

El logo que se sube y este de respaldo tienen que cumplir lo mismo, porque el logo va sobre papel
blanco y el servidor lo mete en el PDF como `data:` URI:

- **SVG monocromo** con el relleno *incrustado* (`fill="#14504d"`, el verde-teal de la marca). No
  uses `currentColor` ni variables CSS: dentro de un `<img>` no hereda nada del documento.
- **Fondo transparente** y **solo `viewBox`** (sin `width`/`height`): el alto lo fija el CSS
  (`--brand-logo-height-mm`, 18 mm por defecto).
- **Texto convertido a trazados**, para que se vea igual en cualquier equipo.
- El mismo logo hace de **marca de agua** en los imprimibles: se imprime a un solo color y con la
  opacidad muy baja (`--brand-watermark-opacity`). El titular puede cambiar el logo, pero **no** el
  ancho ni la opacidad del velo: eso es la **marca** y se edita solo en el código.
- Si no hay logo (ni subido ni aquí), el membrete sale **sin logo** (y `letterheadMissingFields`
  avisa de que falta).

Un PNG o un JPG también sirven como respaldo (`logo.png` / `logo.jpg`), aunque el que se sube desde
la aplicación es **SVG a propósito**.

## Las fuentes

`fonts/` guarda los `.woff2` que los imprimibles usan —un **catálogo** de familias sans y script
(Montserrat, Inter, Poppins, Lobster, Pacifico, Dancing Script), subconjunto `latin`— y la licencia
de cada una (`OFL.txt` para Montserrat y `OFL-<familia>.txt` para el resto). El servidor los
incrusta en el PDF y la SPA los carga al arrancar: **el papel no depende de las fuentes instaladas
en el equipo** (ADR 0055).

La convención de nombre es `<familia>-latin-<peso>-normal.woff2` (p. ej.
`lobster-latin-400-normal.woff2`).

- Se declaran en [`packages/contracts/src/brand.ts`](../../packages/contracts/src/brand.ts)
  (`BRAND.fonts.families`), donde cada familia lleva su `name` y sus archivos con peso y estilo.
- Las pilas de **títulos** (`documentTitleSans`) y **cuerpo** (`documentBodySans`) empiezan por el
  nombre de la familia elegida, y cada rol tiene su **peso** (`documentTitleWeight` /
  `documentBodyWeight`).
- **Desde el panel** (`/configuracion`) se elige la familia y el peso de cada rol en un desplegable,
  con vista previa, y se suben más familias (con su peso y estilo). Cambiar el **catálogo** del
  código es dejar los `.woff2` aquí, tocar `BRAND.fonts.families` y recompilar (los PDF del
  servidor leen los archivos; la web recompila para que Vite copie los nuevos binarios).

La **paleta**, las **tipografías** y las medidas del membrete se cambian en
[`packages/contracts/src/brand.ts`](../../packages/contracts/src/brand.ts) (solo-código). Los datos
del membrete —nombre, RIF, teléfonos y odontólogos con su MPPS— se editan **desde la aplicación**
(Mi perfil o `/usuarios`), no aquí.

El paso a paso (desarrollo y producción) está en
[`docs/IDENTIDAD_Y_DATOS.md`](../../docs/IDENTIDAD_Y_DATOS.md).

