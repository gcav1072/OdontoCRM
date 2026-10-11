# ADR 0061 — El récipe sale en dos mitades (farmacia y paciente) y el especialista va en el membrete

- **Fecha:** 2026-10-10 · **Estado:** aceptada (**el papel de la hoja superado por
  [ADR 0065](0065-el-recipe-cabe-en-el-papel-de-la-clinica.md)**)
- **Relacionada:** [ADR 0015](0015-recipe-a5-en-pdf.md) (récipe en PDF; **sustituye la A5 de una
  cara**), [ADR 0036](0036-recipe-emitido-documento-archivado.md) (el récipe emitido se archiva),
  [ADR 0054](0054-membrete-unico-en-los-imprimibles.md) (membrete único),
  [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) (identidad en la base)

> **Nota (ADR 0065).** El **fondo** de esta decisión sigue vigente: el récipe sale en **una hoja
> apaisada partida en dos mitades** (farmacia y paciente), con el especialista en el membrete. Lo
> que cambió es el **papel**: se compone en el **papel de la clínica** —**carta** de fábrica, elegible
> en el panel (`recipePaper`)— con un **encaje medido** que garantiza una sola hoja.

## Contexto

El récipe salía en **A5 de una cara**, con una sola copia: la que se entregaba al paciente. La
farmacia no tenía su propio papel, así que el mostrador recortaba o reimprimía a mano. Además, los
datos del **especialista** que responde por el documento (Odontólogo · Especialidad · MPPS ·
Colegiatura) se imprimían **debajo de la firma**, en un renglón diminuto al pie: el primer sitio que
se pierde cuando el papel se recorta, y el último que mira quien coteja el documento.

Los imprimibles tenían, además, dos huecos de coherencia: el **reporte** y los documentos de **cobro**
(factura, recibo, nota de crédito) llevaban membrete pero **no** el odontólogo que responde; la
**historia clínica** y el **odontograma** que imprime el navegador tampoco.

## Decisión

**1. El récipe sale en una hoja carta apaisada, partida en dos mitades verticales.**

- **Mitad izquierda — copia de la farmacia:** por medicamento, **Medicamento** (negrita y
  subrayado), **Presentación**, **Vía** y **Dosis** —lo que se dispensa—, más la identificación del
  paciente, el número y la fecha del récipe y el **código de verificación** como texto. **No lleva
  QR**: el código lo teclea quien lo necesite.
- **Mitad derecha — copia del paciente:** el layout de siempre (tabla Medicamento · Dosis ·
  Frecuencia con sus detalles, indicaciones generales), y el **QR** de verificación.
- **Las dos mitades llevan membrete y firma propios**, separadas por una **línea discontinua** para
  cortar o doblar: cada mitad se puede desprender y sigue siendo un documento con su identidad.
- La **UI no cambia**: los mismos datos que ya se llenan alimentan las dos caras. La copia de la
  farmacia **omite** la frecuencia/duración y las indicaciones por medicamento (son posología, no
  dispensación); si la farmacia las necesita, se añaden sin tocar la interfaz.

**2. Los datos del especialista van al membrete, debajo de la dirección y el teléfono.**

- Se imprimen los cuatro campos en una línea: «Od. María Gómez · Endodoncia · MPPS 12345 ·
  Colegiatura 6789», **solo lo que esté lleno**. El prefijo «MPPS» no se repite si el número ya lo
  trae. El ayudante `clinicDentistLine()` es la única fuente de ese renglón.
- Bajo la **línea de firma** queda solo el **nombre** del odontólogo (se quitó el detalle que
  estaba allí).
- Se aplica a **todos** los imprimibles: récipe y dossier (servidor), reporte (servidor), factura,
  recibo y nota de crédito (servidor), historia clínica y odontograma (navegador).
- Quién aparece: en el récipe y el dossier, el **usuario que emite** (respaldo: el titular); en el
  reporte, los cobros y los imprimibles del navegador, el **titular** del consultorio.

## Consecuencias

- **A favor:** la farmacia y el paciente tienen cada uno su papel en la misma hoja; el especialista
  —el dato que da validez— deja de estar al pie, donde se pierde, y sale igual en los siete
  imprimibles; y el membrete se vuelve el único sitio donde vive la identidad impresa del documento.
- **A favor:** el papel pasa de A5 a **una hoja apaisada** con dos mitades, un formato que cualquier
  impresora de consultorio maneja y que no obliga a cambiar la bandeja (el **tamaño** de esa hoja lo
  fija hoy el [ADR 0065](0065-el-recipe-cabe-en-el-papel-de-la-clinica.md): **carta** apaisada de
  fábrica).
- **En contra / a vigilar:** la firma se ancla al pie de cada mitad (altura holgada de la hoja); con
  un récipe **muy** largo la mitad puede continuar en una segunda página. Lo que ya no ocurre es la
  segunda hoja **en blanco**: el [ADR 0065](0065-el-recipe-cabe-en-el-papel-de-la-clinica.md) mide el
  documento y lo encaja en una sola hoja hasta ~10 medicamentos.
- **En contra / a vigilar:** los récipes **ya emitidos** conservan su A5 archivado
  ([ADR 0036](0036-recipe-emitido-documento-archivado.md)); el layout nuevo aplica a los que se
  emitan desde ahora. En los cobros, «el especialista» es el titular: la caja no emite como
  odontólogo. Excluir los cobros es quitar una línea por plantilla si el consultorio lo prefiere.
- **Documentación:** el [ADR 0015](0015-recipe-a5-en-pdf.md) queda **superado en la forma**
  (tamaño y caras); sigue vigente en el fondo (PDF del servidor, numeración, QR y verificación).
