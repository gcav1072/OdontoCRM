# ADR 0051 — El odontograma admite dentición mixta

- **Fecha:** 2026-10-07 · **Estado:** aceptada
- **Relacionada:** [ADR 0033](0033-odontograma-en-posicion-anatomica.md) — la posición anatómica y
  `archLayout`; [ADR 0031](0031-odontograma-pieza-completa-sobre-caras.md) /
  [ADR 0032](0032-convivencia-de-tratamientos-con-las-caras.md) — las reglas de las condiciones.

## Contexto

El odontograma nació con **una sola dentición por paciente** (`odontograms.dentition`,
`'permanente' | 'temporal'`), y esa dentición **se fijaba con el primer hallazgo**: el
servidor la deducía del número FDI (cuadrantes 1–4 permanentes, 5–8 temporales) y no
volvía a tocarla ([`chart-service.ts`](../../services/odontogram/src/odontogram/chart-service.ts),
`ensureOdontogram`). La arcada se dibuja a partir de ella: `archLayout` devuelve **una**
arcada, de 32 piezas si es permanente y de 20 si es temporal.

Eso funciona mientras el paciente es de una sola dentición, pero **no cubre la dentición
mixta**, que es la boca normal de un niño de unos 6 a 12 años: los incisivos y caninos
permanentes ya erupcionaron, los molares permanentes también, y **quedan molares
temporales** esperando su recambio. Las dos denticiones conviven en la misma boca.

Hoy eso se rompe en dos sitios:

1. **El dato queda cojo.** Si el primer hallazgo registrado es temporal, el odontograma se
   fija como `temporal` **para siempre**; registrar después una pieza permanente (el 16
   que acaba de erupcionar) no cambia la dentición. Y al revés. No hay ningún valor que
   diga «las dos».
2. **El gráfico no dibuja la pieza.** `archLayout` trae las piezas de una sola dentición y
   los renderizadores (`OdontogramChart`, `OdontogramStaticChart`) recorren esa lista
   buscando los hallazgos de cada pieza. Un hallazgo cuya pieza **no está en la lista** se
   guarda y sale en la tabla de hallazgos —y en el papel—, pero **no aparece en el
   diagrama**. El odontólogo ve una boca a la que le falta lo que acaba de marcar.

No hay datos en producción (la Fase 6 terminó sin clínica real), así que se puede corregir
el modelo sin migrar bocas ya capturadas.

## Decisión

1. **`DENTITIONS` gana `'mixta'`.** El odontograma puede declarar que tiene las dos
   denticiones, y pasa a ser un valor más del contrato (`Dentition`).

2. **La dentición deja de ser un sello del primer hallazgo y pasa a ser estado derivado.**
   Se **recalcula en cada escritura** a partir de los hallazgos **vigentes** (los que no
   están superados):
   - solo permanentes → `permanente`;
   - solo temporales → `temporal`;
   - de las dos → **`mixta`**;
   - sin hallazgos → se conserva el valor por defecto (`permanente`).

   La dentición es un **estado clínico**, no una estampa: el paciente que erupciona su
   primer molar permanente **cambia** de dentición ese día, y el odontograma tiene que
   seguirle. Por eso el recálculo va **dentro de la misma transacción** que escribe el
   hallazgo, en `recordFinding`, `recordFindingsBatch`, `deleteFinding` y `clearSurface`.

