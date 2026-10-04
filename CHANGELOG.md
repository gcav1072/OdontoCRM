# Changelog

Todos los cambios relevantes de OdontoCRM. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
fases: cada fase termina con sus commits atómicos y su etiqueta `fase-N`.

## [Sin publicar] — Correcciones posteriores a la Fase 5 · 2026-10-03

### Corregido

- **Pantalla en negro en `127.0.0.1:5173`.** La causa no era la aplicación: un servidor de Vite
  **de una sesión anterior** seguía ocupando el puerto con el grafo de módulos roto, `npm run dev`
  no podía tomarlo (`strictPort`) y `concurrently -k` mataba el resto, así que el navegador seguía
  mirando el servidor viejo sin ningún mensaje. Se comprobó con Chromium sin interfaz: ese servidor
  dejaba `#root` vacío, mientras que uno recién arrancado y la app compilada montan bien.
- **El botón «Notificar» de la programación no enviaba nada.** Publicaba
  `scheduling.appointment.notified` y **ningún servicio lo consumía**: la cita quedaba como
  `notificada` sin que al paciente le llegara nada (comprobado en la base: 42 eventos publicados y
  cero avisos producidos por ellos). El mensaje que lo advertía en la interfaz hablaba de la
  «Fase 4» y parecía obsoleto; no lo era. Ahora el servicio de notificaciones consume el evento y
  aplica la política acordada: **asegura sin duplicar** — no repite el aviso que ya salió, recupera
  el que quedó en manual pendiente o falló, y solo la casilla «reenviar también los ya notificados»
  (`force`) vuelve a enviar, identificando el reenvío por su evento.
- **Textos que habían envejecido con el multicanal (Fase 4.1)**: la bandeja, las plantillas, el
  catálogo de canales y el aviso de la programación hablaban solo de Telegram; ahora nombran el
  canal del paciente, y la tarjeta de estado muestra los canales activos con su identidad.

### Añadido

- **`npm run dev:check`** (se ejecuta solo antes de `npm run dev`): comprueba los puertos del
  desarrollo y, si están ocupados, dice **quién** los ocupa (proceso y si es de PM2) y cómo
  liberarlos. Evita arrancar a medias.
- **`npm run dev:stop`**: para lo que dejó vivo un `npm run dev` anterior (Vite y servicios sueltos).
  No toca los procesos de PM2, que se paran con `pm2 stop all`, y lo explica.
- **`npm run check:web`**: abre la interfaz con Chromium sin interfaz y verifica que **monta** (el
  contenedor `#root` con contenido) y que la consola no trae errores. Es la comprobación que habría
  cazado la pantalla en negro: ninguna prueba unitaria puede verla.
- **Reserva visible en `index.html` y aviso de arranque en `main.tsx`**: si el paquete no llega a
  ejecutarse o falla al montar, la página muestra «Cargando OdontoCRM…» y, si hay error, el mensaje
  con un botón de recarga, en lugar de quedarse en negro.
- **`docs/COMANDOS.md`**: guía única de comandos (puesta en marcha, calidad, base de datos, semillas,
  arranque, humos, PM2/Fedora, «quiero hacer X» y problemas típicos). El README deja de duplicarla.

### Cambiado

- **`npm run db:verify-migrations` comprueba todos los servicios** desde cero en bases limpias (antes
  solo identity), replicando las extensiones que crea el bootstrap. Al hacerlo destapó que las
  migraciones de `patients` dependen de `pg_trgm` y que la tabla es `patient_files`.

## [Fase 5] — Secretaría y pantallas (lobby y consultorio) · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de pantallas ([ADR 0030](docs/adr/0030-pantallas-kiosko-y-sse.md)) —
  dispositivos kiosko con sus **ajustes** (voz, volumen, segundos de resalte y de repetición),
  estado de la sala (`LobbyState`, `ConsultationState`), llamados, **datos críticos** con severidad,
  tramas SSE, nombre abreviado para pantalla (`Juan P.`) y edad en UTC. 8 pruebas nuevas.
