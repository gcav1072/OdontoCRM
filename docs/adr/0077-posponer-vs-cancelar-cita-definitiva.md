# ADR 0077 — «Posponer» y «cancelar la cita» definitiva son dos acciones distintas

- **Fecha:** 2026-11-13 · **Estado:** aceptada
- **Relacionada:** [ADR 0028](0028-cancelar-devuelve-el-ticket.md) (cancelar devuelve el ticket),
  [ADR 0052](0052-confirmacion-de-citas-por-el-paciente.md) (el paciente confirma su cita),
  [ADR 0053](0053-cancelacion-de-citas-por-el-paciente.md) (el paciente cancela su cita),
  [ADR 0057](0057-cancelacion-con-plazo-canales-y-novedades.md) (corte de cancelación),
  [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md) (núcleo conversacional y adaptadores),
  [ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) (el evento lleva lo que el consumidor necesita).

## Contexto

Hasta la v1.2.1, «cancelar» una cita desde el bot significaba **una sola cosa**: la cita pasaba a
`cancelada`, se liberaba la franja y la solicitud **volvía a `en_espera_cita`** con su ticket y su
antigüedad ([ADR 0028](0028-cancelar-devuelve-el-ticket.md)). El paciente seguía esperando y se le
reasignaba más adelante.

Ese comportamiento es el correcto para «ese día no puedo, pásame a otro», pero **no** sirve cuando el
paciente ya no quiere la cita: si su solicitud vuelve a la cola, el consultorio lo vuelve a llamar y
otra vez hay que cancelar. El paciente no tenía forma de decir «déjalo, ya no quiero nada» sin llamar
por teléfono, y la secretaría seguía teniendo que anular la solicitud a mano.

Hay tres hechos ya resueltos que conviene no reinventar:

1. La transición a `cancelada` libera la franja/cupo y escribe `status_history` y auditoría
   ([ADR 0053](0053-cancelacion-de-citas-por-el-paciente.md)).
2. La solicitud solo vuelve a la cola si **no le queda otra cita en pie** (una solicitud
   reprogramada no puede perder su cita nueva).
3. El asistente ya responde al paciente en el mismo turno y el evento sale con `skipNotice: true`
   para que la cola no envíe otro `cita_cancelada` ([ADR 0053](0053-cancelacion-de-citas-por-el-paciente.md)),
   y el corte de días de la clínica frena la cancelación de una cita **ya confirmada**
   ([ADR 0057](0057-cancelacion-con-plazo-canales-y-novedades.md)).

El problema es de **vocabulario y de semántica**: la misma palabra («cancelar») designa dos cosas
distintas, y el paciente necesita elegir cuál.

## Decisión

### 1. Dos acciones con nombre propio

- **POSPONER** (`posponer_cita`): es el comportamiento histórico. La cita queda `cancelada` con
  `cancelledAt`/`cancelledChannel`, se libera la franja y, si no le queda otra cita en pie, la
  solicitud vuelve a `en_espera_cita` con historial. El paciente recibe `cita_pospuesta_paciente`
  («vuelves a la lista de espera»).
- **CANCELAR CITA** (`cancelar_definitiva`): la cita queda `cancelada` y, si era la última en pie,
  la **solicitud pasa a `cancelada`** con su historial: no vuelve a la cola. No hay borrado físico:
  la solicitud, sus datos y su rastro siguen consultables. El paciente recibe
  `cita_cancelada_paciente` («quedó cancelada definitivamente y tu solicitud ya no está en la lista
  de espera»).

No se inventan estados nuevos: `cancelada` ya existe en `APPOINTMENT_STATUSES` y en
`REQUEST_STATUSES`. Lo que cambia es **qué pasa con la solicitud**.

### 2. La ruta interna de la agenda: `devolverACola`

`cancelAppointmentBotSchema` gana **`devolverACola: z.boolean().default(true)`**:

