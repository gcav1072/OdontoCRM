# ADR 0054 — El membrete, el logo y la marca de agua son los mismos en todos los imprimibles

- **Fecha:** 2026-10-08 · **Estado:** aceptada · **Implementada:** sesión de identidad del consultorio (2026-10-08)
- **Relacionada:** [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md) — la marca como fuente única
  ([`brand.ts`](../../packages/contracts/src/brand.ts)); [ADR 0015](0015-recipe-a5-en-pdf.md) — récipe A5
  con membrete; [ADR 0036](0036-recipe-emitido-documento-archivado.md) — el récipe emitido se archiva;
  [ADR 0048](0048-el-documento-de-cobro-se-archiva.md) — los documentos de cobro se archivan.

## Contexto

El consultorio tiene **una** identidad: un nombre, un logo, una dirección, un RIF y unos
odontólogos que firman. Viven, editables, en `packages/contracts/src/clinic.ts` (los datos) y
`packages/contracts/src/brand.ts` (la paleta, las tipografías y las medidas del membrete).

Con el tiempo aparecieron **siete** imprimibles, compuestos por tres servicios y por el
navegador:

| Documento | Lo compone | Estado encontrado |
| :--- | :--- | :--- |
| Récipe A5 | `clinical` (Chromium) | logo + membrete |
| Dossier del expediente A4 | `clinical` (Chromium) | logo + membrete |
| Reporte A4 | `reporting` (Chromium) | membrete, **sin logo** |
| Factura / Recibo / Nota de crédito | `billing` (Chromium) | membrete propio, **sin logo** |
| Historia clínica A4 | el navegador (`window.print`) | **sin membrete y sin logo** |
| Odontograma A4 | el navegador (`window.print`) | solo el nombre, **sin logo** |

Además, `brand.ts` declaraba la **marca de agua** (`watermarkPath`, `watermarkWidthMm`,
`watermarkOpacity`) y `marca.css` publicaba sus variables, pero **ningún documento la usaba**:
una decisión escrita y no cableada. Y los dos imprimibles del navegador no seguían la marca en
absoluto —colores `slate-*` a mano—, así que la misma historia clínica salía de un color en
pantalla y de otro en el récipe.

El riesgo es el de siempre en este repositorio: **una identidad copiada en varios sitios acaba
siendo varias identidades**. Se arregla mientras son pocas las diferencias, no cuando ya hay
papeles con membrete distinto circulando.

## Decisión

**El membrete, el logo y la marca de agua se componen desde la marca, en un solo sitio, y todos
los imprimibles los comparten.**

1. **La marca de agua se cablea.** Es el logo del consultorio, centrado y translúcido, detrás del
   contenido. Se pinta con `position: fixed` para que **se repita en cada hoja** (Chromium al
   convertir a PDF y el navegador al imprimir), y las medidas salen de la marca. El contenido va
   en un contenedor `.brand-doc` (`position: relative; z-index: 1`) para quedar por encima: sin
   eso, el velo taparía el texto. `brandWatermarkCss()` y `brandWatermarkHtml()` son **puros** y
   viven en `brand.ts`, como `brandStyles()`.
2. **El logo se añade a los documentos que no lo tenían** (reporte A4 y factura/recibo/nota de
   crédito), reutilizando el **mismo** lector de imagen. `readImageDataUri()` vive en
   `packages/kernel` —núcleo común de los servicios, que ya importa los contratos— y devuelve un
   `data:` URI; si la ruta es `null` o el archivo no está, devuelve `null` y el documento sale
   sin logo, como hasta ahora (el membrete avisa de lo que falta con `letterheadMissingFields`).
3. **Los imprimibles del navegador usan el mismo membrete** (historia clínica y odontograma) con
   un componente de la SPA (`MembreteDocumento`) que lee `CLINIC`.
4. **Los colores de énfasis del documento salen de la marca en todos los imprimibles.** Títulos,
   encabezados de tabla, líneas, contornos y tinta usan las variables `--brand-*` y no colores
   sueltos: los documentos de **cobro** (factura, recibo y nota de crédito, antes en gris y negro
   a mano), la **historia clínica** (antes con clases `slate-*`), y el **odontograma** (antes con
   los tokens del *tema* de pantalla y con trazos fijos en el SVG). Así el mismo cambio de
   `brand.ts` mueve el énfasis del récipe, el dossier, el reporte, los cobros, la historia clínica
   y el odontograma **a la vez**.
5. **El logo llega a la SPA con un `import.meta.glob` de Vite** sobre `assets/clinic/*` con
   `?url`. Vite copia la imagen al paquete y devuelve su URL; no se duplica el binario ni hace
   falta un `public/` que mantener sincronizado, y el archivo sigue siendo el de `BRAND.logoPath`
   (vale `.svg`, `.png` o `.jpg`). Es el **mismo** archivo que el servidor incrusta en los PDF.

Los colores **clínicos** del odontograma —el rojo de `pendiente` y el azul de `completado`
(`CLINICAL_STATE_COLORS`)— **no** siguen el cambio de paleta: no son decoración, son un código
que el odontólogo lee. Tampoco la pantalla de carga/error de la SPA (`main.tsx`), que se pinta
antes de que exista la hoja de estilos.

En SVG, `var()` no vale como **atributo** de presentación (`stroke="var(--x)"` no resuelve): la
marca entra por `style` (`style="stroke:var(--brand-line)"` en las cadenas del servidor,
`style={{ stroke: 'var(--brand-line)' }}` en los componentes de la SPA).

## Consecuencias

> **Nota (ADR 0056).** Este ADR decidió que la identidad del consultorio (los datos) vivía en el
> código. El [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) la mueve a la **base
> de `identity`** (el titular la completa en su primer acceso) y deja `clinic.ts` como **semilla y
> respaldo**. Lo que **sigue vigente** de aquí: el membrete, el logo y la marca de agua salen de un
> solo sitio, el logo es **el mismo** en todos los imprimibles y la **marca** (paleta, tipografías,
> medidas) se edita solo en el código.

- **A favor:** un solo archivo (`brand.ts` + `clinic.ts`) cambia la identidad de **pantalla y
  papel** a la vez; el membrete ya no se puede quedar a medias entre documentos; la marca de agua
  que estaba escrita y sin usar pasa a existir; y los imprimibles del navegador dejan de ser un
  caso aparte.
- **A favor:** el logo del membrete es **un solo binario**, incrustado como `data:` URI en los
  PDF del servidor y copiado por Vite en la SPA, así que el papel archivado no depende de rutas y
  el logo no se puede «perder» al mover el proyecto.
- **En contra / a vigilar:** los `render*Html` de `reporting` y `billing` pasan a ser **`async`**
  (leen el archivo del logo). Es un cambio de firma que obliga a `await` en sus llamadores y
  pruebas; se acepta porque ya se ejecutan dentro de flujos asíncronos que componen el PDF.
- **En contra / a vigilar:** la factura con **formas libres** se imprime *sobre* la forma física
  preimpresa; la marca de agua (logos de la clínica al 10 %) se suma a lo ya impreso. Es
  deliberado y reversible en una línea (quitar `brandWatermarkHtml(...)` de `invoice-pdf.ts`) si
  el fisco o la imprenta lo objetan.
- La marca de agua **no** sustituye a un fondo de seguridad ni pretende ser un antifalsificación:
  es identidad visual. La autenticidad la da el QR del récipe y el dossier.
