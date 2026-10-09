# Reglas clínicas del odontograma

- **Módulo:** OdontoCRM · Odontograma (dominio clínico)
- **Anexo a:** [ADR 0032 — Los tratamientos conviven con las caras](adr/0032-convivencia-de-tratamientos-con-las-caras.md)
- **Versión:** 1.0 · **Fecha:** 2026-10-09
- **Fuente de verdad en código:** `packages/contracts/src/domain/odontogram.ts`

Este documento fija **qué estados clínicos son válidos**, **qué condiciones pueden convivir** en una
misma pieza y **cómo evolucionan** con las citas del paciente. Es la referencia para el validador de
comandos, las mutaciones de la base y el dibujo. Se escribió a raíz de un fallo real: la **pieza 13**
quedó registrada con `extraccion_indicada` **completada** y `implante` **completado**, una
combinación imposible que el modelo antiguo admitía.

> **Nomenclatura.** El código llama **`restauracion`** a lo que en clínica es la **obturación**, y
> representa el «superado» con la columna **`resolved_at`** más una entrada en
> `tooth_finding_history` (no hay `superseded_at`/`superseded_by`). El resto de nombres coinciden con
> este documento.

## 1. Ejes ontológicos

El fallo de la pieza 13 vino de colapsar en un mismo tipo de dato condiciones que pertenecen a
categorías semánticas distintas. El dominio se descompone en **tres ejes independientes**:

**Eje temporal / semántico**

| Categoría | Qué es | Condiciones |
| :--- | :--- | :--- |
| Patología activa | Hecho biológico negativo que pide intervención | `caries` |
| Plan / prescripción | Lo que se va a hacer | `extraccion_indicada` |
| Estado anatómico / terapéutico | Condición física ya ejecutada o preexistente | `restauracion`, `ausente`, `corona`, `endodoncia`, `implante` |

**Eje anatómico estructural**

- **Coronal** (lo que se ve en boca): caras anatómicas, corona biológica o protésica, o su ausencia.
- **Radicular / soporte** (lo anclado en hueso): raíz biológica (sana o endodonciada) o implante de
  titanio.

**Eje de alcance**

- **Superficial:** afecta a caras concretas (`vestibular`, `lingual`, `occlusal` —o incisal—, `mesial`,
  `distal`).
- **Pieza completa** (`surface: null`): afecta a toda la corona y/o a la raíz.

## 2. Catálogo de condiciones y estados válidos

No todas las condiciones admiten `pendiente` y `completado`. Permitir un estado imposible corrompe
la base.

| Condición | Tipo de entidad | ¿`pendiente` (rojo)? | ¿`completado` (azul)? | Justificación clínica |
| :--- | :--- | :---: | :---: | :--- |
| `caries` | Patología activa | **Sí** | **No** | Una caries no se «completa»: se elimina el tejido y se sustituye por una obturación (`obturar`). |
| `restauracion` | Tratamiento restaurador | **Sí** | **Sí** | Pendiente: empaste indicado o recambio. Completado: restauración existente en buen estado. |
| `ausente` | Estado anatómico | **No** | **Sí** | Hecho consumado: la pieza no está. La «ausencia futura» se llama `extraccion_indicada`. |
| `extraccion_indicada` | Prescripción / plan | **Sí** | **No** | Es un procedimiento por realizar; al cumplirse, la pieza pasa a `ausente`. |
| `corona` | Prótesis coronal | **Sí** | **Sí** | Pendiente: por fabricar o cementar. Completado: instalada y adaptada. |
| `endodoncia` | Terapéutica radicular | **Sí** | **Sí** | Pendiente: conducto infectado/indicado. Completado: obturado tridimensionalmente. |
| `implante` | Terapéutica radicular | **Sí** | **Sí** | Pendiente: fase quirúrgica indicada. Completado: titanio osteointegrado. |

En código: `allowedStatesFor(condition)` y `isStateAllowed(condition, state)`.

## 3. Matriz de convivencia (pieza completa)

Qué condiciones pueden estar **vigentes a la vez** en la misma pieza.