- **`services/screens`** (nuevo, puerto 4007, base `odonto_screens`): **proyección de la sala** por
  eventos de agenda (`en_sala_espera` → `llamado` → `en_consulta`, y fuera al atenderse, faltar o
  cancelarse), **histórico de llamados** idempotente por evento, dispositivos con latido, **flujo
  SSE** con estado completo, latido y `Last-Event-ID`, y rutas internas para los datos críticos que
  enviará la historia clínica.
- **`services/identity`**: `POST /api/v1/auth/device` cambia el **token de dispositivo** por un JWT
  de rol `pantalla` (solo `screens:display`), deja en auditoría los intentos fallidos y actualiza la
  última señal del dispositivo. `services/patients` expone la ficha interna por id (edad y sexo para
  la pantalla del consultorio).
- **Interfaz**: **`/secretaria`** (jornada hora por hora, buscador, contadores, registrar llegada,
  llamar —con segundo llamado—, pasar a consulta, marcar atendido con motivo y marcar inasistencia,
  y **llamada fuera de orden** con confirmación), **`/pantalla/lobby`** (displaylobby con turno,
  nombre abreviado, sillón, 2.º llamado en rojo y **voz en español**), **`/pantalla/consultorio`**
  (paciente en curso, motivo y **semáforo de riesgo** de los datos críticos) y **`/pantallas`**
  (registrar cada televisor, ajustar su voz y desactivarlo, con el enlace del token una sola vez).

### Cambiado

- La **agenda publica el motivo de la consulta** con el evento de la cita y su publicador del outbox
  late cada **500 ms** (antes 2 s): de ahí depende que un llamado llegue al lobby en menos de un
  segundo (medido: **882 ms** en la prueba de humo).
- El gateway deja pasar `POST /api/v1/auth/device` sin token (la pantalla no tiene usuario ni cookie).
- **El cambio de estado adelanta la publicación**: `outbox.kick()` saca el evento en el acto en vez
  de esperar al temporizador del publicador (medido: el tramo del outbox pasa de 0-500 ms a
  **15-50 ms**). La latencia extremo a extremo del llamado queda en **303, 443 y 304 ms** en tres
  corridas limpias (~0,8 s peor caso), dominada por el sondeo de `pg-boss` (que no admite menos
  de 500 ms).

### Corregido

- **El orden de los eventos del lote**: `pg-boss` no garantiza el orden y aplicar `called` antes que
  `checked_in` dejaba al paciente «esperando» en lugar de «llamado» (y `attended` antes que
  `in_consultation` volvía a ocupar el consultorio). El lote se ordena por `occurredAt` y la
  proyección no retrocede ni resucita a quien ya salió (lápida `left_at`).
- **Una consulta del camino crítico crecía con los datos** (migración `0001` de `screens`): contar
  los llamados de una cita y buscar el último de cada cita eran escaneos secuenciales —36 ms y
  38 ms con 200.000 llamados— y ahora son 0,08 ms y 0,03 ms con `idx_call_events_appointment`.

## [Fase 4.1] — Núcleo conversacional y adaptadores de canal · 2026-10-03

### Añadido

- **`packages/contracts`**: **intenciones** del asistente (`BOT_INTENTS`, `INTENT_PHRASES`,
  `detectIntent`, `normalizePhrase`) — Telegram traduce `/nueva` y WhatsApp «cita» a la misma
  intención—, estado por canal (`ChannelStatus`) y las conversaciones y canales con
  `canal`/`direccionMasked`/`usuario`. 30 pruebas del dominio de canal (6 nuevas de intenciones).
- **`services/notifications`**: **núcleo conversacional** (`src/core/asistente.ts`) que trabaja sobre
  `InboundMessage` y envía por el **adaptador** del canal, con las **opciones numeradas guardadas en
  la conversación** (donde no hay botones, responder «2» vale como pulsar el botón) e
  **idempotencia por `(canal, eventoId)`** (`update_id` o `wamid`).
- **`services/notifications`**: **webhook público** `GET/POST /api/v1/notifications/webhook/:canal`
  para los canales que empujan (WhatsApp Cloud API): verificación con `hub.challenge`, firma
  `x-hub-signature-256` obligatoria sobre el **cuerpo crudo** y entrega al núcleo; un mensaje que
  falle no tumba el lote (se cuenta y se registra).
