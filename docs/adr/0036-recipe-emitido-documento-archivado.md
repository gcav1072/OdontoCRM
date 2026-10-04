# ADR 0036 — El récipe emitido es un documento archivado

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** fase 7, sesión B (2026-10-04)

## Contexto

El [ADR 0015](0015-recipe-a5-en-pdf.md) decidió que el récipe sale en **A5 con membrete,
numerado y verificable por QR**. Al implementarlo aparecieron las preguntas que la decisión
no cerraba, y todas son de la misma familia: **qué pasa cuando algo cambia después de
imprimir**.

1. El paciente corrige su nombre o su cédula: ¿el récipe emitido cambia con él?
2. Se retira o se corrige un medicamento del catálogo: ¿cambian los récipes ya entregados?
3. El doctor se equivoca en la dosis y ya entregó el papel: ¿se edita, se borra?
4. Alguien escanea el QR de un récipe que después se anuló: ¿qué tiene que leer?

## Decisión

**Emitir convierte el récipe en un documento cerrado.** A partir de ahí:

- Se guarda una **copia de los datos del paciente** tal como se imprimieron (`patient_snapshot`:
  nombre, documento, fecha de nacimiento y edad). Si mañana corrige su ficha, el récipe sigue
  diciendo lo que decía.
- Se guarda una **copia del medicamento** en cada línea (nombre, presentación, vía, dosis,
  frecuencia, duración, indicaciones y cantidad). Editar el catálogo **no** reescribe lo
  entregado: el catálogo es una ayuda para escribir, no una fuente que se consulte al imprimir.
- El **PDF A5 se genera una vez y se archiva** (en el almacén del servicio, con su `sha256`).
  Lo que se descarga o se imprime después es **ese** archivo, no una nueva composición: el papel
  que tiene el paciente y el que guarda el consultorio son el mismo byte a byte.
- El número sale de una **secuencia** (`RX-000001`) y el estado `emitida` no se puede repetir:
  el `CHECK` de la tabla exige número, código y PDF para estar emitida, y la emisión solo avanza
  desde `borrador` (dos peticiones simultáneas no comparten número).
- Un récipe emitido **nunca se borra**: se **anula** con motivo, y el PDF se conserva. El código
  de verificación sigue respondiendo, pero dice «anulada»: quien tenga el papel en la mano se
  entera de que ya no vale.
- **Toda descarga o impresión** deja constancia (`print_count`, `last_printed_at` y el evento
  `clinical.prescription.reprinted` con su actor): reimprimir es un acto, no un detalle.
- El borrador es **uno por sesión** (índice único parcial) y solo bloquea preparar otro cuando el
  anterior sigue **vigente**: si se anuló, esa misma visita puede llevar su récipe corregido.
- El código del QR es de 10 caracteres en un alfabeto **sin letras ni números que se confunden**
  al dictarlos (0/O, 1/I/L) y se acepta con guion, sin guion y en minúsculas: el que lo lee por
  teléfono no tiene que adivinar.

## Consecuencias

- **A favor:** el récipe es un documento legal coherente —lo que dice el papel es lo que dice la
  base, y sigue diciéndolo dentro de diez años—; la verificación pública distingue «auténtico» de
  «anulado» sin exponer datos clínicos; y el catálogo se puede mantener sin miedo a reescribir
  historia.
- **En contra / a vigilar:** los huecos de numeración que deja un fallo al generar el PDF son
  **aceptados** (como en cualquier numeración de documentos): el número se toma antes de
  renderizar, y si Chromium falla ese número no se reutiliza. Si algún día la numeración tiene que
  ser sin huecos, habría que mover la reserva del número a la misma transacción que la emisión y
  renderizar el PDF antes de abrir la transacción (con el número ya reservado).
- El PDF archivado **ocupa disco para siempre**: un récipe A5 ronda los 60 KB, así que el
  crecimiento es despreciable, pero el respaldo del almacén entra en el mismo plan que el de la
  base (Fase 10).
- **Chromium es una dependencia de verdad**: el servicio lo levanta una vez y lo reutiliza. Si no
  arranca, la emisión responde 500 y **no** queda un récipe a medias (el PDF se genera antes de
  tocar la base y, si algo falla después, el archivo se borra). El repliegue sigue siendo
  `pdfmake`, como decía el ADR 0015.