| Existente ↓ / Nueva → | `ausente` | `extraccion_indicada` | `corona` | `endodoncia` | `implante` | Caras (cara a cara) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `ausente` | — | ❌ | ❌ | ❌ | ✅ (fase quirúrgica) | ❌ excluidas |
| `extraccion_indicada` | ❌ | — | ✅ (corona fallida) | ✅ (endodoncia fallida) | ❌ | ✅ |
| `corona` | ❌ | ✅ | — | ✅ (post-endodoncia) | ✅ (fase rehabilitada) | ✅ superadas al ponerla |
| `endodoncia` | ❌ | ✅ | ✅ | — | ❌ | ✅ |
| `implante` | ✅ | ❌ | ✅ | ❌ | — | ❌ excluidas |

**Reglas de exclusión:**

- **`implante` × `extraccion_indicada` — incompatibilidad absoluta.** Un implante no se «extrae» (no
  es un diente natural): si falla, es un explante. La coexistencia de ambos en la pieza 13 fue la
  causa raíz del fallo.
- **`implante` × `endodoncia` — incompatibilidad absoluta.** El titanio no tiene conducto pulpar,
  cámara ni ápice biológico.
- **`ausente` × `extraccion_indicada` — incompatibilidad absoluta.** No se prescribe la extracción de
  una estructura que ya no está en boca.
- **`ausente` × `corona` — incompatibilidad.** Una corona protésica no flota en el vacío: o hay
  soporte radicular (corona + implante) o es el póntico de un puente.
- **`implante` × caras — exclusión.** El implante no conserva caras naturales.

En código: `WHOLE_TOOTH_RULES[*].incompatibleWith`, `conditionsConflict(a, b)` (simétrica, para lotes)
y `recordingConflicts(existing, next)` (direccional, para registrar).

## 4. Precedencia y manejo de caras

### 4.1 `ausente`

- **Anula cualquier cara.** Al registrarlo, las caras vigentes quedan con `resolved_at` y su entrada
  `superado` en el histórico (no se borran), y dejan de leerse.
- **En el dibujo** el aspa domina la casilla y ningún polígono de cara conserva color.

### 4.2 `corona` (`supersedesSurfaces: true`)

- **Oculta las caras biológicas previas** en el dibujo, pero **preserva la historia** (el dato queda
  con `resolved_at`).
- **Excepción activa:** una **caries recurrente / filtración marginal** diagnosticada *después* se
  registra sobre la cara concreta (habitualmente vestibular o interproximal) y **se pinta en rojo**
  sobre el gráfico. La superación solo mira lo que había al poner la corona.

### 4.3 `extraccion_indicada`

- **No supera las caras; convive con ellas.** Una pieza con indicación de exodoncia suele tener
  caries profundas o restauraciones desbordantes: las caras siguen viéndose y el aspa punteada roja
  se superpone.

### 4.4 `implante`

- **Supera y excluye las caras.** Al registrarlo, las caras previas quedan superadas y no se admite
  una caries sobre el titanio.
- **Cede el aspa de `ausente`:** en la fase quirúrgica (`ausente` + `implante`) el dibujo pinta solo
  el tornillo.

## 5. Ciclo de vida y transiciones

Los estados no son estáticos; evolucionan con las citas:

```
[ Caries (pendiente) ]        ──(Obturar)──▶  [ Obturación (completado) ]
[ Extracción indicada ]       ──(Extraer)──▶  [ Ausente (completado) ]
[ Ausente ] ──(Cirugía)──▶ [ Ausente + Implante ] ──(Rehabilitar)──▶ [ Corona + Implante ]
```

El comando `completeProcedure` (`POST /api/v1/odontogram/patients/:patientId/procedures`) las aplica
en **una sola transacción**: resuelve el hallazgo de origen (con su entrada `resuelto` en el
histórico) e inserta el destino con `applyFinding`.

| Procedimiento | Origen | Destino | Requisito |
| :--- | :--- | :--- | :--- |
| `obturar` | `caries` (una cara, o **todas** las de la pieza) | `restauracion` (completado), misma cara | — |
| `extraer` | `extraccion_indicada` | `ausente` (completado) | — |
| `rehabilitar` | `ausente` | `corona` (completado) | **implante vigente** |