- `true` (default) = posponer: la solicitud vuelve a la cola, como siempre. El default mantiene
  compatibles a los clientes antiguos y **no cambia** la ruta pública de la secretaría, que no manda
  el flag.
- `false` = cancelación definitiva: si la cita no era la última en pie, la solicitud no se toca (no
  se deja huérfana una solicitud reprogramada).

`cancelAppointment` elige además el motivo del historial de la cita según el modo («pospuso» /
«canceló definitivamente» por canal) y el evento `scheduling.appointment.cancelled` añade
`after.devolverACola` (y `cancelledAt`) para que los consumidores no tengan que adivinarlo.

### 3. El paciente escribe «cancelar»: el bot pregunta, no ejecuta

Con una cita cancelable en la ventana, escribir «cancelar» responde una **pregunta con dos opciones**:

- «Posponer (volver a la lista de espera)» → `posponer_cita:<id>`;
- «Cancelar cita definitivamente» → `cancelar_definitiva:<id>`.

Con **varias** citas primero se elige cuál (botones `elegir_cita:<id>`) y después la acción; la cita
elegida se recuerda en `draft.pendingAppointmentId` y el estado nuevo `elegir_accion_cita`.

Sin cita en pie pero con una solicitud `en_espera_cita`, se pregunta si quiere **anular la solicitud
definitivamente** (`confirmar_anular_solicitud`, Sí/No). `cancelar #000123` conserva su significado
de siempre: anular la solicitud de ese ticket. Las frases «posponer», el comando `/posponer` y los
botones explícitos ejecutan directo, sin pregunta: una pulsación ya es una decisión.

### 4. Botones: tres acciones, no cuatro

Recordatorios y avisos llevan **tres** botones: `Confirmar` / `Posponer` / `Cancelar cita`, numerados
en Baileys. WhatsApp Cloud API acepta como máximo tres botones (con cuatro manda el texto sin
opciones) y Telegram limita `callback_data` a 64 bytes: `cancelar_definitiva:<uuid>` mide 56. El
recordatorio de una cita **ya confirmada** sigue siendo informativo y no lleva acciones.

### 5. R1 — compatibilidad con botones ya entregados: `cancelar_cita` = posponer

Los recordatorios enviados antes del despliegue llevan `cancelar_cita:<id>` y **no se pueden
distinguir** de uno nuevo por su id. Por eso los botones nuevos emiten `posponer_cita:<id>` y
`cancelar_definitiva:<id>`, y `cancelar_cita:<id>` se interpreta **siempre como posponer** (alias
heredado) durante **una versión**. Se retirará cuando no queden avisos entregados con el nombre
viejo; hasta entonces, aceptar que un botón viejo cancele definitivamente sería un cambio silencioso
de efecto para el paciente.

### 6. El corte ADR 0057 aplica a las dos acciones

El corte (`patientCancelCutoffDays`) existe para que el consultorio tenga margen para reutilizar la
franja; posponer libera la franja igual que cancelar definitivamente, así que **frena las dos**. El
texto `cita_cancelacion_fuera_de_plazo` pasa a decir «ni posponer ni cancelar».

### 7. Un aviso, ninguno duplicado

Las dos acciones del bot publican el evento con `skipNotice: true` y el asistente responde en el
turno: el consumidor de notificaciones no encola un `cita_cancelada` duplicado por ningún camino.
La cancelación de la **secretaría**, que no lleva la marca, sigue mandando su aviso como siempre (y
ahora dice que el ticket vuelve a la cola, que es lo que pasa con su cancelación por defecto).

### 8. Reportes: el embudo no miente

El consumidor de reportes lee `after.devolverACola`: con `true` (o si el evento es anterior y no lo
trae) fuerza `fact_request` a `en_espera_cita`; con `false` lo proyecta **`cancelada`** con
`cancelledAt`. Sin esa rama el embudo mostraría el ticket en la cola después de una cancelación
definitiva. No se publica un `scheduling.request.cancelled` adicional: sería una segunda fuente de
verdad y pg-boss no garantiza el orden entre eventos.