- **`services/notifications`**: **kit de conformidad** (`canales/conformidad.test.ts`): el mismo
  juego de 24 pruebas contra Telegram, WhatsApp y el simulado.
- **`apps/gateway`**: los webhooks de canal son **prefijos públicos** (`PUBLIC_PREFIXES`): no exigen
  JWT porque la seguridad la da la firma del proveedor.
- **`.env.example`**: variables de WhatsApp Cloud API documentadas.

### Cambiado

- **Migración `0001` de `notifications`**: `chat_id` → **`direccion`** y `telegram_username` →
  `usuario`; `bot_conversations` pasa a clave **`(canal, direccion)`** con `opciones jsonb`;
  `processed_updates` pasa a **`(canal, evento_id)`** con `evento_id text` (admite el `wamid` de
  WhatsApp); se elimina `bot_state` (el `offset` de `getUpdates` vive dentro del adaptador).
- **Migración `0002` de `notifications`**: las plantillas sembradas que seguían con el texto por
  defecto hablan de intenciones («cita», «estado»…) en lugar de solo comandos; las editadas a mano
  se respetan.
- La cola de envíos manda **por el adaptador del canal** de cada aviso y el destino se resuelve por
  `(canal, dirección)`, prefiriendo el canal pedido y, si no está vinculado, el que tenga el paciente.
- El estado del bot en la bandeja lista **todos los canales** con su identidad y capacidades.
- `telegram.ts` pasa a `canales/telegram-api.ts`: es un detalle del adaptador de Telegram.

### Corregido

- El botón pulsado en un canal deja de ser un detalle del núcleo: lo acusa el adaptador.
- El texto de un botón interactivo de WhatsApp se conserva como contexto del mensaje.

## [Fase 4] — Bot de Telegram, avisos y `.ics` · 2026-10-03

### Añadido

- **`packages/contracts`**: dominio de notificaciones — pasos del asistente (`BOT_STEPS`),
  borrador de la conversación, validaciones del guion (nombre con título y sin números, fecha
  `dd/mm/aaaa`, datos enmascarados), **19 plantillas editables** con sus marcadores, estado del bot,
  canales y enlaces de vinculación, y **generador de `.ics` (RFC 5545)** con plegado a 75 octetos,
  escape, `SEQUENCE` y recordatorio 30 min antes. 20 pruebas nuevas (117 en el paquete).
- **`services/notifications`** (nuevo, puerto 4004, base `odonto_notifications`): **bot de Telegram
  con long polling único** (ADR 0008), asistente de **7 pasos** que valida y crea paciente + solicitud
  con ticket, `/start`, `/ayuda`, `/estado`, `/cancelar`, `/mi_ticket`, vinculación por **deep link
  y QR**, idempotencia por `update_id`, anti-flood, conversaciones reanudables, plantillas
  editables, **cola de envíos con reintentos y retroceso exponencial**, «aviso manual pendiente»
  cuando no hay Telegram y `ics_artifacts` con huella SHA-256 — más el **aviso inmediato al
  formalizarse la cita** con fecha, hora, lugar y el `.ics` adjunto.
- **Interfaz**: bandeja **`/notificaciones`** con estado del bot (real/simulado), contadores,
  conversaciones, envíos con filtros y detalle del mensaje, reintento manual, aviso de contacto
  telefónico, plantillas con vista previa y marcadores, y vinculación de pacientes con QR.

### Cambiado

- **Reparto de eventos por servicio**: cada consumidor declara `domain-events.<servicio>` y el
  publicador entrega una copia en **todas** las colas, así que todos los servicios ven todos los
  eventos (antes, con una sola cola, se los repartían).
- El `.ics` se descarga desde `/api/v1/notifications/ics/:appointmentId`.

### Corregido

- Los avisos se daban por fallidos al primer intento (`maxAttempts` en 1) en lugar de reintentar.

