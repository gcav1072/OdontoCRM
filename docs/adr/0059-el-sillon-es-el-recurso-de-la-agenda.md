# ADR 0059 — El sillón es el recurso que ocupa la franja; el odontólogo es un atributo

- **Fecha:** 2026-10-09 · **Estado:** aceptada
- **Sustituye parcialmente:** [ADR 0006](0006-un-odontologo-un-sillon.md) (un odontólogo y un sillón)
- **Relacionada:** [ADR 0009](0009-cupo-y-franjas.md) (cupo y franjas),
  [ADR 0019](0019-reportes-y-kpis.md) (reportes y KPIs),
  [ADR 0030](0030-pantallas-kiosko-y-sse.md) (pantallas kiosko y SSE),
  [ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) (el evento lleva lo que el
  consumidor necesita), [ADR 0038](0038-permisos-del-odontologo-en-el-flujo.md) (permisos del odontólogo).

## Contexto

La [ADR 0006](0006-un-odontologo-un-sillon.md) cerró el alcance inicial —**un odontólogo y un
sillón**— dejando `appointments.dentist_id` y `appointments.chair_id` declarados «para no migrar
después». El sistema se usa ahora en una clínica con **varios consultorios y varios odontólogos**, y
el modelo mono-sillón se queda corto en su punto más visible:

- el índice único `uq_appointments_slot` es `(appointment_date, start_time)`: **dos citas no pueden
  coincidir en hora** aunque sean en gabinetes distintos;
- `findOverlappingAppointment` compara la hora **ignorando** el consultorio;
- el cupo (`day_capacities`) y las plantillas (`slot_templates`) son **globales del día**, no por sillón;
- el displaylobby y la pantalla de consultorio usan un `CHAIR_LABEL` **único** de configuración y
  muestran «el paciente en curso», no el estado de cada gabinete;
- los reportes no saben de sillones ni de productividad por doctor.

## Decisión

**El sillón (consultorio físico) es el recurso que ocupa una franja horaria.** El odontólogo es un
**atributo opcional** de la cita: no bloquea la franja y cualquiera puede usar cualquier sillón.

### 1. Modelo

Nace la tabla **`chairs`** en el servicio de agenda (dueño del solapamiento): `label` (único),
`short_label`, `is_active` y `sort_order`. Un consultorio **no se borra** (`ON DELETE RESTRICT`): se
**desactiva**, porque conserva su histórico.

- `appointments.chair_id` pasa a ser **obligatorio** con FK a `chairs`; `dentist_id` sigue opcional.
- El índice único pasa a `(appointment_date, start_time, chair_id)`: **dos sillones pueden coincidir**.
- `day_capacities` pasa a clave `(date, chair_id)`; `slot_templates` gana `chair_id` **nullable**
  (`null` = plantilla común a todos los sillones; con valor = plantilla propia, que reemplaza a la común).
- La migración **sembró un «Consultorio 1» y reasignó todo el histórico** antes de poner los `NOT NULL`.

### 2. Eventos y pantallas

El bloque `appointment` de los eventos lleva **`chairId`, `chairLabel`, `dentistId` y `dentistName`**
([ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)): las pantallas y los reportes
pintan el consultorio sin leer bases ajenas ni resolver identificadores. `CHAIR_LABEL` queda como
**respaldo** de una cita capturada antes de la migración.

La pantalla del consultorio es **una sola TV compartida** que muestra **un tile por sillón** (con su
paciente, o «libre»), en el orden del catálogo. El catálogo lo sirve la agenda por una ruta interna
(`GET /internal/v1/agenda/chairs`), cacheada; si no responde, la TV se arma con los sillones que
aparezcan en la sala para no perder de vista a nadie.

### 3. Alto de odontólogos y consultorios

El catálogo de consultorios se administra en **`/programacion`** con el permiso nuevo
**`scheduling:manage`** (solo `admin`). El catálogo de odontólogos ya existía (cuentas con rol
`odontologo` y su perfil profesional): se expone por una ruta interna
(`GET /internal/v1/identity/dentists`) para el **selector de odontólogo** al asignar una cita.

### 4. Reportes

Dos reportes nuevos, ambos operativos (`reports:read`): **ocupación por consultorio** y
**productividad por odontólogo**. El hecho (`fact_appointment`) guarda las etiquetas que viajan en el
evento (`chair_label`, `dentist_name`), así que el read model no lee bases ajenas.

## Consecuencias

- **El día se ve por consultorio**: la jornada devuelve `chairs[]` (una vista por sillón con su cupo,
  su rejilla y sus contadores) más el agregado del día.
- El cupo y las plantillas son **por sillón**; dos citas a la misma hora en la misma sala siguen
  siendo imposibles (409), pero en salas distintas se permiten.
- **La pantalla de consultorio y el displaylobby** muestran el consultorio de cada cita.
- Lo que **no** cambia: la máquina de estados de la cita, la confirmación/cancelación del paciente
  ([ADR 0052](0052-confirmacion-de-citas-por-el-paciente.md)/[0053](0053-cancelacion-de-citas-por-el-paciente.md)),
  el bot y los imprimibles.
- **Diferido a propósito:** atar cada TV a un gabinete (una pantalla por sillón). La columna de
  dispositivo no se añade mientras la pantalla compartida sea la norma; el catálogo ya está listo
  para hacerlo sin migrar el modelo de la cita.