### 9. KPI sin split (deuda asumida)

«Canceladas por el paciente» sigue contando posponer y definitiva juntas. No se añade
`cancelledKind` a `AppointmentSummary` ni a los facts, ni se tocan fixtures por esto. Si el
consultorio quiere distinguirlas, será una columna nueva y una migración del read model en otra
versión; queda anotado como deuda.

### 10. Plantillas ya sembradas: migración 0009

`ensureDefaultTemplates` solo inserta las claves que faltan, así que los textos ya sembrados se
actualizan con la migración `0009_v1_2_2_posponer_cancelar.sql`, protegida por el texto **anterior**
exacto (patrón de 0002–0008): una plantilla que el consultorio haya editado a mano no se pisa. Las
claves nuevas las siembra el arranque.

## Consecuencias

**A favor**

- El paciente puede decir «déjalo» sin llamar, y la solicitud sale de la cola sin borrar nada.
- «Posponer» conserva tal cual el comportamiento que ya gustaba, sin tocar la agenda más de lo
  necesario (`devolverACola` es un flag, no un enum nuevo).
- La conversación deja de ser ambigua: escribir «cancelar» ya no ejecuta una acción que el paciente
  no había elegido.
- El corte de la clínica protege igual las dos acciones, y el embudo de reportes cuenta lo que de
  verdad pasó con el ticket.
- Los botones entregados antes de actualizar siguen funcionando con su semántica original.

**En contra / deuda asumida**

- **El KPI no distingue** posponer de cancelar definitiva en esta versión (deuda documentada arriba).
- **Dos nombres para una acción** durante una versión (`cancelar_cita` como alias): hay que recordar
  retirarlo y el asistente carga con una rama de compatibilidad.
- **La ruta interna tiene un flag nuevo** que puede cambiar el destino del ticket: cualquier cliente
  nuevo que lo omita hereda el comportamiento histórico (posponer), que es el seguro.
- Los **textos históricos** de las ADR 0028/0053/0057 y del `PLAN_MAESTRO` conservan el vocabulario
  anterior; se añaden apuntadores a esta ADR en vez de reescribir historia.
- La interfaz web (`PatientCancellationsCard`) sigue diciendo que «el ticket vuelve a la cola»: con la
  definitiva deja de ser cierto, y el split visual queda para cuando exista el KPI desdoblado.

## Verificación

- **Contratos:** intención/comando `posponer` y frases; plantillas nuevas y textos reescritos; estados
  `elegir_accion_cita` y `draft.pendingAppointmentId`; `devolverACola` con default `true` y rechazo de
  no booleanos; texto nuevo del aviso de cita.
- **Agenda (`scheduling.integration.test.ts`):** posponer devuelve el ticket a `en_espera_cita` con el
  historial «pospuso», la cancelación definitiva deja la **solicitud** `cancelada` sin volver a la
  cola, historial de las dos entidades, idempotencia, y la secretaría (ruta pública) sigue
  devolviendo el ticket a la cola.
- **Notificaciones (`notifications.integration.test.ts`):** botón de posponer, botón de definitiva,
  alias heredado `cancelar_cita` = posponer, «cancelar» escrito que pregunta sin ejecutar, varias
  citas → elegir cita → pregunta, sin cita con solicitud → confirmación de anulación, `/posponer`
  directo, corte ADR 0057 en las dos acciones, cita ajena / en sala y ningún `cita_cancelada`
  duplicado en ningún modo.
- **Mensajería (`messaging.documents.integration.test.ts`):** tres opciones numeradas con sus
  acciones y tres botones en el recordatorio del canal con botones.
- **Reportes (`reporting.integration.test.ts`):** la cancelación definitiva proyecta `fact_request`
  como `cancelada` con `cancelledAt`; el posponer (y un evento viejo sin flag) sigue forzando
  `en_espera_cita`.
- **Migración 0009** aplicada contra PostgreSQL real y protegida por el texto anterior (no pisa
  plantillas personalizadas).
