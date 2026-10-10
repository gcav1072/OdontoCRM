# ADR 0063 — Las fuentes de los imprimibles se eligen por rol en el panel

- **Fecha:** 2026-10-10
- **Estado:** aceptada
- **Relacionada:** [ADR 0055 — Los imprimibles tienen dos tipografías](0055-dos-tipografias-en-los-imprimibles.md);
  [ADR 0060 — Configuración de la aplicación](0060-configuracion-de-la-aplicacion.md)
- **Fuente de verdad en código:** `packages/contracts/src/brand.ts`,
  `packages/contracts/src/domain/settings.ts`, `services/identity/src/settings/brand-service.ts`,
  `apps/web/src/components/config/MarcaSection.tsx`

## Contexto

El [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md) dejó los imprimibles con dos
tipografías —títulos y cuerpo— pero el panel de configuración
([ADR 0060](0060-configuracion-de-la-aplicacion.md)) las editaba como **texto libre**: el
administrador tenía que escribir a mano la pila CSS (`'Montserrat', 'Segoe UI', …`) y no había
forma de saber qué familias estaban de verdad instaladas. Además la marca guardaba **una sola
familia** (`fonts.family`) que se aplicaba a todos los archivos, así que título y cuerpo no podían
usar familias distintas aunque las pilas lo sugirieran. El peso de los títulos estaba **fijado a
700** en cada plantilla, sin poder cambiarlo desde el panel.

Esto hacía la marca frágil: un error tipográfico en la pila dejaba el papel con la fuente del
sistema, y no había vista previa que lo delatara.

## Decisión

### 1. Varias familias, no una

`BRAND.fonts` pasa de `{ family, files }` a `{ families: [{ name, files }] }`. Cada familia lleva
su **nombre** (el del `@font-face`) y sus archivos con peso y estilo. El **catálogo de fábrica**
vive en el código: tres **sans** (Montserrat, Inter, Poppins) y tres **script** (Lobster, Pacifico,
Dancing Script), todas OFL, auto-hospedadas en `assets/clinic/fonts/` con la convención
`<familia>-latin-<peso>-normal.woff2`. Las subidas por el administrador conviven con el catálogo.

### 2. Selección por rol, con desplegable y vista previa

El panel ofrece, para **títulos** y para **cuerpo** por separado, un **desplegable de familia** y un
**desplegable de peso** (solo los pesos con archivo en esa familia), más una **línea de vista previa**
que se dibuja al instante. Elegir familia escribe `fontStackFor(familia)` en la pila; un bloque
**avanzado** deja editar la pila a mano (si la pila no es ninguna familia declarada, el desplegable
muestra «Personalizada»).

La pila sigue siendo el **campo de registro** (`documentTitleSans` / `documentBodySans`): la familia
elegida se **deriva** de su primer nombre, sin campos nuevos de familia en la tipografía.

### 3. Peso por rol

`documentTitleWeight` / `documentBodyWeight` se añaden a la tipografía y se publican como
`--brand-font-doc-title-weight` / `--brand-font-doc-body-weight`. Las plantillas dejan de fijar
`font-weight: 700` a mano y usan la variable. Son las variables `--brand-*` **23 → 25**.

### 4. Subida con familia

`POST /api/v1/settings/brand/fonts` recibe ahora el campo `family` (además de `weight` y `style`).
La clave del almacén pasa a `identity/brand/fonts/<familiaNormalizada>-<peso>-<estilo>.woff2`, así
que dos familias con el mismo peso/estilo ya no colisionan. Quitar el último archivo de una familia
subida **descarta la familia**; las del catálogo no se pueden quitar.

### 5. Qué se incrusta y qué sale por la web

El `themeCss` que sirve identity **solo resuelve las familias referenciadas** por las pilas (evita
inflar cada `GET /settings` con los `data:` URI de todo el catálogo). El **catálogo** se previsualiza
al instante porque la SPA lo declara al arrancar (`import.meta.glob`, como el logo); las familias
**subidas** se previsualizan tras **Guardar** (viajan en `themeCss`).

## Consecuencias

- **A favor:** el administrador elige la tipografía de cada rol de una **lista de lo instalado**, con
  vista previa; título y cuerpo pueden usar familias distintas; el peso de los títulos es de la
  marca, no del código; se pueden subir familias nuevas.
- **En contra:** el modelo de datos cambia (`fonts.families`) y hay una **migración de datos**
  (`0006`, envuelve `{ family, files }` en `families`); las plantillas de los seis imprimibles usan
  la variable de peso; el catálogo suma `.woff2` al repositorio (baratos: Vite copia por URL, solo se
  incrustan los referenciados).
- **Compatibilidad:** las filas antiguas y los PUT sin los pesos nuevos se normalizan en identity
  (`{ family, files }` → `families`, pesos por defecto 700/400); no se pierde ninguna marca guardada.
- **Consistencia:** la pila no deja de ser el campo guardado, así que el modo «Avanzado» sigue
  funcionando y una pila personalizada no rompe el documento (cae en el respaldo del sistema).