## [Fase 3] — Agenda: tickets, cupos y programación de la jornada · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de agenda — solicitud con ticket, cita, cupo del día, plantilla
  de franjas, vista de la jornada, historial de estados, vista previa del aviso, y utilidades puras
  de hora (`addMinutes`, `minutesBetween`, `formatTime12h`, `expandTemplateSlots`, `weekdayOf`) con
  24 pruebas nuevas (145 en el paquete). Se añade el permiso `scheduling:overbook` (solo `admin`) y
  la **carga genérica de auditoría** que publican los servicios nuevos.
- **`services/scheduling`** (nuevo, puerto 4003, base `odonto_scheduling`): **secuencia atómica de
  tickets** (`nextval`, con salto a `A-000001`), cola «en espera de cita» ordenada por prioridad,
  ticket o antigüedad, **cupo diario editable** (bajarlo avisa y no borra citas), plantillas de
  franjas por día con pausas, asignación por franja u **hora manual**, **sobrecupo solo con permiso
  del admin y motivo**, **índice único parcial** que impide dos citas a la misma hora, reprogramación
  que conserva el ticket y enlaza la cita nueva, cancelación, **inasistencia con tolerancia de 15
  minutos**, `status_history` con actor y hora, y aviso en lote con vista previa y evento para la
  Fase 4.
- **`services/identity`**: el consumidor de eventos admite la carga genérica de auditoría, guarda un
  **resumen legible** por evento (migración `0003`) y consume en **lotes de 50 cada segundo**.
- **Interfaz**: página **Programación** (`/programacion`) con la cola de solicitudes (filtros,
  búsqueda diferida, nueva solicitud con búsqueda de paciente), la jornada del día (selector de
  fecha, cupo con contador `asignados/cupo` y aviso, franjas con arrastrar-y-soltar y teclado, hora
  manual, sobrecupo, contadores de ocupación), la tabla de citas con las acciones de la máquina de
  estados, el historial y el diálogo de **aviso en lote** con la vista previa exacta.

### Cambiado

- **Cancelar una cita devuelve el ticket a la cola** ([ADR 0028](docs/adr/0028-cancelar-devuelve-el-ticket.md)).
- El outbox publica en la cola compartida y el consumidor trabaja por lotes: un pico de 150 eventos
  pasa de tardar minutos a segundos.
- `seed:agenda` siembra solicitudes y citas de ejemplo en el próximo día de consulta real.

### Corregido

- El trabajador de la cola dejaba eventos en estado `created` durante minutos (auditoría con retraso)
  por usar el tamaño de lote y el sondeo por defecto de pg-boss.

## [Fase 2] — Pacientes, registro y auditoría de datos sensibles · 2026-10-03

### Añadido

- **`packages/contracts`**: contratos de paciente — identificación **V/E/P/SC**
  (`normalizeDocNumber`, `parseDocumentText`, `validateDocument`, `formatDocument`,
  `documentKey`), edad y minoría de edad en UTC, teléfono de Venezuela normalizado a `+58`,
  `cleanText` para texto libre, esquemas de alta/edición (**motivo obligatorio**), cambio de
  estado, **borrado lógico**, representante, adjuntos, filtros de búsqueda y la carga de auditoría
  que viaja por el outbox. 22 pruebas nuevas (55 en el paquete).
- **`services/patients`** (nuevo, puerto 4002, base `odonto_patients`): paciente único por
  documento con índice único parcial y **409 con `existingPatientId`** ante duplicados,
  representante obligatorio para menores, historial local de datos de contacto, **adjuntos en
  disco** con almacén abstraído (JPG/PNG/WEBP/PDF, máx. 20 MB, metadatos y SHA-256 en la base),
  búsqueda por nombre (trigramas `pg_trgm`), documento, teléfono, estado, sexo y rango de edad, y
  **endpoint interno idempotente** `upsert-by-cedula` para el bot y otros servicios.
- **`packages/db`**: publicador del outbox por intervalos (`createOutboxRunner`, sin ciclos
  solapados y con parada ordenada) y `toOutboxInsert` para insertar el evento **en la misma
  transacción** del cambio de datos con Drizzle.
- **`services/identity`**: **consumidor de eventos** idempotente (`processed_events`) que
  convierte los cambios de paciente en filas de `audit_events` con `before`, `after`, motivo,
  usuario, IP y agente.
