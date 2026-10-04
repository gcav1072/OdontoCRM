# ADR 0031 — La pieza completa manda sobre las caras del odontograma

- **Fecha:** 2026-10-04 · **Estado:** **corregida por el [ADR 0032](0032-convivencia-de-tratamientos-con-las-caras.md)**
  (2026-10-04) · **Implementada:** fase 6, sesión B

> ⚠️ **Esta decisión se aplicó de más.** El reparto «superar en vez de borrar» sigue vigente y es
> correcto, pero solo para **`ausente`**: los tratamientos (`corona`, `implante`, `endodoncia`) y la
> `extraccion_indicada` **conviven** con las caras. Ver el
> [ADR 0032](0032-convivencia-de-tratamientos-con-las-caras.md), que es el que manda hoy. Lo que
> sigue describe el mecanismo de superación, que no cambió.

## Contexto

El odontograma guarda cada hallazgo como una fila con clave natural
`(pieza, cara, condición)` y **captura por excepción**: la pieza sana es la ausencia de
fila (`docs/implementation_plan_odontogram_microservice.md` §1 y §4).

El modelo del documento mezcla dos niveles en la misma pieza:

- condiciones **por cara**: caries y obturación (`surface` con valor);
- condiciones de **pieza completa**: ausente, extracción indicada, corona, implante y
  endodoncia (`surface` a `null`).

En la boca real eso ocurre: el 16 tiene una caries oclusal **y** al año siguiente se
extrae. Si las dos cosas conviven, la lectura del odontograma es contradictoria —la
pieza está ausente y a la vez tiene caries—, la vista impresa miente y los reportes de
salud bucal (Fase 9) cuentan caries en dientes que ya no existen.

Las alternativas eran tres:

1. **Prohibir** registrar una condición de pieza completa mientras haya caras: obliga a
   borrarlas una a una antes, y el dentista que marca «ausente» en la carga rápida por
   teclado (criterio de aceptación: la boca completa en < 30 s) tendría que parar a
   limpiar la pieza.
2. **Borrar** las caras al registrar la condición de pieza completa: el estado actual
   queda coherente, pero se pierde el dato clínico —que la caries existió— y el
   histórico solo lo conservaría como una fila huérfana.
3. **Superar** las caras: se conservan, marcadas como superadas, y dejan de leerse.

## Decisión

**Una condición de pieza completa supera las caras de esa pieza; no las borra.**

- Al registrar `ausente`, `extraccion_indicada`, `corona`, `implante` o `endodoncia` con
  `surface: null`, en la **misma transacción** se marca `resolved_at = now()` en todas
  las filas de cara vigentes de esa pieza.
- Una fila con `resolved_at` **no se lee**: `GET /patients/:id` devuelve solo las
  vigentes. El histórico (`tooth_finding_history`, append-only) guarda el cambio como
  `superado`, con quién y cuándo.
- La respuesta de la mutación devuelve `resolvedSurfaces` para que la interfaz lo diga en
  voz alta: «las caras marcadas de la pieza 16 se dieron por superadas por "ausente"».
- En sentido contrario **no se puede**: registrar una caries o una obturación en una pieza
  con condición de pieza completa vigente devuelve `409` con un mensaje que explica que
  primero hay que quitar esa condición. Así no se reintroduce la contradicción.
- La invariante vive también en la base (`chk_tooth_findings_scope`): una fila de cara
  nunca puede guardar una condición de pieza completa ni al revés.

## Consecuencias

- **A favor:** la carga rápida no se interrumpe (una tecla marca «ausente» y sigue), la
  lectura es siempre coherente, el dato clínico no se destruye y queda auditable. El
  borrado de verdad (`DELETE`) sigue existiendo para corregir un error de captura: con
  «dejar la cara sana», la pieza vuelve a estar sana de verdad.
- **En contra:** hay dos formas de que un hallazgo deje de verse (superado y eliminado) y
  la interfaz tiene que distinguirlas al mostrar la evolución; el término «superado» hay
  que explicarlo en la vista histórica (se hace con su etiqueta).
- **Quitar la condición de pieza completa no revive las caras superadas.** Restaurarlas sería
  adivinar qué había antes de la superación; el histórico ya dice qué se superó y cuándo, así que
  el odontólogo vuelve a marcarlas en un par de teclas si siguen existiendo clínicamente. En
  cambio, **volver a registrar una clave superada sí revive esa misma fila** (`resolved_at = null`):
  es el camino real «me equivoqué al marcar ausente, lo quito y vuelvo a marcar la caries» y el
  índice único de la clave natural no admite dos filas para el mismo hallazgo.
- Si algún día hace falta una corona **con** restauraciones (una corona sobre un diente
  obturado es lo normal en la boca real), este ADR tendrá que revisarse: hoy el modelo
  trata la corona como estado de la pieza completa y las caras quedan superadas.
