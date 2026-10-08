# ADR 0053 — El paciente cancela su cita

- **Fecha:** 2026-10-08 · **Estado:** aceptada
- **Relacionada:** [ADR 0012](0012-maquina-de-estados.md) (máquina de estados),
  [ADR 0028](0028-cancelar-devuelve-el-ticket.md) (cancelar devuelve el ticket),
  [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md) (núcleo conversacional y adaptadores),
  [ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) (el evento lleva lo que el consumidor necesita),
  [ADR 0052](0052-confirmacion-de-citas-por-el-paciente.md) (el paciente confirma su cita).

## Contexto

La [ADR 0052](0052-confirmacion-de-citas-por-el-paciente.md) cerró la mitad del círculo: el aviso de
cita ya **invita a confirmar** y el paciente responde por Telegram o WhatsApp. Pero la respuesta solo
tenía un camino. Si el paciente no podía asistir, el aviso le decía «escríbenos por este mismo chat»
y ahí se acababa: el mensaje caía en la bandeja y una persona lo atendía a mano, cancelaba la cita
desde la agenda y, con suerte, se acordaba de que el paciente seguía esperando.

Tres cosas estaban ya resueltas y conviene no reinventarlas:

1. **Cancelar una cita devuelve el ticket a la cola.** Lo decidió la
   [ADR 0028](0028-cancelar-devuelve-el-ticket.md) y está implementado en `transitionAppointment`:
   al pasar a `cancelada`, la solicitud que originó la cita vuelve a `en_espera_cita`.
2. **El núcleo conversacional resuelve acciones de botón y opciones numeradas** (ADR 0029): un botón
   `accion:valor` y un «2» numerado llegan al mismo sitio.
3. La agenda **ya sabe hacer** la cancelación: no hay que escribir la máquina de estados, solo abrir
   el camino para que la dispare el paciente.

Lo que faltaba era el camino del paciente —y, con él, un dato que hoy no existe: **quién canceló**.
Hasta ahora una cancelación no decía si la había pedido el paciente o la secretaría, así que no se
podía ni listar «los pacientes que cancelan» ni medir si el recordatorio sirve.

## Decisión

### 1. El aviso ofrece confirmar **o** cancelar

El aviso de cita lleva **dos** botones (`Confirmar` y `Cancelar`) y el texto pide lo mismo por escrito
(«aprieta (cancelar) o escribe cancelar»). Los botones van en el **código** del envío y no en la
plantilla: así el consultorio puede reescribir el texto sin quedarse sin los botones. En los canales
sin botones vale escribirlo; WhatsApp admite hasta tres botones, así que dos caben.

### 2. La cancelación del paciente, su hermana de la confirmación

`cancelAppointment` es a la cancelación lo que `confirmAppointment` a la confirmación:

- la dispara **el paciente** desde el bot, así que el actor es de sistema y va **sin roles**: se salta
  la máquina de estados por rol y aplica su **propia guardia de estado**;
- solo se puede cancelar desde `programada`, `notificada` o `confirmada`
  (`CANCELLABLE_STATUSES`, en el contrato para que el bot y la agenda miren **la misma** lista). A
  partir de `en_sala_espera` el paciente ya está en el consultorio: cancelar por chat no tiene sentido
  y se responde que no se puede;
- es **idempotente**: si ya estaba cancelada se devuelve tal cual, sin mover la fecha ni escribir
  historial. Dos pulsaciones del botón, o un `update` reenviado por Telegram, no ensucian el rastro.

El asistente (`cancelarCita`) comprueba que la cita sea **suya** antes de tocar nada —el
identificador viaja por el chat—, cancela directamente si es la única cancelable y ofrece una lista si
hay varias. El comando `cancelar` sin argumento intenta primero la **cita** y, si el paciente no tiene
ninguna, cae a lo de siempre: anular la **solicitud**; con un ticket detrás (`/cancelar #000123`)
conserva el comportamiento de siempre.

### 3. Quién canceló: `cancelled_at` y `cancelled_channel`

La cita gana **`cancelled_at`** y **`cancelled_channel`**. Un canal de paciente (`telegram`,
`whatsapp`) es lo que distingue «la canceló el paciente» de «la canceló la secretaría», que es
justo el corte que piden la tarjeta y el KPI. La secretaría cancela **sin** canal.

