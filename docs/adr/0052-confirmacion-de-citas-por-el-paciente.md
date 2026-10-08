# ADR 0052 — El paciente confirma su cita (y la cita puede nacer de la sesión clínica)

- **Fecha:** 2026-10-07 · **Estado:** aceptada
- **Relacionada:** [ADR 0012](0012-maquina-de-estados.md) (máquina de estados),
  [ADR 0010](0010-notificacion-en-lote.md) (aviso al paciente),
  [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md) (núcleo conversacional y adaptadores),
  [ADR 0034](0034-sesion-clinica-evolucion.md) (sesión clínica como evolución),
  [ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) (el evento lleva lo que el consumidor necesita).

## Contexto

El sistema avisaba de las citas desde la Fase 4: al formalizar una cita sale un mensaje por
Telegram con la fecha, la hora, el lugar y el `.ics`, y si el paciente no tiene canal vinculado
el aviso queda como **llamada manual pendiente**. Pero el aviso era **unidireccional**: servía
para que el paciente supiera cuándo venir, no para que el consultorio supiera si va a venir.

El hueco se veía en dos sitios:

1. **El estado mentía por omisión.** `notificada` se rotulaba «CONFIRMADA Y AVISADA» en el bot
   y en la interfaz. No es lo mismo: lo único que había pasado era que el mensaje salió, y la
   secretaría necesitaba saber si el paciente había respondido — y si no, llamarlo.
2. **La «próxima cita» de la sesión era un fantasma.** El odontólogo escribe en su sesión
   «próxima cita: 4/11, control de endodoncia» (`proximaCitaFecha` / `proximaCitaNota`), y eso
   quedaba como **texto dentro del documento clínico**: nadie lo ve en la agenda, no ocupa
   franja, no se puede avisar y no se puede confirmar. El dato más útil del cierre de una
   sesión —cuándo hay que volver— era el único que no llegaba a la agenda.

Y las dos piezas del sistema que hacían falta ya existían: el aviso llevaba `.ics` y la cola de
envíos ya sabía adjuntar el calendario; el bot ya conversaba y ya resolvía acciones de botón y
opciones numeradas para los canales sin botones.

## Decisión

### 1. Un estado nuevo: `confirmada`

`APPOINTMENT_STATUSES` gana **`confirmada`**, entre `notificada` y `en_sala_espera`.
`notificada` pasa a significar solo **«se le avisó»** y `confirmada`, **«respondió que sí»**.
Se descartó reaprovechar `notificada` con una marca aparte: son dos hechos distintos y el
estado es lo que se lee de un vistazo en la jornada.

Transiciones que entran (`state-machine.ts`):

| Desde | A | Quién |
| :--- | :--- | :--- |
| `programada` | `confirmada` | secretaría — el caso «la llamé yo», sin aviso previo |
| `notificada` | `confirmada` | secretaría |

Transiciones que salen de `confirmada`: `en_sala_espera`, `no_asistio`, `cancelada` y
`reprogramada`. **Las salidas desde `notificada` se conservan a propósito**: confirmar **no**
es requisito para llegar —el paciente aparece sin haber respondido y la recepción lo registra
igual—, así que `notificada → en_sala_espera` sigue existiendo.

Una consecuencia que no es obvia y que se pagó con una línea de SQL: el estado nuevo tiene que
entrar en **dos** sitios de la base, no uno. El `CHECK` de `chk_appointments_status` y el
**índice único parcial `uq_appointments_slot`**, que es lo que impide citar a dos pacientes a
la misma hora. Si el índice no incluyera `confirmada`, una cita confirmada dejaría de bloquear
su franja y el hueco se podría volver a asignar. Está en la migración `0004` y lo cubre una
prueba de integración.

Las **solicitudes** (`appointment_requests`) no usan el estado nuevo: se declara
`REQUEST_STATUSES` = `APPOINTMENT_STATUSES` sin `confirmada`. Una solicitud todavía no tiene
fecha, así que no hay nada que confirmar, y la cola no debe ofrecer un estado que no le
pertenece.