3. **`archLayout('mixta')` dibuja la boca mixta en tres capas**, con la huella de la
   arcada **permanente** como referencia:
   - la arcada **principal** (permanente, 8 posiciones por cuadrante) — la de siempre;
   - dos arcadas **primarias** (`upperPrimary` y `lowerPrimary`), con las piezas temporales
     colocadas **en la ranura de su sucesor permanente**, es decir, alineadas bajo la pieza
     que va a reemplazarlas.

   La relación temporal → permanente es **una función del contrato**, `primarySuccessor`
   (mismo cuadrante menos 4, misma posición: `51 → 11`, `54 → 14`, `55 → 15`, `85 → 45`),
   porque expresa la anatomía del recambio: el primer molar temporal cae donde entra el
   primer premolar. Al colocar la pieza temporal en la ranura de su sucesor, la arcada
   mixta se lee como la transición que es —y las piezas 6–8 de la arcada principal, que no
   tienen predecesor temporal, quedan siempre permanentes—.

   El contrato expone las arcadas primarias **aparte** (`upperPrimary`, `lowerPrimary`) en
   vez de mezclarlas con `upper`/`lower`: así los renderizadores dibujan **una banda más**
   sin geometría nueva —reutilizan el mismo componente de arcada— y ninguna pieza comparte
   ranura con otra.

4. **Los dos renderizadores dibujan las bandas primarias cuando las hay** (vacías en las
   otras denticiones), con su pie de arcada («Maxilar · dentición temporal»), para que el
   papel y la pantalla digan cuál es cuál. La leyenda y el resumen cuentan las piezas de
   las dos.

5. **`odontogramSummary` cuenta lo que se dibuja**: `teeth` es la suma de las bandas
   presentes —32 en permanente, 20 en temporal y **52 en mixta**—, no «una u otra».

## Consecuencias

- **A favor:** la boca mixta se ve entera y se registra sin perder nada; el odontograma
  sigue al paciente cuando erupciona o cuando se corrige una captura (el recálculo es
  sobre los hallazgos vigentes, así que borrar el hallazgo permanente devuelve la
  dentición a `temporal`); el diagrama y la tabla dejan de discrepar. Y no hay geometría
  nueva: la arcada primaria reutiliza el componente de siempre, con la misma
  transformación anatómica del ADR 0033.
- **Migración:** el `CHECK` de `odontograms.dentition` tiene que admitir `'mixta'`. Es un
  `DROP CONSTRAINT` + `ADD CONSTRAINT` y no toca ninguna fila, porque ninguna instalación
  tiene datos clínicos reales. El resto es código.
- **El recálculo es derivado, no una segunda verdad:** no se añade una columna ni un
  contador; la dentición se **calcula** de los hallazgos. Una escritura que no cambia la
  dentición no escribe de más.
- **El evento conserva la dentición del contexto** (la que había al registrar el hallazgo):
  es la foto del momento, que es lo que la auditoría quiere, aunque el odontograma pase a
  `mixta` en esa misma operación.
- **A vigilar:** la dentición deja de ser inmutable, así que cualquier consumidor que
  asumiera «una vez fijada, no cambia» (el seed, el humo) tiene que derivarla también. El
  seed siembra la dentición por edad y **no** la deriva de los hallazgos, así que un
  paciente sembrado como temporal con una pieza permanente quedaría inconsistente: se
  corrige el seed para que derive la dentición de lo que inserta.

## Alternativas descartadas

- **Mantener una sola dentición y «arreglar» el gráfico dibujando también las piezas
  sueltas de la otra dentición, sin declarar `mixta`:** deja el dato mintiendo (el
  odontograma dice `temporal` y enseña permanentes) y no hay dónde decir «esta boca es
  mixta» cuando lo pregunte un reporte. El estado tiene que existir.
- **Superponer la pieza temporal y su sucesor permanente en la misma ranura (dos bandas
  dentro de la misma fila):** exige geometría nueva —escala, desplazamiento vertical,
  alto de lienzo variable— y vuelve a mezclar dos cosas distintas en un mismo dibujo. Dos
  bandas separadas se leen mejor y reutilizan lo que ya hay.
- **Sustituir la ranura permanente por la temporal cuando la temporal está presente:** el
  odontograma no guarda «qué pieza está presente» (se captura **por excepción**: la pieza
  sana es la ausencia de fila), así que no hay forma de saber si una temporal sin hallazgos
  sigue en boca. Inventaría un dato que el modelo no tiene.
- **Una cuarta dentición `'sin_dientes'` o similar:** fuera de alcance; la boca vacía ya se
  representa con todas las piezas `ausente`.
