# ADR 0065 — El récipe cabe en la hoja: el papel de la clínica y un encaje medido

- **Fecha:** 2026-10-11 · **Estado:** aceptada
- **Relacionada:** [ADR 0015](0015-recipe-a5-en-pdf.md) (récipe en PDF del servidor),
  [ADR 0036](0036-recipe-emitido-documento-archivado.md) (el récipe emitido se archiva),
  [ADR 0055](0055-dos-tipografias-en-los-imprimibles.md) (tamaños en pt de la marca),
  [ADR 0060](0060-configuracion-de-la-aplicacion.md) (panel de configuración),
  [ADR 0061](0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md) (**superada** en el
  papel de la hoja)
- **Fuente de verdad en código:** `packages/contracts/src/brand.ts` (`recipePaperGeometry`),
  `packages/contracts/src/domain/settings.ts` (`recipePaper`),
  `services/clinical/src/prescriptions/prescription-document.ts` (el `@page` y la tipografía),
  `services/clinical/src/prescriptions/fit-to-page.ts` (el encaje medido),
  `services/clinical/src/prescriptions/pdf-renderer.ts` (`fitToPage`),
  `apps/web/src/components/config/MarcaSection.tsx` (el desplegable «Papel del récipe»)

## Contexto

El récipe salía en **una hoja carta apaisada** partida en dos mitades
([ADR 0061](0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md)) y, en el servidor de la
clínica, **la impresora sacaba una segunda hoja en blanco**: el récipe perfecto en la primera y una
hoja vacía detrás. Se probaron dos arreglos sobre la **altura de la hoja** (199 mm → 185 mm de altura
mínima) y una **escala de encaje** que la reducía a ciegas (1 → 0,94 → … → 0,7). Ninguno funcionó, y
el encaje dejó un efecto secundario visible: **la letra salía más pequeña** aunque la hoja siguiera
partiéndose.

Tres causas, ninguna de ellas la altura de la hoja:

1. **El papel no era el del consultorio.** El récipe era el **único** imprimible en carta: la
   historia clínica, el odontograma, el reporte, el dossier, la factura y el recibo salen en **A4**.
   Una hoja carta apaisada mide **215,9 mm de alto** y la A4 mide **210 mm**: el PDF no cabe en el
   papel, así que la impresora pagina la franja que sobra —que va en blanco, porque el contenido
   muere 8 mm antes del borde— a una segunda hoja. Ningún ajuste del contenido podía arreglarlo.
2. **El encaje no medía.** Probaba escalas fijas y contaba las hojas del PDF **ya compuesto**, y el
   tope (0,7) no bastaba para un récipe largo: el resultado era letra encogida *y* segunda hoja.
3. **El encaje, además, no escalaba la hoja.** Reducía el contenido, pero la hoja conservaba su
   altura mínima, así que la página seguía sin caber. Y medía el documento **en la ventana del
   navegador** (1 280 px), más ancha que el papel (263 mm): el texto se plegaba en menos renglones
   al medir que al imprimir, y la cuenta decía «cabe» donde el PDF veía «no cabe».

## Decisión

**El papel del récipe se configura (A4 de fábrica, el de los demás imprimibles) y el encaje se mide
en el navegador, con el ancho y el alto reales del área imprimible. La hoja entera se escala, así
que el récipe sale en una sola hoja, con la letra lo más grande que quepa y nunca por debajo del
tope de legibilidad.**

- **El papel** (`recipePaper`: `A4` | `letter`) vive en la marca y se elige en
  *Configuración → Marca → Papel del récipe*. El **mismo** valor decide el `@page` de la plantilla y
  el tamaño que se le pide a Chromium (`recipePaperGeometry`): una sola fuente, sin que el tamaño
  dependa de quién gane. De fábrica **A4**, el papel de los otros seis imprimibles —el que la clínica
  ya tiene en la bandeja, porque si fuera carta los demás documentos también dejarían hojas en
  blanco—. Una marca guardada antes de este ajuste sale en A4 sin migrar nada.
- **La tipografía del récipe sale del panel.** Los tres tamaños de *Configuración → Marca*
  (título, cuerpo y menudo: 13 / 9 / 7,5 pt de fábrica) alimentan la escala del documento; los
  tamaños intermedios son las proporciones que el récipe ya tenía sobre esos tres, así que con los
  valores de fábrica el papel sale **exactamente** como salía y mover uno de los tres mueve su
  familia entera. Antes los tamaños estaban escritos a mano en la plantilla y el panel no los movía.
- **El encaje mide.** `fit-to-page.ts` deja la escala en la que el bloque que debe caber (`.sheet`)
  cabe en el área imprimible: pone la ventana del navegador con el **tamaño del área imprimible**
  (para medir con el ancho del papel), mide el bloque a escala 1, calcula la proporción que sobra y
  la comprueba midiendo otra vez. **Nunca agranda** un récipe corto (escala 1) y **nunca baja** de
  0,7. La hoja entera —membrete, listas, tabla, firmas— se multiplica por esa escala, **incluida su
  altura mínima**: es lo que hace que la página quepa de verdad.
- **El tope es un límite, no un fallo.** Un récipe muy largo (≥ 11 medicamentos, medido con el
  Chromium real) no cabe sin dejar el texto ilegible: se compone a 0,7 y continúa en una segunda
  hoja **con contenido**. Lo que ya no ocurre **nunca** es la hoja en blanco.

## Consecuencias

- **A favor:** el récipe sale en **una hoja** —la copia de la farmacia y la del paciente, sin
  segunda hoja— hasta ~10 medicamentos, con la tipografía que el panel configura al pie de la letra
  (para los récipes normales, escala 1) y sin tocar la interfaz de quien lo llena.
- **A favor:** el consultorio dice con qué papel imprime; el sistema no lo adivina. Y si la clínica
  cambia de bandeja, se cambia en el panel: no hace falta un despliegue.
- **A favor:** la medida es del navegador de verdad (Chromium), no de una tabla de milímetros: si la
  versión de Chromium, el DPI o la fuente del sistema cambian, la cuenta sigue siendo la correcta.
  El caso se cubre con la prueba de integración (el PDF emitido se cuenta: **una hoja**) y con el
  humo `smoke:prescription`.
- **En contra / a vigilar:** un récipe **muy** largo sigue ocupando una segunda hoja (legible, con
  contenido). Bajar el tope de 0,7 lo metería en una hoja a costa de imprimir a 5–6 pt.
- **Documentación:** el [ADR 0061](0061-recipe-en-dos-mitades-y-especialista-en-el-membrete.md)
  queda **superado en el papel de la hoja** (carta apaisada → A4 apaisado configurable); sigue
  vigente en el resto (las dos mitades, el especialista en el membrete, la línea para cortar).