### 2. Se confirma por el bot, con botón o escribiendo

El aviso de la cita **invita a confirmar** y la intención `confirmar` entra en el catálogo del
bot (`BOT_INTENTS`, `INTENT_PHRASES`, `BOT_COMMANDS`), así que funciona:

- **pulsando un botón** en el mensaje (`confirmar_cita:<id>`), que es lo que querrá la mayoría;
- **escribiendo** «confirmar» —o «confirmo», «asistiré»…—, que es lo que hay que admitir en los
  canales sin botones y para quien responde a mano. No se incluyen respuestas de una sola
  palabra del tipo «sí» u «ok»: son demasiado ambiguas durante el alta del paciente.

**El aviso sale en dos mensajes.** `services/notifications/src/canales/telegram.ts` decide así:
cuando el saliente lleva `documento`, manda el archivo con el texto como **pie de foto** y
**descarta los botones**. Como el `.ics` viaja así desde la Fase 4, el texto y su botón van
primero y el calendario después, con un pie corto («Tu calendario»). La alternativa —extender
`sendDocument` con `reply_markup`— se descartó: el pie de foto tiene tope de 1024 caracteres,
WhatsApp no tiene equivalente y obligaría a ramificar por canal dentro del núcleo, justo lo que
evita el [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md).

Reglas del lado del asistente:

- el paciente se identifica por **la dirección del canal** (`channelByDireccion`), no por lo que
  diga la conversación;
- si llega un identificador de cita (botón u opción numerada), se comprueba que la cita sea
  **suya** antes de tocar nada: el identificador viaja por el chat y nadie debe poder confirmar
  la cita de otro;
- con **una** cita pendiente se confirma directamente; con **varias** se le ofrecen numeradas;
- sin ninguna pendiente, si ya tenía una confirmada se le recuerda —confirmar dos veces no es un
  error— y si no hay nada, se le dice que no hay nada que confirmar;
- la ventana que se mira es de **hoy a 60 días** (`BOT_CONFIRM_WINDOW_DAYS`): un paciente con
  muchas citas no recibe una lista interminable de opciones.

### 3. La confirmación deja rastro, y es idempotente

En `appointments` se guardan **`confirmed_at`** y **`confirmed_channel`**, y se escribe una fila
en `status_history` con el motivo («confirmó por teléfono: dijo que sí a las 10»). Se publica
`scheduling.appointment.confirmed` con la acción de auditoría `appointment_confirmed`.

`confirmed_at` es un hecho del paciente que **no se borra** con el paso del tiempo: si luego
llega, se atiende y la cita acaba en `atendido`, el estado ya no lo dice pero la confirmación
sigue ahí. Por eso van columnas aparte y no solo el estado.

`confirmAppointment()` es **idempotente**: si la cita ya está confirmada se devuelve tal cual,
sin escribir historial ni mover la fecha. El paciente que pulsa dos veces, o cuyo botón se
reenvía, no ensucia el rastro. Y el actor del bot va **sin roles** (`systemActor`): es la única
escritura de la agenda que no pide un usuario, así que la función comprueba siempre el *estado*
pero solo consulta la **máquina de estados** cuando el actor trae roles (la secretaría
confirmando por teléfono, `POST /api/v1/appointments/:id/confirm`).

### 4. La sección de citas en `/notificaciones`

La bandeja gana la sección **Citas próximas**, servida por
`GET /api/v1/notifications/appointments`. Se compone **en el servicio** —agenda por su ruta
interna, canal vinculado enmascarado y último aviso, todo en una consulta— y no en la interfaz:
cruzar eso en el navegador serían tres consultas con tres paginaciones que no encajan. Filtra por
rango de fechas, estado, confirmadas sí/no y búsqueda, y por fila deja avisar (el mismo diálogo
con vista previa del lote, reducido a una cita) o dejar constancia de la confirmación telefónica.

### 5. La próxima cita de la sesión se puede crear de verdad