- **Interfaz**: página **Registro** (`/registro`) con selector de tipo de cédula, máscara,
  autocompletado al salir del campo, ficha en solo lectura y botón **Editar** que exige motivo y
  confirma los cambios uno por uno; página **Pacientes** (`/pacientes`) con búsqueda con retardo,
  filtros, paginación y ficha con adjuntos y cambio de estado; y **Eliminar del registro** en la
  ficha (solo `admin`), con motivo obligatorio.

### Decidido con el usuario (2026-10-03)

- El **odontólogo registra y edita** pacientes (`patients:write` y `patients:edit_sensitive`); el
  borrado queda reservado al `admin` (`patients:delete`, [ADR 0027](docs/adr/0027-borrado-logico-de-pacientes.md)).
- El **tema** sigue siendo preferencia del equipo, no del usuario.
- Se mantiene la **cola de eventos compartida** ([ADR 0026](docs/adr/0026-cola-de-eventos-compartida.md)).
- El **bot avisará al formalizarse la cita** (fecha, hora, lugar y `.ics` adjunto), además de los
  recordatorios de 24 h y 2 h (Fase 4).
- El **membrete** sigue genérico hasta la Fase 7.

### Cambiado

- **La cola de eventos es compartida** (`odonto_events`, [ADR 0026](docs/adr/0026-cola-de-eventos-compartida.md)):
  `db:bootstrap` crea la base y reparte `EVENTS_DATABASE_URL` a todos los servicios.
- El gateway **elimina `Expect`** antes de reenviar (PowerShell y `curl` enviaban la cabecera y el
  proxy respondía 500).
- Los campos opcionales del contrato aceptan `null` además de `''`.
- Los errores RFC 7807 admiten **miembros de extensión** (`existingPatientId`).
- `seed:demo` avisa si ya hay datos ficticios en lugar de chocar con el índice único.

### Corregido

- **Edad y minoría de edad** se calculaban mezclando fecha UTC con getters locales: en Venezuela
  (UTC−4) un menor de 18 podía contar como mayor un día antes.

## [Fase 1] — Identidad, roles y shell de UI · 2026-10-02

### Añadido

- **`packages/contracts`**: contratos de sesión y usuarios — `loginSchema`, `AccessTokenClaims`,
  `LoginResponse`, `SessionInfo`, `UserSummary`, creación/edición de usuarios, cambio y
  restablecimiento de contraseña, catálogo de dispositivos kiosko, **auditoría** (`audit_events`,
  filtros de consulta y `diffSensitiveFields`), y utilidades de permisos (`hasPermission`,
  `permissionsForRoles`) con 13 pruebas.
- **`packages/kernel`**: seguridad compartida — contraseñas con **scrypt** (parámetros
  versionados en el propio hash, verificación en tiempo constante y `needsRehash`), claves
  **EdDSA** (generación, carga e importación desde PEM), firma y verificación de **JWT**
  (emisor, audiencia y caducidad), tokens opacos con hash SHA-256, **guardias de permiso**
  asíncronas para Fastify y `parseOrThrow` para validar la entrada con Zod.
- **`services/identity`**: esquema completo (usuarios, roles, tokens de refresco, dispositivos
  kiosko y auditoría) con su migración; **login** con bloqueo tras 5 intentos (15 minutos);
  **refresh rotativo con detección de reuso** (revoca la sesión completa y lo audita) con
  ventana de gracia de 30 s para la carrera entre pestañas; **logout**; `/auth/me` para el panel
  inferior; **cambio de contraseña** propio (cierra las demás sesiones); CRUD de **usuarios**
  con motivo obligatorio y auditoría del cambio; **restablecimiento de contraseña** con
  contraseña temporal generada; **dispositivos kiosko** (el token se muestra una sola vez);
  y **consulta de auditoría** filtrable. Semilla de usuarios (`admin`, `recepcion`, `egomez`)
  y generación de claves con `npm run keys:generate`.
