# ADR 0033 — El odontograma se dibuja en posición anatómica

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** fase 6, sesión B (2026-10-04)

## Contexto

El odontograma se pinta como **dos filas** con la línea media en el centro
(`18 … 11 | 21 … 28` arriba y `48 … 41 | 31 … 38` abajo), que es como lo lee el
odontólogo mirando al paciente. Eso obliga a decidir cómo se orienta **cada pieza**
dentro de su cuadro de 100×100, y las tres decisiones son fáciles de equivocar
porque el error no rompe nada: simplemente registra la caries en la cara que no es.

Los cuatro ejes:

1. **Arriba/abajo (vestibular ↔ lingual/palatino).** En el maxilar la cara externa
   mira hacia arriba; en la mandíbula, hacia abajo.
2. **Izquierda/derecha (mesial ↔ distal).** La cara mesial es la que mira a la
   **línea media**. Como la línea media está en el centro de la fila, en las piezas
   de la derecha del paciente la mesial queda a la **derecha** de la pantalla y en
   las de la izquierda, a la izquierda.
3. **El número de pieza** tiene que leerse siempre derecho, aunque la pieza esté
   volteada.
4. **El nombre de la cara de masticación** cambia según el diente: en incisivos y
   caninos no hay cara oclusal ancha, hay **borde incisal**.

## Decisión

**El dibujo es posición anatómica y las transformaciones salen del contrato**, no de
cada componente:

- `archLayout` marca cada pieza con `flipped` (mandíbula) y `mirrorX` (derecha del
  paciente: cuadrantes 1 y 4; 5 y 8 en la temporal) — `isPatientRightQuadrant`.
- `toothGroupTransform({flipped, mirrorX})` da **la** transformación SVG que aplican
  los dos renderizadores (pantalla y papel) y `unscreenPoint(x, y, …)` da su
  **inversa**, que es la que usa el `hit-test` del clic. Dibujo y clic comparten la
  misma fuente de verdad: si se separan, se registra la cara contraria.
- El número de pieza se dibuja **fuera** del grupo transformado (nunca se espeja ni
  se voltea) y con aire suficiente respecto al cuadro.
- `surfaceLabelFor(pieza, cara)` nombra la cara **con la pieza delante**: `Incisal`
  en las posiciones 1–3 del cuadrante (canino a incisivo central), `Oclusal` en el
  resto. El dato guardado sigue siendo `occlusal` —el polígono es el mismo y no hay
  migración—: lo que cambia es cómo se llama en la interfaz, en la tabla impresa y en
  las etiquetas accesibles.
- Cada arcada lleva su nota de orientación, en pantalla y en el papel
  («Maxilar · vestibular arriba · palatino abajo · mesial hacia la línea media»;
  «Mandíbula · lingual arriba · vestibular abajo · …»), para que nadie tenga que
  deducirla.

## Consecuencias

- **A favor:** el esquema coincide con la boca: la mesial toca al vecino que es, la
  vestibular mira donde debe y el borde incisal se llama como se llama en la historia
  clínica. La prueba que lo protege es clínica, no geométrica: *la cara que se pulsa
  es la que se ve* —en el 16 la mesial está a la derecha de la pantalla; en el 26, a
  la izquierda; en el 46, además, la vestibular abajo.
- **En contra / a vigilar:** `mirrorX` cambia el **significado** de mesial y distal
  respecto a cualquier dato cargado con el criterio anterior en las piezas 11–18 y
  41–48. No hay datos en producción (la fase termina sin clínica real), pero si algún
  día se importa una boca ya registrada con el criterio viejo, hay que revisar esas
  dos caras en esos dos cuadrantes.
- Romper esto no da error de compilación ni de tipos: solo se ve mirando. Las pruebas
  de `odontogram.test.ts` (clic) y `document.test.ts` (papel) cubren los cuatro ejes,
  y la captura del gráfico es parte de la revisión de la fase.
