# ADR 0064 — El membrete se configura aparte: logo, tipografía, líneas y pie, aplicados en caliente

- **Fecha:** 2026-10-10 · **Estado:** aceptada
- **Relacionada:** [ADR 0054](0054-membrete-unico-en-los-imprimibles.md) (membrete único),
  [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md) (dos tipografías),
  [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) (identidad en la base),
  [ADR 0060](0060-configuracion-de-la-aplicacion.md) (panel de configuración),
  [ADR 0061](0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md) (especialista en el membrete),
  [ADR 0063](0063-seleccion-de-fuentes-por-rol.md) (selección de fuentes por rol)
- **Fuente de verdad en código:** `packages/contracts/src/brand.ts`,
  `packages/contracts/src/letterhead.ts`, `packages/contracts/src/domain/settings.ts`,
  `services/identity/src/settings/brand-service.ts`, las plantillas de los seis imprimibles,
  `apps/web/src/components/print/MembreteDocumento.tsx`,
  `apps/web/src/components/config/MembreteSection.tsx`

## Contexto

El [ADR 0054](0054-membrete-unico-en-los-imprimibles.md) unificó el membrete sobre `brand.ts`, pero
la **presentación** se quedó en el código y cada plantilla la escribía por su cuenta:

- el **récipe** fijaba `.logo { height: 12mm }` a mano y **no** seguía `--brand-logo-height-mm`, así
  que el alto de logo del panel no tenía ningún efecto sobre él (el «no funciona» que abrió este
  ADR);
- el logo iba **arriba** del bloque (`align-items: flex-start`), no centrado respecto a la altura
  del membrete;
- no se podía dar al nombre del membrete una **tipografía propia** distinta de la de los títulos
  del documento;
- no se podía **elegir qué líneas** salen (dirección, RIF, teléfonos/correo, web, especialista) ni
  su **orden**;
- no había **pie** propio del membrete.

Y aunque el [ADR 0060](0060-configuracion-de-la-aplicacion.md) ya aplicaba la marca en caliente, la
marca se leía con una **caché de un minuto**: el administrador guardaba un cambio y el papel seguía
igual hasta un minuto después, lo que se lee como «no se aplicó».

## Decisión

**El membrete gana su propia subsección en el panel y un helper compartido; los documentos y la
pantalla lo componen del mismo sitio, y un cambio se ve en segundos sin reiniciar.**

### 1. El membrete es un dato configurable más (sin migración)

`brand_settings.letterhead` (JSONB) crece con: `logoAlign` (`left|center|right`, por defecto
`left`), `logoVerticalAlign` (`top|center|bottom`, por defecto **`center`**), `titleSans` /
`titleWeight` (**null** = la tipografía de los títulos del documento), `titlePt`, `linePt`,
`lines` (arreglo ordenado de `{ key, visible }` con `address|rif|contact|website|dentist`) y
`footer`. El **nombre**, el **RIF**, la **dirección**, los **teléfonos** y el **logo** siguen siendo
la identidad del consultorio ([ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md)):
aquí solo se decide cómo se **pinta**. Como la columna ya era JSONB, **no hay migración**; las filas
anteriores se completan con el respaldo al leer.

### 2. Un solo helper, `buildLetterheadView` / `letterheadHtml` / `letterheadCss`

`packages/contracts/src/letterhead.ts` compone el membrete (nombre, subtítulo opcional, líneas
visibles en orden y **sin las vacías**, y pie) y devuelve su HTML con las clases `.brand-lh*`, que
publica `letterheadCss()` en `brand.ts` leyendo las variables `--brand-lh-*` y
`--brand-logo-height-mm`. Las **seis** plantillas del servidor (récipe, dossier, reporte, factura,
recibo y nota de crédito) y el membrete de la **SPA** pasan por el mismo helper: era la deriva entre
copias lo que dejó al récipe con un alto de logo ajeno a la marca.

### 3. El logo va a la izquierda, **centrado en vertical**

`--brand-lh-logo-valign` (`center` por defecto) resuelve `align-items` de la fila; el logo queda a
media altura del bloque de datos, sea cual sea su altura. `--brand-lh-logo-align` mueve el bloque
horizontalmente. El **nombre** usa su tipografía propia (`--brand-lh-title-*`) y las **líneas** su
tamaño (`--brand-lh-line-pt`).

### 4. Se aplica en caliente, de verdad

El [ADR 0060](0060-configuracion-de-la-aplicacion.md) mantiene el principio «leer, no empujar»: los
servicios de documentos leen la marca por `/internal/v1/identity/brand`. Aquí solo se **acorta la
caché**: la marca pasa de 60 s a **1 s** (`createBrandLookup`) y el membrete —que lleva el logo y
los datos— a **5 s** en clinical, reporting y billing (`createLetterheadLookup`). El resto de
servicios (pantallas, agenda, bot) conservan el minuto: no componen papel. La SPA ya se actualiza al
instante porque el panel invalida la consulta al guardar.

## Consecuencias

- **A favor:** el récipe sigue la marca como todos los demás; el membrete es configurable (logo,
  tipografía del nombre, líneas y orden, pie, velo) con **vista previa en vivo** con los datos
  reales; un solo «Guardar» persiste marca y membrete; el cambio llega al papel en segundos.
- **En contra:** las plantillas cambian su membrete por el helper (menos CSS por plantilla) y
  **unifican tamaños**: el dossier y el reporte pasaban el nombre a 14 pt y la factura las líneas a
  9,5 pt; ahora todos arrancan del valor de la marca (nombre 12 pt, líneas 8 pt) y el consultorio lo
  sube si quiere. Es lo que se pidió —una sola palanca—, pero es un cambio visible de una vez.
- **Compatibilidad:** el récipe dejó de tener `.logo { height: 12mm }`; el membrete de la SPA dejó de
  llevar los Tailwind sueltos y toma las clases `.brand-lh`. Las aserciones de las pruebas se
  ajustaron (`class="brand-lh …"`, `brand-lh-logo`, `brand-lh-dentist`).
- **El velo y el logo siguen siendo el mismo dato:** la marca de agua usa el logo efectivo; el
  membrete solo cambia su ancho y su opacidad.
- **La tipografía del nombre viaja al papel:** identity incrusta el `@font-face` de la familia del
  **nombre del membrete** (además de las de títulos y cuerpo), y el papel —SPA y PDF del servidor—
  espera a que las fuentes carguen antes de imprimir. Sin lo primero, el nombre salía con la sans del
  sistema al imprimir aunque en pantalla se viera bien.
- **Datos incompletos:** `buildLetterheadView` descarta las líneas sin dato (incluida una dirección
  a medias, que produce `", "`), y `clinicContactLine` tolera un perfil sin `phones`: un membrete a
  medias nunca rompe un documento.