- **`apps/gateway`**: guardia de autenticación — borra las cabeceras `x-user-*` que envíe el
  cliente, deja públicas solo la salud y el ciclo de autenticación, verifica el JWT y publica
  la identidad (usuario, roles, permisos, sesión y contraseña pendiente) al servicio interno.
  Cada servicio pasa a ser dueño de su prefijo público (las rutas ya no se recortan).

### Verificado

- `npm run verify` en verde: **98 pruebas** unitarias y de contrato.
- **Pruebas de integración de autenticación contra PostgreSQL real** (`npm run test:integration`,
  7 pruebas): login y auditoría; credenciales incorrectas sin revelar si el usuario existe;
  bloqueo de 15 minutos tras 5 intentos; rotación del refresco, ventana de gracia y **reuso
  revocando la familia**; cierre de sesión; 403 por permiso y 200 para el administrador; cambio
  de contraseña.
- **Recorrido de extremo a extremo por el gateway real** (18 comprobaciones): salud pública,
  401 sin token, suplantación de cabeceras rechazada, login con cookie `httpOnly` y ruta
  `/api/v1/auth`, bloqueo por contraseña pendiente, `/me`, rotación del refresco, token
  inválido y cierre de sesión.
- Regresión cubierta por prueba: un `preHandler` **síncrono** colgaba las peticiones en Fastify;
  las guardias son asíncronas y hay una prueba que lo vigila.

## [Fase 0] — Fundación del repositorio e infraestructura local · 2026-10-02

### Añadido

- **Monorepo** con npm workspaces: `apps/*`, `services/*`, `packages/*`, `infra/`, `tools/`.
- **`packages/contracts`**: roles y permisos, enums de estados (paciente, cita, historia,
  sesión, récipe, notificación, pantalla), máquina de estados de la cita aprobada,
  formato y parseo del ticket (`#000123` → `A-000001` al desbordar 999.999), paginación y
  errores en formato RFC 7807.
- **`packages/events`**: catálogo de tópicos de dominio y sobre (`envelope`) validado con Zod.
- **`packages/db`**: pool de PostgreSQL, cliente Drizzle, migrador versionado, tabla y
  publicador del **outbox transaccional**, envoltorio de **pg-boss** (cola `domain-events`
  con reintentos y retención).
- **`packages/kernel`**: configuración validada con Zod que **no arranca** si falta una
  variable y **no repite valores** en el error; logger con censura de credenciales; errores
  RFC 7807; `/health` y `/ready` con verificaciones y tiempo límite.
- **`packages/testing`**: generador pseudoaleatorio determinista (mulberry32) y fábricas para
  el modo test (cédulas ficticias en el rango reservado 90.000.000+).
- **`services/identity`** (esqueleto de la Fase 1): configuración propia, esquema `users`,
  migración inicial con `users` y `outbox_events`, y `/ready` que verifica PostgreSQL.
- **`apps/gateway`**: proxy por recurso según el mapa de rutas del plan, CORS restringido al
  origen de la SPA y límite de 600 peticiones por minuto.
- **`infra/db/bootstrap.mjs`**: crea las 8 bases y sus roles con contraseñas aleatorias,
  habilita `pgcrypto` y `pg_trgm`, fija la zona horaria `America/Caracas` y escribe las
  credenciales en el `.env` de cada servicio (sin imprimirlas). Idempotente; `--rotate` y
  `--only` disponibles.
- **`tools/check-secrets.mjs`**: audita lo preparado para commitear (o todo el repositorio con
  `--all`) buscando tokens de Telegram, claves PEM, cadenas de conexión con contraseña,
  claves de AWS y GitHub, y archivos que nunca deben versionarse.
- **`tools/migrate-all.mjs`**: aplica las migraciones de todos los servicios compilados.
- **`tools/verify-migrations.mjs`** (`npm run db:verify-migrations`): crea una base limpia, aplica
  las migraciones con el migrador real, comprueba tablas, migraciones registradas e índices, y
  borra la base temporal. Convierte el criterio «migraciones desde cero» en un comando.
- **`tools/test-integration.mjs`** (`npm run test:integration`): pruebas contra PostgreSQL real
  (outbox transaccional y cola `pg-boss`).