En el contenido de la sesión se añade **`proximaCitaAppointmentId`**: el enlace a la cita
**real** creada a partir de la sugerencia. El odontólogo ve un cuadro —«¿agendo la próxima
cita?»— con la fecha que ya escribió; si acepta, la cita se crea en la agenda (hora manual, 30
minutos por defecto) y el enlace queda en el borrador; si no, **la nota se queda donde estaba y
no se crea nada**. Se ofrece mientras la sesión está abierta y no después de cerrarla: cerrar es
inmutable ([ADR 0034](0034-sesion-clinica-evolucion.md)) y el enlace tiene que entrar en el
documento antes.

### 6. El embudo y el tablero cuentan las confirmadas

La etapa nueva entra en el **embudo** (`funnel`) entre «avisadas» y «atendidas», con su columna
en la tabla, su serie en el gráfico, su columna en el CSV y un KPI —«Confirmadas por el
paciente», con el porcentaje sobre las avisadas, que es el dato que dice si el recordatorio
sirve—. Y la cifra viaja también al **tablero del día** (`/inicio`).

Implicó recrear las dos vistas materializadas que salen de `fact_appointment` (`mv_funnel` y
`mv_daily_kpis`), porque además aprenden que `confirmada` **ocupa** la franja.

## Consecuencias

**A favor**

- El estado dice la verdad: «avisada» y «confirmada» dejan de ser lo mismo, en la jornada, en el
  bot, en el embudo y en el tablero.
- La secretaría sabe a quién llamar: la sección muestra quién no ha confirmado y por dónde se le
  puede escribir.
- La próxima cita del cierre deja de ser un fantasma: si el odontólogo quiere, existe en la
  agenda con su aviso, su `.ics` y su confirmación.
- Nada de esto rompe lo que había: `notificada → en_sala_espera` sigue permitido y confirmar no
  es requisito para llegar.

**En contra / deuda asumida**

- **Un estado más es un estado más**: hay que acordarse de él en los conteos de la jornada, en la
  máquina de estados, en el read model de reportes y en el índice de franja. La lista de sitios
  está en la migración y en las pruebas; el riesgo real era el índice, y se cubrió con una prueba
  que confirma y vuelve a intentar ocupar la franja.
- **Dos mensajes por aviso**: el paciente recibe el texto con el botón y luego el calendario. Es
  el precio de que pueda confirmar con un toque sin tocar el transporte ni el núcleo.
- **La confirmación no cambia el flujo del día**: no sustituye al «registrar llegada». Quien no
  confirma puede aparecer igual, y quien confirma puede no aparecer (queda como `no_asistio`
  cuando pasa la tolerancia).
- La sección de citas pagina sobre las **citas**, no sobre los avisos: no sustituye a la bandeja
  de envíos, que sigue siendo donde se ve cada mensaje con sus intentos y su error.

## Verificación

- Contratos: transiciones nuevas y conservadas, `REQUEST_STATUSES` = `APPOINTMENT_STATUSES` sin
  `confirmada`, el comando `confirmar` en el catálogo del bot, las plantillas nuevas.
- Integración de `scheduling`: confirmar desde `programada` y desde `notificada`, idempotencia
  (la fecha de confirmación no se mueve), fila en `status_history` con el canal, rechazo en un
  estado terminal y **la franja sigue bloqueada** después de confirmar.
- Integración de `notifications`: confirmar por botón y por texto, «ya estaba», «no hay nada que
  confirmar» y que una cita **ajena** no se confirma; y que el aviso de cita sale en dos mensajes
  (texto con la invitación, `.ics` con pie corto).
- Integración de `reporting`: el evento proyecta `confirmed_at`, entra en `assigned` y aparece
  como etapa del embudo; la cabecera del CSV la incluye.
- Migraciones aplicadas contra PostgreSQL real: el `CHECK` de la cita, el de la solicitud y el
  índice parcial con `confirmada`; `confirmed_at` en el hecho y `confirmed` en las dos vistas.
