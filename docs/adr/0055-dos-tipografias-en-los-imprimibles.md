# ADR 0055 — Los imprimibles tienen dos tipografías: títulos y cuerpo

- **Fecha:** 2026-10-08 · **Estado:** aceptada · **Implementada:** sesión de identidad del consultorio (2026-10-08)
- **Relacionada:** [ADR 0015](0015-recipe-a5-en-pdf.md) — récipe A5; [ADR 0054](0054-membrete-unico-en-los-imprimibles.md)
  — la marca como fuente única; [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) — la identidad
  del consultorio en la base.

## Contexto

La marca (`packages/contracts/src/brand.ts`) declaraba **una sola** pila tipográfica para
los documentos (`documentSans`) y `brandStyles()` la aplicaba al `body`: todo el papel
—el nombre del consultorio, «RÉCIPE», los encabezados de tabla y el texto corrido— salía
con la misma fuente.

Un documento impreso mejora cuando el **titular** tiene carácter y el **cuerpo** es de
alta legibilidad; son dos decisiones distintas y a veces dos familias distintas. Además,
las fuentes vivían en el sistema operativo: el récipe se componía con Chromium y el
navegador imprime la historia clínica y el odontograma, así que **el mismo documento
salía con dos tipografías** según el equipo tuviera o no la familia instalada. Un papel
clínico no puede depender de lo que haya instalado quien lo abre.

## Decisión

1. **Dos pilas en la marca.** `documentSans` se parte en `documentTitleSans` y
   `documentBodySans`, y `brandCssVariables()` publica `--brand-font-doc-title` y
   `--brand-font-doc-body` (en lugar de `--brand-font-doc`). `brandStyles()` pone la del
   **cuerpo** en el `body` y declara `.brand-title` para los títulos; cada plantilla
   aplica esa clase (o la variable) a su nombre del consultorio, a «RÉCIPE», a los
   encabezados de sección y a los números de documento.
2. **Las fuentes se auto-hospedan y se incrustan.** Viven en `assets/clinic/fonts/`
   (`.woff2`) y se declaran en `BRAND.fonts` —familia y archivos con su peso—, que es el
   **mismo patrón que `logoPath`**: el servidor y la SPA leen los mismos binarios.
   - El servidor los mete en el `<style>` del PDF como `@font-face` con `data:` URI
     (`brandFontFaceCss()`, en el kernel, que es donde hay sistema de archivos). El
     documento archivado **no depende de rutas ni de la máquina**.
   - La SPA los declara una vez al arrancar (`apps/web/src/lib/fuentes.ts`, con
     `import.meta.glob` sobre `assets/clinic/fonts/*.woff2`), igual que el logo.
3. **De momento, Montserrat** (subconjunto `latin`, pesos 400 y 700) con su licencia
   OFL junto a los archivos. Cambiar de familia es dejar los `.woff2` en esa carpeta,
   ajustar `BRAND.fonts.families` y los primeros nombres de las pilas.

> **Actualización ([ADR 0063](0063-seleccion-de-fuentes-por-rol.md)).** La marca pasó de **una**
> familia a un **catálogo de familias** (`BRAND.fonts.families`) y de pilas de texto libre a una
> **selección por desplegable con vista previa** en el panel, más un **peso por rol**
> (`--brand-font-doc-title-weight` / `--brand-font-doc-body-weight`).
4. **La marca sigue siendo solo-código.** Las tipografías se editan en `brand.ts` y se
   regenera `marca.css` (`npm run marca:css`); **no** se editan desde la aplicación. El
   ADR 0056 mueve la *identidad* (nombre, RIF, logo) a la base, no la *marca*.

## Consecuencias

- **A favor:** el récipe, el dossier, el reporte, la factura, la historia clínica y el
  odontograma tienen títulos y cuerpo diferenciables, y salen **iguales** en cualquier
  equipo: las fuentes viajan dentro del documento o del paquete de la web.
- **A favor:** un solo sitio (`brand.ts`) mueve las dos tipografías en **papel y
  pantalla** a la vez, y `brand.test.ts` denuncia si alguien no regenera `marca.css` o si
  un archivo de fuente declarado no existe en el repositorio.
- **En contra / a vigilar:** el CSS del PDF crece con las fuentes incrustadas (los dos
  `.woff2` suman ~38 KB, base64 ~51 KB). Es el precio de que el papel se explique solo;
  si algún día molesta, se puede limitar a un subconjunto menor o usar fuentes de
  sistema como respaldo.
- **En contra / a vigilar:** la SPA carga los `.woff2` como recursos propios (los emite
  Vite en `dist/assets/`), así que hay que **recompilar la web** al cambiar de fuente;
  los PDF del servidor las leen al componer, sin recompilar.
- **No cambia** nada de lo ya decidido en el ADR 0054: el membrete, el logo y la marca de
  agua siguen saliendo de un solo sitio, y los colores clínicos del odontograma siguen
  fuera de la paleta.