- **Guía de producción en Fedora** ([`infra/fedora/`](infra/fedora/INSTALL.md)): guía paso a paso
  (paquetes `dnf`, PostgreSQL 18, usuario de sistema, permisos, secretos, `systemd` o PM2,
  `firewalld`, SELinux, TLS interno, Tailscale, respaldos y restauración con prueba documentada,
  rollback y 33 puntos de comprobación), `install.sh` idempotente que simula por defecto, las dos
  unidades `systemd`, el `ecosystem.config.cjs` de PM2 y los scripts de respaldo/restauración
  (restauración primero en una base temporal de verificación). Los 38 puntos que solo se pueden
  probar en el servidor real están marcados como `> PENDIENTE FASE 10:`.
- **Documentación**: política de secretos ([`docs/SEGURIDAD_SECRETOS.md`](docs/SEGURIDAD_SECRETOS.md)),
  ADRs, guía de instalación en Windows y borrador de producción en Fedora.
- **Calidad**: TypeScript 5.9 estricto, ESLint 10 con reglas anti SQL-injection, Prettier,
  Vitest, y la puerta única `npm run verify`. **56 pruebas en verde.**

### Decisiones tomadas

- PostgreSQL **18** (el instalado en la máquina) en lugar de 16; Fedora se alinea a la misma
  versión mayor.
- **TypeScript 5.9.3** en lugar de 7.x: `typescript-eslint` 8.71 solo admite `<6.1`.
- Horas en la interfaz en **formato de 12 h** con `a. m.` / `p. m.` (en base de datos, logs y
  `.ics` se guardan en 24 h).
- Contraseñas con **scrypt** de `node:crypto`: sin dependencias nativas ni compilador de C++
  en Windows.

### Corregido

- Enlace roto a `odontograma.md` en `docs/formato_historia.md`, que apuntaba a un archivo
  inexistente.
- Normalización de fin de línea con `.gitattributes` (`eol=lf`) para que Windows y Fedora
  compartan el mismo contenido.
- **Puerto del gateway: 8090 en lugar de 8080.** En esta máquina Windows el 8080 lo ocupa el
  servicio de red del host (`hns`/Hyper-V) y el gateway fallaba con `listen EACCES`. Se unificó
  el nuevo puerto en el código, `.env.example`, README, plan maestro y guía de Fedora.

### Verificado

- `npm run verify` en verde: escáner de secretos, ESLint, Prettier, compilación y **56 pruebas**.
- **Pruebas de integración contra PostgreSQL real** (`npm run test:integration`, 4 pruebas): el
  outbox guarda, reclama y marca como publicado; rechaza un `eventId` duplicado; reprograma el
  reintento cuando la entrega falla; y la cola **pg-boss** declara la cola, recibe el evento y lo
  consume un trabajador.
- `npm run db:bootstrap` crea las **8 bases** con su rol propietario y es **idempotente** (segunda
  ejecución: «ya existía» / «conservada del .env», sin rotar contraseñas).
- `npm run db:migrate` aplica la migración inicial (`users` + `outbox_events`) en PostgreSQL 18.6.
- Arranque con PM2 y comprobación real: `GET :8090/health` (gateway), `GET :8090/api/v1/auth/health`
  y `GET :8090/api/v1/users/health` (proxy hacia identity) y `GET :4001/ready` con
  `database: ok`. Ruta desconocida → 404 en `application/problem+json`.
- `.gitignore`: `node_modules`, `dist/` y todos los `.env` quedan fuera del control de versiones
  (comprobado con `git check-ignore`).
- **Migraciones desde cero en base limpia** (`npm run db:verify-migrations`): base temporal creada
  con el rol del servicio, migración aplicada con `runMigrations`, tablas `users` y `outbox_events`
  presentes, 1 migración registrada, índices del outbox correctos y base temporal eliminada.
- **Guía de Fedora**: `bash -n` en los 3 scripts, `node --check` del ecosistema de PM2, sin CRLF en
  ningún archivo, UTF-8 sin BOM y sin secretos en los ejemplos (`check-secrets --all`).
- **Documentación**: 32 documentos con todos sus enlaces relativos resolviendo y las 25 ADRs
  indexadas sin huérfanas.
