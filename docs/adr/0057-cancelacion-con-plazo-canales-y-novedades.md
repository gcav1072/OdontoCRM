# ADR 0057 — La cancelación del paciente tiene plazo, la bandeja dice el nombre y el inicio cuenta las novedades

- **Fecha:** 2026-10-09 · **Estado:** aceptada
- **Relacionada:** [ADR 0029](0029-nucleo-conversacional-y-adaptadores.md) (núcleo conversacional y adaptadores),
  [ADR 0041](0041-el-evento-lleva-lo-que-el-consumidor-necesita.md) (el evento lleva lo que el consumidor necesita),
  [ADR 0052](0052-confirmacion-de-citas-por-el-paciente.md) (el paciente confirma su cita),
  [ADR 0053](0053-cancelacion-de-citas-por-el-paciente.md) (el paciente cancela su cita),
  [ADR 0056](0056-la-identidad-del-consultorio-vive-en-la-base.md) (la identidad del consultorio vive en la base).

## Contexto

Tres cosas se vieron al usar el sistema con pacientes de verdad:

1. **La tabla de canales vinculados no decía quién era el paciente.** Al vincular un chat por Telegram
   aparecía el usuario y la dirección, pero la columna «Paciente» salía siempre «Sin dato». La ruta
   `GET /api/v1/notifications/channels` **fijaba `patientName: null`**: el nombre vive en el servicio
   de pacientes y nadie lo resolvía.
2. **El paciente podía cancelar hasta el último momento.** Desde la
   [ADR 0053](0053-cancelacion-de-citas-por-el-paciente.md) el paciente cancela por Telegram o
   WhatsApp sin límite. Está bien que pueda hacerlo, pero quien **ya confirmó** su asistencia no
   debería poder soltar la cita la víspera por chat: el consultorio necesita tiempo para reaprovechar
   la franja.
3. **No había forma de enterarse sin abrir módulos.** Quién confirmó, quién canceló y quién se
   arrepintió está en los datos, pero para verlo había que entrar a `/programacion` y cruzar
   pestañas.

## Decisión

### 1. El nombre del paciente se resuelve en el servicio

La tabla de canales se compone **en el servicio de notificaciones**, como ya se hace con la sección de
citas ([`appointmentsInInbox`](../../services/notifications/src/appointments.ts)): cruzar dos consultas
con paginaciones que no encajan en el navegador sería peor. Nace `channelsInInbox`, que pide los
canales y luego **el nombre en un solo lote** por identificador.

Para eso se añadió una ruta interna en pacientes, `GET /internal/v1/patients/summaries?ids=…`,
protegida por el secreto de servicio como las demás: no pasa por el gateway ni pide JWT de usuario.

- El nombre es **informativo**: si el servicio de pacientes no responde, la fila sale con
  `patientName: null` (y la interfaz ya muestra «Sin dato») en vez de romper la pantalla.
- Arregla de paso lo ya vinculado: no depende de guardar nada nuevo al vincular.

### 2. El corte de cancelación: `notification_settings`, configurable y solo para admin y odontólogo

Se añade una configuración de una sola fila (mismo patrón que `billing_settings`):
`notification_settings.patient_cancel_cutoff_days`, con **0 = sin corte** por defecto.

La regla, en el asistente:

- una cita **ya confirmada** no se puede cancelar por el bot cuando le faltan **esos días o menos**
  (el corte se mide en el **calendario del consultorio**, Caracas);
- una cita **sin confirmar** se cancela siempre: el paciente no había prometido nada;
- el corte en **0 desactiva la regla**, así que activarla es una decisión explícita del consultorio;
- la guardia vive en el **bot**, no en la agenda: **la secretaría sigue cancelando sin límite** desde
  el mostrador. Es una política de atención al paciente, no una invariante de las citas.

Cuando el corte bloquea, el asistente responde con la plantilla nueva
`cita_cancelacion_fuera_de_plazo`, que **solo informa** («llama al consultorio»). No se le da un
camino para saltarse la regla.

El corte lo ven y lo editan **solo el `admin` y el odontólogo**, con el permiso nuevo
`scheduling:cancel_policy` (la secretaría **no**). La tarjeta de la interfaz solo se monta con ese
permiso y la API lo exige igual, así que no es una guardia de cosmética.

### 3. Las novedades del inicio

`GET /api/v1/appointments/activity` (con `scheduling:read`) devuelve las últimas novedades de citas
para pintarlas en `/inicio`, de la más reciente a la más vieja. La fuente es `status_history` —cada
confirmación y cada cancelación queda ahí con su hora— y el comportamiento sale de cruzar el estado
con la **fecha de confirmación** de la cita:

| Novedad | Cuándo |
| :--- | :--- |
| `confirmada` | Le dieron cita y confirmó (sigue en pie) |
| `cancelada` | Le dieron cita y canceló **sin haber confirmado** |
| `confirmada_y_cancelada` | Confirmó primero y **luego se arrepintió** |

Se filtra al **canal de paciente** (`telegram`/`whatsapp`): lo que hizo la secretaría no es una
novedad del paciente, y una confirmación **por teléfono** tampoco cuenta como del bot.

La tarjeta trae las **20 últimas** y muestra **5**, con un botón para desplegar el resto: el inicio es
un vistazo, no un listado (para el listado está `/programacion`).

## Consecuencias

- **Un permiso nuevo** (`scheduling:cancel_policy`) toca los tres sitios de siempre: `PERMISSIONS`,
  `ROLE_PERMISSIONS` y las etiquetas de la SPA. La prueba de contratos fija quién lo tiene.
- **Una tabla nueva** obliga a migración + registro en `meta/_journal.json`; como es **estructural**,
  su snapshot sí lleva la tabla (a diferencia de las migraciones que solo cambian texto, que copiaron
  el anterior). Se siembra la fila con `ON CONFLICT DO NOTHING` y la lectura la asegura igual, para
  una base restaurada de un respaldo viejo.
- **Un método nuevo en `InternalClients`** (`listPatientSummaries`) y una ruta interna en pacientes.
  Los dobles de las pruebas de notificaciones tienen que implementarlo (por defecto, `[]`).
- **La plantilla nueva** se siembra sola en el arranque (como todas) y es editable; su clave entra en
  `NOTIFICATION_TEMPLATE_KEYS` y en las etiquetas de la SPA.
- El corte **no** aparece en los PDF ni en los `.ics`: es una regla del bot.
- Lo que **no** se hizo a propósito: no se bloquea la cancelación de la secretaría, no se ofrecen
  botones de «escribir al consultorio» en el mensaje de fuera de plazo y no hay histórico paginado de
  novedades (sería una vista aparte).