El estado sigue moviéndose a `cancelada` (no se inventa un estado nuevo) y `transitionAppointment`
—que ya sabe liberar la franja y devolver el ticket a la cola— es quien escribe las columnas. Con un
matiz defensivo: la solicitud solo vuelve a `en_espera_cita` si **no le queda otra cita en pie**, para
no sacar de la agenda la cita nueva de una solicitud reprogramada.

### 4. Un aviso, no dos: el flag `skipNotice`

Al cancelar, la agenda publica `scheduling.appointment.cancelled`, y el consumidor de notificaciones
lo traduciría a un mensaje `cita_cancelada`. Pero el asistente **ya responde** al paciente en el mismo
turno, así que un segundo mensaje sería un duplicado.

No se puede resolver quitando el bloque `notification` del evento: **también lo leen** los servicios de
pacientes y pantallas (y reportes saca de ahí al paciente). En su lugar el evento viaja marcado con
**`skipNotice: true`** y el consumidor de notificaciones lo corta antes de encolar nada. El bloque
`notification` se conserva entero para los demás consumidores. La cancelación de la secretaría, que no
lleva la marca, sí manda su aviso `cita_cancelada` como siempre.

### 5. Dónde se ven las cancelaciones del paciente

- **Tarjeta en `/programacion`** («Canceladas por el paciente»): filtra por rango de la fecha de
  cancelación y muestra paciente, ticket, la cita original, cuándo canceló y por qué canal. Solo
  aparecen las cancelaciones del **bot**: las que hace la secretaría ya son conocimiento del
  consultorio. Se sirve por `GET /api/v1/appointments/cancellations`.
- **KPI en el embudo de `/reportes`**: «Canceladas por el paciente», como **KPI card**, **columna** de
  la tabla (y por tanto del CSV) y **serie** propia del gráfico. El dato sale de `mv_funnel`
  (`cancelled_by_patient`), que se rehace en la migración.

## Consecuencias

**A favor**

- El paciente cierra el círculo con un toque: confirma o cancela, y en los dos casos el consultorio se
  entera sin que nadie copie nada a mano.
- Cancelar devuelve el ticket a la cola (ADR 0028), así que el hueco no se pierde: el paciente vuelve
  a la lista y se le puede reasignar.
- Por primera vez el sistema dice **quién** canceló, y eso alimenta la tarjeta y el KPI.
- Nada de esto rompe lo que había: la secretaría sigue cancelando como siempre (con su aviso) y el
  comando `/cancelar <ticket>` conserva su significado.

**En contra / deuda asumida**

- **Un camino nuevo en la agenda que no pide usuario.** Es la segunda escritura que dispara el
  paciente (tras confirmar); se acota con una guardia de estado propia y la máquina de estados por rol
  se conserva para las rutas de personal.
- **El aviso «cita cancelada» tiene ahora dos redacciones**: `cita_cancelada` (la de la secretaría) y
  `cita_cancelada_paciente` (la respuesta del asistente). Son dos hechos distintos —una avisa, la otra
  confirma la respuesta— y por eso son dos plantillas.
- El flag `skipNotice` es un detalle del evento que hay que recordar al añadir nuevos publicadores de
  cancelación: si se olvida, el paciente recibe el aviso de la cola además del del asistente.

## Verificación

- Contratos: `cancelledAt`/`cancelledChannel` en `AppointmentSummary`, el schema **público** de
  cancelación sin `channel` y el **interno** del bot con él, `CANCELLABLE_STATUSES`, los filtros de la
  tarjeta, las plantillas nuevas y el comando `cancelar` reclasificado.
- Integración de `scheduling`: cancelar con un actor **sin roles** desde `programada`/`notificada`/
  `confirmada`, idempotencia (la fecha de cancelación no se mueve), la solicitud de vuelta en
  `en_espera_cita`, el rechazo en `en_sala_espera`, y que la tarjeta ve solo las del paciente (la
  cancelación de la secretaría queda fuera).
- Integración de `notifications`: cancelar por botón y por texto, idempotencia, cita **ajena** que no
  se cancela, estado no cancelable, y que la cancelación del bot **no** encola un `cita_cancelada`
  (`skipNotice`).
- Integración de `reporting`: el evento proyecta `cancelled_channel`, `mv_funnel` cuenta
  `cancelled_by_patient` y la cifra aparece en el KPI, la columna (y su cabecera en el CSV) y la serie.
- Migraciones aplicadas contra PostgreSQL real: las columnas y su `CHECK` en la agenda, la actualización
  de la plantilla de aviso (protegida por el texto anterior) y la vista materializada recreada.