**Transición de exodoncia:** al extraer, `extraccion_indicada` se resuelve, se inserta `ausente`
(completado), las caras preexistentes pasan a superadas y la corona/el conducto que hubiera caen con
el diente.

**Fase quirúrgica → protésica:** sobre el `implante`, `rehabilitar` resuelve el `ausente` e inserta
`corona` (completado); el `implante` se preserva.

**Resolución de caries:** `obturar` resuelve la `caries` de la cara e inserta `restauracion`
(completado) en la **misma** cara.

La carga rápida por teclado (`quickEntryKey`) **clampea** la caja al estado válido: `c`/`C` (caries) y
`x`/`X` (extracción) registran siempre `pendiente`; `a`/`A` (ausente) siempre `completado`.

## 6. Renderizado por capas

Cuando varias condiciones de pieza completa conviven, el dibujo se compone **por capas** —no en fila
y encogido— (`WHOLE_TOOTH_MARKER_STYLES`, `wholeToothMarkers`):

| Capa | Condición | Trazo |
| :--- | :--- | :--- |
| `aspa` | `ausente` | Aspa sólida a tamaño completo (cede ante el implante). |
| `periferia` | `corona` | Círculo que rodea la casilla. |
| `centro` | `implante`, `endodoncia` | Tornillo / triángulo en el eje; se encogen **solo** si comparten la pieza con la corona. |
| `overlay` | `extraccion_indicada` | Aspa punteada translúcida **por encima**, dejando ver debajo lo que motivó la extracción. |

- `ausente` + `implante`: el tornillo ocupa el centro; el aspa se **suprime**.
- `corona` + `implante`: círculo en la periferia y tornillo en el centro, sin encogerse artificialmente.
- `corona` + `endodoncia`: círculo en la periferia y triángulo en el centro.
- `extraccion_indicada` + tratamiento previo: el aspa punteada se proyecta sobre el círculo/triángulo
  con trazo translúcido (`stroke-dasharray`).

La **geometría** de los símbolos vive en el contrato (`WHOLE_TOOTH_SYMBOLS`, `wholeToothMarkers`), no
en un componente: la pantalla la pasa a React y el **dossier del expediente** (que se compone en el
servidor, sin DOM) la convierte a una cadena de SVG. El dibujo del papel y el de la pantalla no
pueden separarse.

## 7. Enforcement en tres capas

Ninguna deja pasar un estado imposible:

1. **Contrato** (`packages/contracts/src/domain/odontogram.ts`): `WHOLE_TOOTH_RULES`,
   `SURFACE_CONDITION_RULES`, `isStateAllowed`, `PROCEDURE_TRANSITIONS`, y el `.superRefine` de
   `recordFindingSchema` / `completeProcedureSchema`.
2. **Servicio** (`services/odontogram/src/odontogram/chart-service.ts`):
   `assertStateAllowed`, `assertNoConflictingCondition`, `assertNoScopeConflict`, `supersedeSurfaces`,
   `resolveFinding` y `completeProcedure`. Devuelve `409` con la condición o el estado que sobra.
3. **Base de datos** (`services/odontogram/src/db/schema.ts` + migración `0002`): `chk_tooth_findings_state_allowed`
   ata el estado a la condición; la migración **repara** los datos antes de blindarlos.

Herramienta de red de seguridad: `npm run reparar:odontograma` (simulación) y `--apply` para aplicarlo.

## 8. Referencias

- [ADR 0032 — Los tratamientos conviven con las caras](adr/0032-convivencia-de-tratamientos-con-las-caras.md)
- [ADR 0031 — La pieza completa manda sobre las caras](adr/0031-odontograma-pieza-completa-sobre-caras.md)
- [ADR 0033 — El odontograma en posición anatómica](adr/0033-odontograma-en-posicion-anatomica.md)
- [ADR 0051 — Dentición mixta en el odontograma](adr/0051-denticion-mixta-en-el-odontograma.md)
