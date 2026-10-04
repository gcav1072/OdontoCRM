# ADR 0032 — Los tratamientos conviven con las caras del odontograma

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** fase 6, sesión B (2026-10-04)
- **Corrige a:** [ADR 0031](0031-odontograma-pieza-completa-sobre-caras.md) (que dejó a **todos** los
  marcadores de pieza completa mandando sobre las caras)

## Contexto

El [ADR 0031](0031-odontograma-pieza-completa-sobre-caras.md) metió en el mismo saco cinco
condiciones que se guardan igual (`surface: null`) pero **no significan lo mismo**:

- `ausente` dice que **la pieza no está**;
- `extraccion_indicada` dice lo que **se va a hacer** con una pieza que sigue ahí;
- `corona`, `implante` y `endodoncia` son **tratamientos**: la pieza está y sigue teniendo
  superficies.

Al tratar las cinco como «la pieza completa manda», el odontograma rechazaba cosas que son la boca
normal:

- una **corona sobre un diente obturado** (lo habitual: se corona un diente ya restaurado);
- un **conducto con su restauración** encima (un diente endodonciado casi siempre lleva una
  obturación o una corona después);
- una **caries en un diente con la extracción indicada** (precisamente por eso se indica).

En la práctica, el odontólogo tenía que borrar la obturación para poder marcar la corona: el sistema
le pedía destruir el dato clínico para poder registrar el tratamiento. Eso es un error de modelo, no
una regla clínica.

## Decisión

**Cada condición de pieza completa declara su regla** (`WHOLE_TOOTH_RULES`, en el contrato), y la
regla tiene dos piezas:

| Condición | ¿Supera las caras? | ¿Las excluye? | No convive con |
| :--- | :--- | :--- | :--- |
| `ausente` | **Sí** | **Sí** | `extraccion_indicada`, `corona`, `endodoncia` |
| `corona` | **Sí** (las recubre) | No | `ausente` |
| `extraccion_indicada` | No (convive) | No | `ausente` |
| `endodoncia` | No (convive) | No | `ausente`, `implante` |
| `implante` | No (convive) | No | `endodoncia` |

