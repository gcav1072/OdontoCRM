# ADR 0070 — El cupo del día se mide en franjas ocupadas

- **Fecha:** 2026-10-18 · **Estado:** aceptada · **Supera a:** [0009](0009-cupo-y-franjas.md)

## Contexto

El cupo nació como un número que se fijaba a mano por fecha (`day_capacities`, ADR 0009) y el
botón «Editar el cupo» solo cambiaba ese número. Con el sillón como recurso (ADR 0059) el cupo
pasó a ser por consultorio, pero el número siguió siendo ajeno a la rejilla: se podía fijar 20
sobre una jornada de 14 franjas, o 2 sobre una jornada de 14.

Además, el número no sabía **cuánto ocupa una cita**. Un paciente con dos horas de consulta
sobre franjas de 30 minutos cruza cuatro franjas y el cupo solo descontaba una, así que la
agenda decía que quedaba sitio donde ya no cabía nadie. Y el diálogo no enviaba `chairId`, de
modo que guardar el cupo fallaba en cuanto se añadieron los sillones.

El interesado pidió algo más simple y más cierto: que el botón configure **el horario de
atención** (turnos programables por día, en formato de 12 h) y el **tamaño de la franja**, con
8:00–12:00 y 2:00–5:00 p. m. y franjas de 30 minutos de fábrica.

## Decisión

- **El cupo son las franjas del horario.** La plantilla semanal (`slot_templates`) produce N
  franjas para un consultorio y un día; N es su cupo. No hay número que escribir.
- **Una cita gasta tantas franjas como cruza** (`usedCapacity`): dos horas sobre franjas de 30
  minutos gastan 4; sobre franjas de 60, 2. Una cita con hora manual fuera de la rejilla gasta
  una: nunca se dice que un paciente citado no ocupa cupo.
- **Sin turnos el día está cerrado** (cupo 0). Asignar ahí exige autorizar el sobrecupo
  (`scheduling:overbook`, admin, con motivo), igual que en un día lleno.
- **Se elimina `day_capacities` y `PUT /api/v1/agenda/capacity`.** El cupo explícito no se puede
  conservar con sentido: un 20 escrito a mano no significa nada sobre una jornada de 14 franjas.
- **Nuevo `PUT /api/v1/agenda/schedule`** (`scheduling:write`): días de la semana, turnos,
  duración de la franja y, opcionalmente, el consultorio (por defecto la plantilla **común**).
  Reconcilia por hora de inicio (conserva `id` y pausas), inserta los turnos nuevos y
  **desactiva** los que sobran. Nunca borra citas.
- **La interfaz** cambia «Editar el cupo» por «Configurar la jornada»: un día a la vez (el que se
  está viendo), con atajos «Lunes a viernes» y «Todos los días», turnos editables en 12 h con
  `a. m.`/`p. m.` y una sola duración de franja para todos los turnos.

## Consecuencias

- ✅ El cupo y la rejilla dicen lo mismo: no se puede «prometer» un hueco que la agenda no tiene.
- ✅ Una consulta larga descuenta su espacio real; la ocupación del día deja de mentir.
- ✅ Configurar el horario es una operación de mostrador, en 12 h y sin tocar la base a mano.
- ⚠️ **La migración `0007` borra `day_capacities`**: se pierden los cupos explícitos guardados.
  Es deliberado; el horario es la fuente. Las instalaciones existentes conservan su horario
  guardado (13:00–17:00 en las viejas) hasta que se ajuste desde el diálogo: no se reescriben
  datos por una migración.
- ⚠️ Un turno con pausas (`breaks`) las conserva si mantiene su hora de inicio; el editor no las
  expone, así que no se pueden añadir desde la interfaz (sigue siendo dato de la plantilla).
- ⚠️ Las plantillas por sillón siguen existiendo por API y **prevalecen** sobre la común; el
  diálogo solo edita la común y avisa cuando algún consultorio tiene horario propio.
- ⚠️ **Reporting** conserva `dim_day_capacity` con lo histórico: la agenda ya no publica
  `day_capacity_changed`, así que el cupo nuevo no viaja en eventos y el reporte de ocupación
  sigue contando el cupo explícito de antes (o las citas asignadas como suelo).