**Superar no es excluir**, y la diferencia es clínica ([revisión clínica](#revisión-clínica-2026-10-04)):

- **Superar** (`supersedesSurfaces`): al registrar la condición, las caras vigentes quedan
  cubiertas —con `resolved_at` y su entrada en el histórico, no se borran— y el gráfico deja de
  pintarlas porque en boca ya no se ven.
- **Excluir** (`excludesSurfaces`): las caras no caben de ninguna manera, ni antes ni después. Es lo
  que hace `ausente` (una pieza que no está no tiene caries) y lo que **no** hace `corona`: una
  **caries recurrente** en el margen de la corona se registra después y se ve.

- **Solo `ausente` supera las caras** (y las conserva con `resolved_at`, como decía el ADR 0031).
- Un **tratamiento se registra junto a lo que ya había**: la corona no borra la obturación ni deja
  de leerse; el implante no borra el conducto anterior —aunque un implante **con** conducto vigente
  se rechaza, porque un implante no tiene raíz que endodonciar.
- **Cara × pieza completa es direccional**, y eso importa: registrar una caries en una pieza
  `ausente` se rechaza (`409`), pero registrar `ausente` sobre una caries **se permite** y la supera.
  Por eso el contrato expone dos funciones distintas:
  - `conditionsConflict(a, b)`: simétrica, «¿caben juntas?», para validar un lote (donde no hay orden);
  - `recordingConflicts(existing, next)`: direccional, «¿puedo registrar esto?», que es la que usan
    el servicio y la interfaz.
- La regla es **datos, no código disperso**: la interfaz desactiva el botón que choca y explica por
  qué con `conflictingCondition`, y el servidor vuelve a comprobarlo por su cuenta antes de escribir.
- El dibujo enseña **todos** los marcadores de una pieza, encogidos si hay varios (`markerSlots`), y
  la hoja táctil los lista uno a uno.

## Consecuencias

- **A favor:** se puede registrar la realidad clínica sin borrar nada; la corona, el conducto y la
  obturación conviven; las contradicciones de verdad (una pieza ausente con caries, un implante con
  conducto) siguen bloqueadas con un mensaje que dice cuál sobra. El modelo queda declarativo y
  ajustable en un solo sitio (`WHOLE_TOOTH_RULES`) cuando la odontóloga opine sobre un caso nuevo.
- **En contra:** el odontograma de una pieza puede tener varias filas de pieza completa, así que el
  dibujo necesita el reparto de `markerSlots` y la vista impresa tiene que listarlas todas. Se asume:
  es preferible a perder información.
- **Sin migración:** las filas y los `CHECK` no cambian (`chk_tooth_findings_scope` solo comprueba la
  forma de cada fila, no qué filas conviven). Lo que cambia es la regla de servicio y de interfaz.
- Queda **una pregunta abierta para la odontóloga**: si prefiere que marcar `corona` no muestre
  además la obturación anterior en el gráfico (hoy se muestran las dos, que es lo que pasa en la
  boca), basta con cambiar `WHOLE_TOOTH_RULES.corona.supersedesSurfaces` a `true` y actualizar el
  ADR.

## Ampliación (2026-10-04): `ausente` + `implante`

La revisión clínica del odontólogo señaló que **la corona y la raíz son dos ejes**: el diente
biológico y su soporte protésico atraviesan fases que no se pueden colapsar en un estado único. Con
la tabla anterior, marcar `implante` bloqueaba `ausente`, así que era imposible registrar la fase
quirúrgica real —implante osteointegrado **sin** corona— y, de paso, el CRM no podía documentar por
separado un problema del tornillo y un problema de la corona protésica.

| Fase | Registro |
| :--- | :--- |
| **Quirúrgica** (implante colocado, sin corona natural) | `ausente` + `implante` |
| **Rehabilitada** (implante cargado, con corona protésica) | `corona` + `implante` |

Por eso `ausente` e `implante` **dejan de ser incompatibles** (cada uno pierde al otro de su lista).
El resto de la tabla no se mueve: `implante` × `endodoncia` sigue prohibido —un implante no tiene
raíz que tratar— y `corona` sobre `ausente` también, porque una pieza no puede estar sin corona y
con corona a la vez. El paso de una fase a otra es, por tanto, **quitar `ausente` y marcar
`corona`**, que en la hoja de la pieza son dos toques.

Detalle de dibujo: cuando hay implante, el aspa de `ausente` **no se pinta** —el tornillo ya dice
que no hay diente natural, y las dos marcas juntas son ruido—, y el marcador vuelve a ocupar la
pieza entera.

Queda para la Fase 7 la facturación por fases (quirúrgica y protésica por separado): hoy el
presupuesto agrupa por pieza, no por fase.

## Revisión clínica (2026-10-04)

### Dos ejes: corona y raíz

El odontólogo confirma que el **modelo de dos ejes** —lo que se ve en boca (corona) y lo que va
inserto en hueso (raíz/soporte)— es el acierto de dominio, y que la **facturación por fases** es un
modelo comercial derivado, no al revés:

| Fase | Registro | Qué se factura (Fase 7) |
| :--- | :--- | :--- |
| Quirúrgica | `ausente` + `implante` | colocación del fixture de titanio |
| Protésica | `corona` + `implante` | corona sobre implante |
| Falla de la prótesis (fractura de cerámica) | se rehace `corona`; el implante sigue | rehacer la corona |
| Falla del implante (periimplantitis) | se quita `implante` y queda `ausente` | — |

Por eso la pieza puede cambiar de fase sin perder nada: cada paso queda como un alta, una baja o una
superación en el histórico. Con el odontograma agrupando solo por pieza, la clínica no podría facturar
escalonado; con los dos ejes en el estado clínico, el presupuesto de la Fase 7 se engancha directo a
lo que ya está registrado.

### La corona cubre las caras

Al marcar `corona`, el gráfico **no** debe seguir mostrando la obturación o la caries de debajo:

- **Anatómico:** una corona periférica completa recubre el muñón en sus 360°; en boca ya no se
  inspecciona si debajo había amalgama mesial o resina oclusal.
- **Ruido diagnóstico:** el círculo de la corona sobre trapecios pintados se lee como «¿caries dentro
  de la corona? ¿filtración?». En la lectura rápida, la corona manda.
- **El dato no se destruye:** la obturación queda superada con su `resolved_at` y su entrada en el
  histórico con fecha, que es el respaldo médico-legal (`14/01/2026: Obturación oclusal` ·
  `04/10/2026: Corona completa`).
- **Excepción:** la **caries recurrente** del margen (cervical o vestibular) se registra *sobre* la
  corona y **se ve**. Sale sola: la superación solo mira lo que había al poner la corona.

Implementación: `corona.supersedesSurfaces = true` (no `excludesSurfaces`), y dentro de un lote las
caras se aplican **antes** que la condición que las cubre, para que el resultado no dependa del orden
en que la interfaz mande el lote.
