# OdontoCRM

CRM para un consultorio odontológico: gestión de citas, secretaría, historia clínica,
odontograma, récipes, reportes y auditoría — construido como **microservicios Node.js +
TypeScript** sobre **PostgreSQL**, pensado para correr en la red local de la clínica y,
más adelante, fuera de ella por VPN.

> **Estado: Fase 10 completada — el sistema está listo para la clínica** (tag `fase-10`,
> 2026-10-04). Las diez fases del plan están implementadas y validadas: identidad y sesiones,
> pacientes, agenda, bot de Telegram, secretaría y pantallas kiosko, historia clínica,
> odontograma FDI, sesiones y récipes A5 con QR, reportes y auditoría, y —en esta última— el
> **modo test**, el **seed determinista**, la **observabilidad** (`npm run estado`) y el
> **despliegue Fedora probado de punta a punta** (systemd, TLS interno, firewall, SELinux,
> respaldo diario con restauración verificada y prueba de reinicio).
>
> **Por dónde empezar según quién seas:**
>
> | Quiero… | Documento |
> | :--- | :--- |
> | **Instalar el servidor de la clínica** | `sudo bash infra/fedora/instalar/instalar.sh` y, para el detalle, [`INSTALL.md`](infra/fedora/INSTALL.md) §3-bis |
> | **Operar el sistema ya instalado** | [`infra/fedora/RUNBOOK.md`](infra/fedora/RUNBOOK.md) y [`docs/COMANDOS_PRODUCCION.md`](docs/COMANDOS_PRODUCCION.md) |
> | **Usar el consultorio** (sin terminal) | [`docs/OPERACION_CLINICA.md`](docs/OPERACION_CLINICA.md) |
> | **Conectar tablets, móviles y TVs** | [`docs/CERTIFICADO_EN_LOS_EQUIPOS.md`](docs/CERTIFICADO_EN_LOS_EQUIPOS.md) |
> | **Desarrollar** | este README y [`docs/COMANDOS.md`](docs/COMANDOS.md) |
> | **Entender las decisiones** | [`docs/adr/`](docs/adr/README.md) (48 ADRs) y [`docs/PLAN_MAESTRO_FASES.md`](docs/PLAN_MAESTRO_FASES.md) |
> | **Ver qué se probó y con qué evidencia** | [`infra/fedora/INSTALL.md` §20](infra/fedora/INSTALL.md) y [`docs/REVISION_SEGURIDAD_FASE_10.md`](docs/REVISION_SEGURIDAD_FASE_10.md) |

---

## Requisitos

| Componente | Versión usada | Nota |
| :--- | :--- | :--- |
| Node.js | 26.10 en el servidor (mínimo 22.9) | `--env-file-if-exists` y `--watch` nativos |
| npm | 11 (workspaces) | no se usa pnpm ni Docker |
| PostgreSQL | 18 | una base de datos por servicio |
| PM2 | global (opcional) | alternativa a `systemd`; **el supervisor validado en producción es `systemd`** |
| Git | 2.55 | |

---

> **¿Es el servidor de la clínica y no una máquina de desarrollo?** Entonces esto no es lo
> que buscas: en una PC nueva, **un solo comando** hace todo (máquina, bases, usuarios,
> despliegue, TLS, firewall, SELinux, respaldos y el nombre para los equipos):
>
> ```bash
> sudo bash infra/fedora/instalar/instalar.sh
> ```
>
> Son cuatro piezas que se pueden ejecutar y comprobar por separado (preparar · aprovisionar ·
> desplegar · verificar) encadenadas por ese comando, y **una sola fuente de verdad para las
> credenciales** (`/etc/odontocrm`): el código desplegado no contiene ninguna. Detalle paso a
> paso en [`infra/fedora/INSTALL.md`](infra/fedora/INSTALL.md) §3-bis; para una
> instalación que ya existe, `sudo odontocrm actualizar`. Lo de aquí abajo levanta una **pila
> de desarrollo** con recarga automática.

## Puesta en marcha (desarrollo)

```powershell
# 1. Variables de entorno: crea el .env de la raíz con la contraseña del superusuario
copy .env.example .env
notepad .env            # completa PG_ADMIN_URL=postgres://postgres:TU_PASSWORD@127.0.0.1:5432/postgres

# 2. Dependencias
npm install

# 3. Crea las 8 bases, sus roles y las credenciales de cada servicio
npm run db:bootstrap

# 4. Compila, genera las claves del JWT, migra y siembra los usuarios iniciales
npm run build
npm run keys:generate          # claves EdDSA del JWT (una sola vez; .keys/ está ignorado)
npm run db:migrate
npm run seed:users             # admin, recepcion y egomez con contraseña temporal

# 5. Arranca (una sola pila a la vez: mira quién corre antes de arrancar)
npm run stack:status           # ¿hay algo corriendo? ¿quién, en qué puerto y desde cuándo?
npm run stack:dev              # todo con recarga (tsc --watch + servicios + interfaz)
#   o bien
npm run stack:fijo             # todo con PM2, sin recarga (sobrevive a la terminal)
```

La primera vez que entres, el sistema te pedirá cambiar la contraseña temporal: hasta que lo
hagas, ningún módulo queda habilitado (es una regla del servidor, no solo de la interfaz).

Credenciales sembradas (`admin` → `admin-odontocrm-2026`, `recepcion` → `recepcion-odontocrm-2026`,
`egomez` → `consultorio-odontocrm-2026`). ¿Se te olvidó alguna, o no sabes si sigue valiendo?

```powershell
npm run seed:users -- --print    # las recuerda y dice si sirven, si las cambiaron o si está bloqueada
npm run seed:users -- --reset    # las devuelve a la temporal (limpia bloqueos e intentos)
```

Comprobación rápida:

```powershell
curl http://127.0.0.1:8090/health          # el gateway responde
curl http://127.0.0.1:8090/api/v1/auth/health   # el gateway reenvía a identity
curl http://127.0.0.1:4001/ready           # identity + PostgreSQL
```

Los secretos **nunca** se versionan ni se comparten por chat: ver
[`docs/SEGURIDAD_SECRETOS.md`](docs/SEGURIDAD_SECRETOS.md).

---

## Scripts

La lista completa (con flags, requisitos, variables de entorno y problemas típicos)
está en **[`docs/COMANDOS.md`](docs/COMANDOS.md)
- [`docs/COMANDOS_PRODUCCION.md`](docs/COMANDOS_PRODUCCION.md) — comandos del servidor en producción (`sudo odontocrm …`).**. Estos son los del día a día:
- [`docs/CERTIFICADO_EN_LOS_EQUIPOS.md`](docs/CERTIFICADO_EN_LOS_EQUIPOS.md) — instalar el certificado del servidor en tablets, móviles, PCs y TVs.

| Comando | Qué hace |
| :--- | :--- |
| `npm run stack:status` | ¿Qué pila está corriendo (dev con recarga o PM2), quién la tiene y desde cuándo? |
| `npm run stack:dev` / `stack:fijo` / `stack:down` | Cambiar de modo sin dejar dos pilas vivas, o parar todo |
| `npm test` | Pruebas unitarias y de contrato (Vitest) |
| `npm run test:integration` | Suites contra PostgreSQL real (outbox, colas, sesión, pacientes, agenda, pantallas, reportes) |
| `npm run smoke:<módulo>` | Recorrido de punta a punta por el gateway: `auth`, `patients`, `agenda`, `notifications`, `screens`, `odontogram`, `clinical`, `prescription`, `reporting` |
| `npm run e2e:flujo` | **El día completo en un navegador de verdad**: `/flujo` con Chromium (Fase 8) |
| `npm run e2e:reportes` | `/reportes` y `/auditoria` con Chromium: gráficas, seis pestañas, filtros y diff (Fase 9) |
| `npm run estado` | **Tablero de estado**: los 9 servicios (`/health` y `/ready`), las 9 bases, la cola, el outbox, los envíos y el disco |
| `npm run estado -- --alertas` | Solo los problemas; sale con 1 si hay alguno (es lo que corre el temporizador del servidor) |
| `npm run seed:test` | **Mundo de prueba determinista**: 40 pacientes, 46 solicitudes, 42 citas, 22 historias, 27 sesiones, 22 récipes, 156 hallazgos y los 593 eventos que el sistema habría publicado |
| `npm run seed:verify` | Comprueba por huellas que lo sembrado es el mundo (12 comprobaciones) |
| `npm run seed:reset` | Quita solo lo ficticio (los datos reales y los documentos clínicos no se tocan) |
| `npm run e2e:clinica` | **La aceptación completa**: los 11 pasos del día de la clínica encadenados, con `--sin-bot` si no hay token |
| `npm run db:reset` | **Borra todo** y deja el sistema listo para usar (bases migradas + usuarios); solo en desarrollo |
| `npm run fedora:check` | Comprueba que las plantillas del despliegue Fedora no se quedaron atrás respecto al código |
| `npm run reports:latencia` | Llena el read model con 10.000 citas y mide los seis reportes (criterio: < 2 s cada uno) |
| `npm run db:reset -- --yes` | **Empezar de cero**: borra las 9 bases y `storage/`, y deja todo migrado y sembrado (solo consola; sin `--yes` no borra nada) |
| `npm run env:check` | ¿A algún `.env` le falta una clave de su plantilla (`.env.example`)? |
| **`npm run verify`** | **Puerta de calidad: secretos + lint + formato + compilación + pruebas unitarias** |

Antes de cerrar cualquier fase, `npm run verify` debe pasar en verde, además de
`npm run db:verify-migrations` y el humo del módulo tocado.

---

## Estructura

```
apps/gateway          API Gateway: proxy por recurso, CORS, límite de peticiones
apps/web              SPA de React (Fase 1)
assets/clinic         Logo del consultorio para el membrete (opcional)
packages/contracts    Enums, estados, DTOs, utilidades puras y **los datos del consultorio**
packages/events       Catálogo de eventos de dominio y sobre validado con Zod
packages/db           Pool PostgreSQL, Drizzle, migraciones, outbox y pg-boss
packages/kernel       Config validada, logger censurado, errores RFC 7807, /health y /ready
packages/testing      Generador determinista y fábricas para el modo test
services/<nombre>     Un servicio por contexto delimitado, con su propia base de datos
infra/db              Bootstrap de bases, roles y credenciales
infra/windows         Arranque y operación en Windows (desarrollo)
infra/fedora          Guía y scripts de producción en Fedora
tools                 Scripts de apoyo (verificación de secretos, migraciones)
docs                  Plan maestro, formato de historia clínica y ADRs
```

### Poner el sistema con otro odontólogo

**Un solo archivo:** [`packages/contracts/src/clinic.ts`](packages/contracts/src/clinic.ts). Ahí están el
nombre del consultorio, la dirección, la ciudad, los teléfonos, el RIF, el correo, el sitio web, el
logo y **los odontólogos que firman** (usuario, nombre, MPPS, especialidad, colegiatura y correo).
Lo que se deje en `null` simplemente **no se imprime**.

| Qué cambia | Dónde se nota |
| :--- | :--- |
| `name`, `address`, `city` | Avisos del bot, `.ics`, pantallas y membrete del récipe |
| `phones`, `email`, `rif`, `website` | Membrete del récipe |
| `logoPath` (por defecto `assets/clinic/logo.png`) | Logo del membrete; si el archivo no está, sale sin logo |
| `dentists[]` | Quién firma los récipes (con su MPPS) y **las cuentas que crea `npm run seed:users`** |

Después: `npm run build` (los servicios y la web lo compilan dentro) y, si se añadió o cambió un
odontólogo, `npm run seed:users`. El logo se deja en [`assets/clinic/`](assets/clinic/README.md).

- **¿Por qué en el código y no en un `.env` o en una pantalla de ajustes?** Porque el paquete de
  contratos **ya lo importan los ocho servicios y la interfaz**: leerlo no añade cableado (ni rutas,
  ni endpoints, ni migración, ni permisos), no hay que repetir el mismo dato en tres `.env` y no se
  puede olvidar uno. Un dato que cambia una vez cada varios años no justifica una tabla.
- **¿Y si una instalación concreta necesita otro valor sin recompilar?** Las variables
  `CLINIC_NAME`, `CLINIC_ADDRESS` y `CLINIC_EMAIL` del `.env` siguen mandando sobre estos valores
  (están en [`.env.example`](.env.example)).
- Lo que falte para un membrete completo se enumera solo con `letterheadMissingFields()` (por
  ejemplo «MPPS del odontólogo»), así que el récipe avisa en vez de inventar un número.

### Puertos (todos en `127.0.0.1`; la red local entra solo por el gateway)

| Servicio | Puerto | Estado |
| :--- | :-: | :--- |
| gateway | 8090 | ✅ Fase 0 |
| identity | 4001 | ✅ Fase 0 (salud) · Fase 1 (usuarios y auth) |
| patients | 4002 | ✅ Fase 2 |
| scheduling | 4003 | ✅ Fase 3 |
| notifications | 4004 | ✅ Fase 4 (Telegram) · Fase 4.1 (multicanal + webhook) |
| clinical | 4005 | ✅ Fase 6 (historia clínica) · Fase 7 (sesiones, adjuntos y récipes A5) |
| odontogram | 4006 | ✅ Fase 6, sesión B (odontograma FDI) |
| screens | 4007 | ✅ Fase 5 (secretaría y pantallas con SSE) |
| reporting | 4008 | ✅ Fase 9 (read model, KPIs y auditoría UI) |

Además, la Fase 10 dejó el **modo test** (`TEST_MODE`, banner y envíos bloqueados), el **seed
determinista** (`npm run seed:test`, `seed:reset`, `seed:verify`) y el **tablero de estado**
(`npm run estado`, con `--alertas` para el temporizador del servidor).

---

## API de la Fase 1 (identidad y sesión)

Todo entra por el gateway (`http://127.0.0.1:8090`). El gateway **verifica el JWT**, borra
cualquier cabecera `x-user-*` que venga del cliente y publica la identidad real para los
servicios internos.

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `POST /api/v1/auth/login` | Inicia sesión: token de acceso (15 min) + cookie de refresco `httpOnly` | público |
| `POST /api/v1/auth/refresh` | Rota la sesión; un token reutilizado revoca la sesión completa | cookie |
| `POST /api/v1/auth/logout` | Cierra la sesión actual | cookie |
| `GET /api/v1/auth/me` | Datos del login para el panel inferior (inicio, caducidad, IP) | sesión |
| `POST /api/v1/auth/password/change` | Cambia la propia contraseña y cierra las demás sesiones | sesión |
| `GET /api/v1/users` · `POST` · `GET/PATCH /:id` · `POST /:id/reset-password` | Gestión de usuarios (el `PATCH` exige motivo y queda auditado) | `users:manage` |
| `GET /api/v1/users/roles` | Catálogo de roles y sus permisos | `users:manage` |
| `GET /api/v1/devices` · `POST` · `DELETE /:id` | Tokens de las pantallas kiosko (el token se muestra una sola vez) | `screens:manage` |
| `GET /api/v1/audit/events` | Auditoría con filtros por fecha, usuario, acción, entidad y campo | `audit:read` |

Reglas que aplica el servidor (no solo la interfaz):

- **5 intentos fallidos bloquean la cuenta 15 minutos** (y el bloqueo queda auditado).
- Mientras la contraseña esté pendiente de cambio, **ningún** módulo responde: solo el cambio
  de contraseña.
- Los errores son **RFC 7807** (`application/problem+json`) con `detail` en español y detalle
  por campo cuando es un problema de validación.
- Toda acción sensible (accesos, cambios de usuario, contraseñas, dispositivos) deja una fila
  en `audit_events` con actor, IP, momento y valores anterior/nuevo.

---

## API de la Fase 2 (pacientes)

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/patients` | Lista con búsqueda (nombre, documento, teléfono), estado, tipo de documento, sexo y rango de edad | `patients:read` |
| `GET /api/v1/patients/lookup?document=…` | Resuelve una cédula escrita de cualquier forma (`V-12345678`, `v 12.345.678`); responde `{found:false}` si no existe | `patients:read` |
| `POST /api/v1/patients` | Alta de paciente (representante obligatorio para menores) | `patients:write` |
| `GET /api/v1/patients/:id` | Ficha completa con representante y número de adjuntos | `patients:read` |
| `PATCH /api/v1/patients/:id` | Edita datos **con motivo obligatorio**; el cambio queda auditado con el valor anterior y el nuevo | `patients:edit_sensitive` |
| `POST /api/v1/patients/:id/status` | Activación/desactivación con motivo | `patients:edit_sensitive` |
| `POST /api/v1/patients/:id/delete` | **Borrado lógico** con motivo: sale de listas y búsquedas y libera el documento; nada se destruye | `patients:delete` (**solo admin**) |
| `GET/POST/DELETE /api/v1/patients/:id/files[/:fileId]` | Radiografías, fotos y PDF (JPG/PNG/WEBP/PDF, máx. 20 MB) | `patients:read` / `patients:write` |
| `POST /internal/v1/patients/upsert-by-cedula` | Alta o actualización idempotente por documento, para el bot y otros servicios | secreto interno |

- **El documento es la identidad**: `V-12345678`, `v 12.345.678` y `12345678` resuelven al mismo
  paciente. Una cédula repetida responde **409** con `existingPatientId` para abrir esa ficha.
- **Quién puede qué**: `admin` todo; `secretario` y `odontologo` registran y editan pacientes (toda
  edición queda auditada con motivo); **eliminar** del registro es exclusivo del `admin`.
- **Los cambios sensibles viajan por el outbox** (en la misma transacción del cambio) hasta la
  **cola compartida** y de allí a la auditoría de identity, con `before`/`after`, motivo, usuario
  e IP. Los consumidores son idempotentes (`processed_events`).
- Los adjuntos se guardan en disco (`STORAGE_DIR`, ignorado por Git) con los metadatos en la base;
  el binario solo se sirve por un endpoint autorizado, nunca por ruta directa del sistema.

---

## API de la Fase 3 (agenda)

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/requests` | Cola de solicitudes con filtros (estado, canal, búsqueda por ticket/nombre/documento) y orden por ticket o antigüedad | `scheduling:read` |
| `POST /api/v1/requests` | Nueva solicitud: el **ticket** lo entrega la secuencia (`#000123`, luego `A-000001`) | `scheduling:write` |
| `POST /api/v1/requests/:id/cancel` | Cancela una solicitud que aún espera | `scheduling:write` |
| `GET /api/v1/agenda/days/:date` | Jornada del día: cupo con su procedencia, franjas (con pausas), citas, cola y contadores | `scheduling:read` |
| `PUT /api/v1/agenda/capacity` | Cupo del día, editable a cualquier hora; **bajarlo por debajo de lo asignado avisa y no borra citas** | `scheduling:write` |
| `GET/POST/PATCH/DELETE /api/v1/agenda/templates` | Plantillas de franjas por día de la semana (jornada y pausas) | `scheduling:read` / `scheduling:write` |
| `POST /api/v1/agenda/notify/preview` | **Vista previa exacta** del lote: los mensajes que se enviarán y por qué no los demás | `scheduling:read` |
| `POST /api/v1/agenda/notify` | Notifica el lote: **asegura** el aviso (no repite el que ya salió y recupera el que quedó pendiente o fallido); con `force` reenvía también a los ya notificados | `scheduling:notify` |
| `POST /api/v1/appointments` | Asigna una solicitud a una franja (o cita directa con hora manual) | `scheduling:write` |
| `GET /api/v1/appointments[/:id[/history]]` | Citas por fecha, estado o paciente, y su historial de estados | `scheduling:read` |
| `POST /api/v1/appointments/:id/(check-in\|call\|start\|attend\|no-show\|cancel)` | Ciclo de vida según la máquina de estados; «atendido» pide motivo mientras no exista historia clínica | `scheduling:write` |
| `POST /api/v1/appointments/:id/reschedule` | Reprograma: la cita anterior queda trazada y la nueva se enlaza con ella | `scheduling:write` |
| `POST /internal/v1/requests` | Alta de solicitud desde el bot, con secreto interno | secreto interno |

- **El ticket es atómico**: lo entrega una secuencia de PostgreSQL, así que dos solicitudes
  simultáneas nunca reciben el mismo número.
- **Una sola silla**: un índice único parcial impide dos citas activas a la misma hora; repetir la
  franja responde **409** con la cita que la ocupa.
- **Sobrecupo**: solo con `scheduling:overbook` (admin) y un motivo, y queda en la auditoría.
- **Reprogramar no borra**: la cita original queda como `reprogramada`, la nueva apunta a ella y la
  secuencia `.ics` se incrementa para que los calendarios se actualicen.
- **Cancelar una cita devuelve el ticket a la cola** ([ADR 0028](docs/adr/0028-cancelar-devuelve-el-ticket.md)).

---

## API de la Fase 4.1 (avisos, canales y webhook)

El servicio de notificaciones ya no habla «Telegram»: habla **intenciones** y
**canales** ([ADR 0029](docs/adr/0029-nucleo-conversacional-y-adaptadores.md)). El asistente
de 7 pasos, la cola de envíos, las plantillas y el `.ics` son los mismos para todos.

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/notifications` | Bandeja de envíos con filtros (estado, canal, fecha, búsqueda) | `scheduling:read` |
| `GET /api/v1/notifications/status` | Estado de **cada canal** (identidad, capacidades) y de la cola, con las conversaciones en curso | `scheduling:read` |
| `POST /api/v1/notifications/:id/retry` | Reintento manual: vuelve a la cola ahora | `scheduling:notify` |
| `POST /api/v1/notifications/:id/contacted` | Deja constancia de un aviso hecho por teléfono | `scheduling:notify` |
| `GET/PATCH/POST /api/v1/notifications/templates[/:key[/reset]]` | Plantillas editables del asistente | `scheduling:read` / `scheduling:notify` |
| `GET /api/v1/notifications/channels` | Canales vinculados (canal + dirección enmascarada) | `scheduling:read` |
| `POST /api/v1/notifications/channels/link-code` | Enlace `t.me/...` + QR para vincular a un paciente | `scheduling:notify` |
| `DELETE /api/v1/notifications/channels/:patientId` | Desvincula al paciente | `scheduling:notify` |
| `GET /api/v1/notifications/ics/:appointmentId` | Descarga el `.ics` archivado | `scheduling:read` |
| `GET/POST /api/v1/notifications/webhook/:canal` | **Webhook público** de los canales que empujan (WhatsApp Cloud API) | **público** (lo valida la firma) |
| `POST /internal/v1/notifications/process` | Fuerza un ciclo de la cola (operación y pruebas) | secreto interno |

- **El núcleo habla de intenciones, no de comandos**: Telegram traduce `/nueva` y WhatsApp
  «cita» o «quiero una cita» a la misma intención; añadir un canal es escribir un adaptador.
- **Menú de comandos en Telegram**: al pulsar `/` (o el botón junto al campo de texto) el
  paciente ve la lista, sin tener que saberse nada: `/start`, `/nueva`, `/estado`, `/mi_ticket`,
  `/cancelar` y `/ayuda`. Se registra con `setMyCommands` **desde el catálogo del contrato** en
  cada arranque (no hay que tocar BotFather), y la respuesta de la ayuda termina con esa misma
  lista, así que también la ve quien use WhatsApp, que no tiene menú. Lo que hay registrado se
  comprueba con `npm run telegram:menu` (y `-- --set` lo vuelve a registrar).
- **Adaptación por capacidades**: donde no hay botones, las opciones van **numeradas** dentro del
  texto y se guardan en la conversación, así que responder «2» vale como pulsar el botón.
- **La identidad es `(canal, dirección)`**, no un `chat_id`: la misma persona puede hablar por
  Telegram y por WhatsApp sin pisarse las conversaciones.
- **Idempotencia por `eventoId`** (`update_id` de Telegram o `wamid` de WhatsApp) en
  `processed_updates`.
- **El webhook es público porque Meta no manda JWT**: la seguridad la da
  `x-hub-signature-256` (HMAC del cuerpo crudo con el `app_secret`), que el adaptador verifica
  **antes** de procesar nada. El gateway lo deja pasar sin token a propósito.
- **Kit de conformidad**: `services/notifications/src/canales/conformidad.test.ts` corre el mismo
  juego de pruebas contra Telegram, WhatsApp y el adaptador simulado; un canal que no lo pase no entra.

---

## API de la Fase 5 (secretaría y pantallas)

Las pantallas kiosko no usan la sesión del personal: se configuran **una vez** con el
token de su dispositivo ([ADR 0030](docs/adr/0030-pantallas-kiosko-y-sse.md)), que
canjean por un JWT de rol `pantalla`, y se actualizan por **SSE**.

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `POST /api/v1/auth/device` | Canjea el token de la pantalla por un JWT (15 min, rol `pantalla`) | **público** |
| `GET /api/v1/screens/devices` · `POST` · `PATCH /:id` · `DELETE /:id` | Registrar pantallas, ajustar su voz y volumen, desactivarlas y **reemitir su enlace** (el `PATCH` con `tokenId`) | `screens:manage` |
| `GET /api/v1/screens/conectadas` | Cuántas pantallas están conectadas en vivo | `screens:manage` |
| `GET /api/v1/screens/device` | Ficha de **esta** pantalla, con sus ajustes | `screens:display` |
| `GET /api/v1/screens/lobby` · `GET /api/v1/screens/consultorio` | Estado de la sala y del consultorio | `screens:display` |
| `GET /api/v1/screens/lobby/stream` · `GET /api/v1/screens/consultorio/stream` | Flujo **SSE** con el estado (trama completa por cambio + latido) | `screens:display` |
| `POST /internal/v1/screens/room/critical-flags` | Datos críticos del paciente en curso (los enviará la historia clínica) | secreto interno |

- **El llamado se empuja**: la secretaría llama por `/api/v1/appointments/:id/call` y el
  displaylobby lo recibe por SSE. Reparto medido del tiempo: **outbox 15-50 ms** (el cambio de
  estado adelanta la publicación), **cola 34-514 ms** (sondeo de `pg-boss`, que no admite menos
  de 500 ms), **proyección + trama 20-50 ms** y **proxy 1 ms**; en total **~300-450 ms típico**
  (~0,8 s peor caso), y **nada de eso crece con el volumen de datos** (todas las consultas del
  camino van por índice).
- **Una pantalla desactivada deja de ver la sala**, aunque su token siga vigente.
- **El enlace de una pantalla se puede reemitir** desde `/pantallas` (el botón del enlace, en la fila):
  del token de dispositivo el servidor guarda solo su hash, así que volver a mostrar el mismo es
  imposible —se emite uno nuevo, la pantalla pasa a reconocerlo y **el enlace anterior muere en el
  acto**—. Sirve para cuando se pierde el enlace o para configurar un segundo equipo. La sesión que ya
  estuviera abierta en el televisor caduca sola con su JWT de 15 minutos.
- La **secretaría** usa las rutas de agenda ya existentes (`check-in`, `call`, `start`,
  `attend`, `no-show`); la llamada fuera de orden registra llegada y llamado para que las
  dos transiciones queden en el historial y en la auditoría.
- `npm run smoke:screens` comprueba todo el camino contra el gateway real (26 comprobaciones).

---

## API de la Fase 6 (historia clínica)

La historia clínica sigue las 11 secciones de
[`docs/formato_historia.md`](docs/formato_historia.md). Se guarda **por secciones** (bloques
JSON validados), de modo que se llena como borrador y cada transición queda en la auditoría
por el outbox (forma genérica, `entityType: medical_record`). Los antecedentes se registran en
**catálogos tipificados con «otros» inputable**, que es lo que permite segmentar en los
reportes de la Fase 9.

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/clinical/patients/:patientId/record` | Historia del paciente o `exists: false` (primera visita) | `clinical:read` |
| `POST /api/v1/clinical/patients/:patientId/record` | Abre la historia (idempotente) | `clinical:write` |
| `GET /api/v1/clinical/records/:id` | Historia completa con secciones, adendas y consentimiento | `clinical:read` |
| `PUT /api/v1/clinical/records/:id/sections/:sectionKey` | Guarda una sección (solo en borrador) | `clinical:write` |
| `PUT /api/v1/clinical/records/:id/consent` | Registra la aceptación del consentimiento informado | `clinical:write` |
| `POST /api/v1/clinical/records/:id/sign` | Firma: bloquea la edición (exige secciones y consentimiento) | `clinical:write` |
| `POST /api/v1/clinical/records/:id/amendments` | Adenda con motivo sobre una historia firmada | `clinical:write` |
| `POST /api/v1/clinical/records/:id/printed` | Deja constancia de la impresión (también la secretaría) | `clinical:read` |
| `GET /internal/v1/clinical/patients/:patientId/alerts` | Alertas clínicas (alergias, crónicos) del paciente | secreto interno |

- **La secretaría imprime todo**: el rol `secretario` lleva `clinical:read` (y `odontogram:read`
  desde la sesión B), pero **no** `clinical:write` (decisión 23, 2026-10-04). Imprimir es leer,
  y cada impresión deja su actor en la auditoría.
- **No se firma sin datos**: el servidor bloquea la firma si faltan las secciones obligatorias
  (motivo de consulta, anamnesis, exámenes extraoral e intraoral, diagnóstico y plan) o si no
  hay consentimiento aceptado, y lo explica con la lista de lo que falta.
- **La historia firmada es inmutable**: cualquier corrección pasa por una adenda con motivo,
  fechada y firmada por su autor.
- La interfaz vive en `/consultorio` (aviso obligatorio de **primera visita**, formulario por
  pasos con autoguardado, alertas clínicas resaltadas y vista de impresión A4 en
  `/consultorio/:id/imprimir`).
- **Pendiente de la sesión B**: la pantalla del consultorio ya recibe datos críticos por
  `POST /internal/v1/screens/room/critical-flags`, pero todavía **nadie los envía**; el servicio
  clínico ya expone las alertas calculadas en su ruta interna y el envío se conecta al abrir la
  sesión clínica (Fase 7), que es cuando la cita está en la sala.

---

## API de la Fase 6B (odontograma)

El odontograma implementa
[`docs/implementation_plan_odontogram_microservice.md`](docs/implementation_plan_odontogram_microservice.md):
nomenclatura **FDI** de dos dígitos, **captura por excepción** —la pieza sana es la **ausencia de
fila**— y motor geométrico SVG sin dependencias. La dentición (permanente 11–48 o temporal 51–85)
**se deduce del propio número**: el cliente no puede contradecirla.

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/odontogram/patients/:patientId` | Odontograma del paciente o `exists: false` (boca sana, sin filas) | `odontogram:read` |
| `PUT /api/v1/odontogram/patients/:patientId/findings` | Registra o actualiza un hallazgo (crea el odontograma si es el primero) | `odontogram:write` |
| `POST /api/v1/odontogram/patients/:patientId/findings/batch` | Varios hallazgos en **una** transacción (carga rápida) | `odontogram:write` |
| `DELETE /api/v1/odontogram/patients/:patientId/findings` | Borra una clave natural `(pieza, cara, condición)`: la pieza vuelve a estar sana | `odontogram:write` |
| `DELETE /api/v1/odontogram/patients/:patientId/surfaces/:toothNumber/:surface` | Deja la cara sana limpiando todas sus condiciones | `odontogram:write` |
| `GET /api/v1/odontogram/patients/:patientId/history` | Histórico append-only de cambios (vista de evolución) | `odontogram:read` |
| `POST /api/v1/odontogram/patients/:patientId/printed` | Deja constancia de la impresión (también la secretaría) | `odontogram:read` |
| `GET /internal/v1/odontogram/patients/:patientId/summary` | Resumen (piezas afectadas, pendientes/completadas) para los reportes | secreto interno |

- **Una cara admite caries u obturación por estado**: `pendiente` se pinta en rojo y `completado`
  en azul (doc §7.2). **Solo `ausente` manda sobre las caras**: al registrarlo, las caras de esa
  pieza quedan *superadas* (`resolved_at`) en la misma transacción y dejan de leerse, pero **no se
  borran** —el histórico las conserva—. Los **tratamientos** (`corona`, `endodoncia`, `implante`) y
  la `extraccion_indicada` **conviven** con ellas, que es la boca normal: una corona sobre un diente
  obturado o un conducto con su restauración. Se bloquean solo las parejas imposibles (`ausente` con
  cualquier otra cosa, `implante` con `endodoncia`) y el servidor responde `409` explicando cuál
  sobra ([ADR 0032](docs/adr/0032-convivencia-de-tratamientos-con-las-caras.md), que corrige el
  [ADR 0031](docs/adr/0031-odontograma-pieza-completa-sobre-caras.md)). La regla es declarativa
  (`WHOLE_TOOTH_RULES`) y la comparten la interfaz —que desactiva el botón y dice por qué— y el
  servidor.
- **Cada cambio deja rastro por partida doble**: la fila del histórico (`tooth_finding_history`) y
  el outbox → auditoría de identity (`entityType: odontogram`), con `before`/`after`, autor y
  motivo. Los temas `odontogram.finding.recorded/removed` llevan el payload que alimentará
  `fact_clinical_event` y `mv_oral_health` en la Fase 9.
- **La interfaz** vive en `/consultorio` (pestañas **Historia clínica / Odontograma**): gráfico
  interactivo (se pulsa la cara, no un botón), **carga rápida por teclado** —«16» + `c` marca
  caries oclusal pendiente, `C` la marca completada; `a` ausente, `x` extracción indicada, `r`
  corona, `i` implante, `e` endodoncia; `v l n s d` eligen cara y `Supr` deja la cara sana—,
  deshacer, **evolución** en `/consultorio/:patientId/odontograma/historial` e **impresión A4** en
  `/consultorio/:patientId/odontograma/imprimir` (que la secretaría comparte en solo lectura); el
  informe puede incluir, con una casilla, el **historial de cambios con fechas**.
- **Se dibuja en posición anatómica** ([ADR 0033](docs/adr/0033-odontograma-en-posicion-anatomica.md)): dos filas con la **línea media** en el centro, la cara vestibular arriba en el maxilar y abajo en la mandíbula, y las piezas de la **derecha del paciente** (cuadrantes 1 y 4, y 5 y 8 temporales) **espejadas**, para que la cara mesial mire siempre a la línea media —es decir, al vecino que de verdad toca—. El número de pieza se lee siempre derecho y cada arcada lleva su nota de orientación. En incisivos y caninos (posiciones 1–3) la cara de masticación se llama **borde incisal** en toda la interfaz, aunque se guarde como `occlusal` (mismo polígono, sin migración).
- **Se maneja con el dedo**: en una tableta (`pointer: coarse`) el toque sobre una pieza abre la
  **hoja de la pieza** con caras, condición, estado y borrado en botones de ≥44 px, y el gráfico
  crece hasta que cada pieza pasa de 44 px (con desplazamiento horizontal si no cabe). La hoja usa
  el mismo modelo de selección que el teclado: marcar tres caras deja tres hallazgos en una sola
  transacción. Con ratón se sigue pulsando la cara exacta.

---

## API de la Fase 7A (sesión clínica)

La sesión es la **evolución** del paciente (§11 de
[`docs/formato_historia.md`](docs/formato_historia.md)): la historia se firma una vez, y cada visita
se documenta con una sesión que nace en `borrador`, se **autoguarda** mientras el doctor escribe y
pasa a `cerrada`, que es inmutable ([ADR 0034](docs/adr/0034-sesion-clinica-evolucion.md)).

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/clinical/patients/:patientId/sessions` | Evolución del paciente, de la última visita a la primera | `clinical:read` |
| `POST /api/v1/clinical/patients/:patientId/sessions` | Abre la sesión del día (idempotente; abre la historia si no existía) | `clinical:write` |
| `GET /api/v1/clinical/sessions/:id` | Sesión completa con su documento | `clinical:read` |
| `PUT /api/v1/clinical/sessions/:id` | **Autoguardado**: el documento completo de la sesión | `clinical:write` |
| `POST /api/v1/clinical/sessions/:id/close` | Cierra la sesión (exige contenido mínimo) y la deja inmutable | `clinical:write` |
| `POST /api/v1/clinical/sessions/:id/amend` | Corrige una sesión cerrada **abriendo otra** en borrador, con motivo | `clinical:write` |
| `GET /api/v1/clinical/appointments/:appointmentId/sessions` | Sesiones de una cita: la secretaría sabe si el doctor ya cerró | `clinical:read` |
| `GET /internal/v1/clinical/sessions/:id/status` | Estado de la sesión, para que la **agenda** verifique el «atendido» | secreto interno |

- **El borrador se autoguarda sin ruido**: no publica evento ni auditoría (el catálogo solo tiene
  `clinical.session.created/closed/amended`) y, si el documento no cambió, no escribe nada. El acto
  clínico nace **al cerrar**, y ahí sí queda en la auditoría con su resumen, sus procedimientos y su
  actor.
- **Una sesión vacía no se cierra**: hace falta motivo, un procedimiento o un diagnóstico. Una sesión
  cerrada no se edita (`409`); la corrección abre una sesión **enmendada** con el contenido copiado
  y el motivo, y la original se conserva.
- **El autoguardado exige el documento completo** (`400` si falta algo): con los valores por defecto
  del contrato, un cliente que mandara solo el campo que tocó borraría en silencio los
  procedimientos que ya estaban.
- **Firmar la historia no cierra la evolución**: se puede abrir una sesión con la historia firmada.
- **Marcar «atendido» sin motivo ya es real**: la sesión cerrada respalda la cita
  (`appointments.clinical_session_id`). La agenda **verifica** la sesión contra el servicio clínico
  —existe, es del mismo paciente y está cerrada—, así que un identificador inventado responde `409`;
  sin sesión, el «atendido» sigue pidiendo motivo auditado (y la secretaría ve en su diálogo que la
  sesión ya está cerrada).
- **El odontograma se marca dentro de la sesión**: los hallazgos registrados con la sesión abierta
  guardan su `sessionId`, que es lo que agrupa la evolución por visita.
- **La pantalla del consultorio ya muestra los datos críticos** (alergias, crónicos,
  anticoagulantes) con semáforo de riesgo: se leen de la historia clínica en el momento de pintarlos
  ([ADR 0035](docs/adr/0035-datos-criticos-leidos-no-empujados.md)).
- La interfaz vive en `/consultorio` (pestaña **Sesión clínica**): signos vitales con sus rangos,
  examen del día, procedimientos **del catálogo** con pieza y caras, materiales, diagnóstico,
  indicaciones, próxima cita y notas internas; indicador de guardado, cierre con nota y la evolución
  anterior a la vista.
- `npm run smoke:clinical` recorre todo el camino contra el gateway real (30 comprobaciones).

---

## API de la Fase 7B (adjuntos, récipes A5 y verificación)

Los **adjuntos** son radiografías, fotos clínicas y documentos de la sesión (con pie). El **récipe**
es un documento A5 con membrete, numerado `RX-000001` y verificable por QR
([ADR 0015](docs/adr/0015-recipe-a5-en-pdf.md), [ADR 0036](docs/adr/0036-recipe-emitido-documento-archivado.md)).

| Método y ruta | Qué hace | Permiso |
| :--- | :--- | :--- |
| `GET /api/v1/clinical/sessions/:id/attachments` | Adjuntos de la sesión | `clinical:read` |
| `POST /api/v1/clinical/sessions/:id/attachments` | Sube un archivo (`multipart`: `file`, `kind`, `caption`, `toothNumber`) | `clinical:write` |
| `GET /api/v1/clinical/sessions/:id/attachments/:attachmentId` | Descarga autorizada del adjunto | `clinical:read` |
| `DELETE /api/v1/clinical/sessions/:id/attachments/:attachmentId` | Quita un adjunto (solo en sesión **borrador**) | `clinical:write` |
| `GET /api/v1/clinical/patients/:patientId/attachments` | Todos los adjuntos del paciente (ficha) | `clinical:read` |
| `GET /api/v1/clinical/medications?search=` | Catálogo de medicamentos para el autocompletado | `clinical:read` |
| `PUT /api/v1/clinical/sessions/:id/prescription` | Guarda el **borrador** del récipe de la sesión | `clinical:write` |
| `POST /api/v1/clinical/prescriptions/:id/issue` | **Emite**: número, PDF A5 archivado y código de verificación | `clinical:write` |
| `GET /api/v1/clinical/prescriptions/:id/pdf` | Descarga el PDF archivado (imprimir es leer) | `clinical:read` |
| `POST /api/v1/clinical/prescriptions/:id/printed` | Deja constancia de la impresión o descarga | `clinical:read` |
| `POST /api/v1/clinical/prescriptions/:id/annul` | Anula con motivo (nunca se borra) | `clinical:write` |
| `GET /api/v1/clinical/patients/:patientId/prescriptions` | Historial de récipes del paciente | `clinical:read` |
| `GET /api/v1/clinical/verify/:code` | **Público**: confirma que el récipe es auténtico, sin datos clínicos | — |

- **El PDF A5 lo compone Chromium** (Playwright) desde la plantilla del membrete, que sale de la
  [sección editable del consultorio](packages/contracts/src/clinic.ts); si falta un dato (RIF,
  teléfono, MPPS, especialidad) el editor **avisa antes de emitir** y el récipe sale sin él.
  Se instala una vez: `npx playwright install chromium`.
- **El récipe emitido es un documento cerrado**: guarda una copia de los datos del paciente y de
  cada medicamento, y el PDF se archiva con su `sha256`. Lo que se descarga después es ese mismo
  archivo; editar el catálogo o la ficha del paciente **no** reescribe lo entregado.
- **Verificación pública sin sesión**: el QR apunta a `<PUBLIC_APP_URL>/verificar/<código>`, que
  responde con el nombre del consultorio, la fecha, quién lo firmó, el nombre **abreviado** del
  paciente y si está vigente o anulado. Ni diagnóstico, ni medicamentos, ni cédula.
- **La miniatura y el visor los hace el navegador**: el archivo se pide por el endpoint autorizado
  (nunca por una URL pública) y el visor tiene zoom con botones, rueda y teclado. No hay generación
  de miniaturas en el servidor a propósito: sería una librería de imágenes para algo que el
  navegador ya sabe hacer.
- `npm run smoke:prescription` recorre todo el camino (32 comprobaciones), incluida la verificación
  pública **sin token**.

---

## Interfaz de la Fase 8 (`/flujo`)

**El día completo en una sola pantalla**, para la odontóloga que trabaja sin asistente: la cola del día
a la izquierda (con selector de fecha, buscador y contadores), el **paciente en curso** en el centro con
su expediente —historia, sesión con adjuntos y récipe, y odontograma— y las **acciones de secretaría**
en la barra superior ([ADR 0038](docs/adr/0038-permisos-del-odontologo-en-el-flujo.md)).

| Acción de la barra | Qué hace |
| :--- | :--- |
| **Registrar llegada** | Pasa la cita a «en sala de espera» |
| **Llamar** | Publica el llamado que sale en la pantalla de la sala (el 2.º llamado repite) |
| **Pasar a consulta** | Pasa la cita a «en consulta» |
| **Marcar atendido** | Cierra la visita; con la sesión clínica cerrada no pide motivo |
| **No asistió** | Inasistencia (solo después de la tolerancia de 15 min) |
| **Llamar fuera de orden** | Encadena llegada y llamado para quien no le tocaba por hora |
| **Ver historial** | Las transiciones de la cita con su actor, motivo y hora |

- **Atajos**: `F2` buscar paciente, `F4` llamar al paciente en curso y `F8` **cerrar la sesión clínica**
  de la visita (con la pregunta del récipe). No disparan con un diálogo abierto ni con
  `Ctrl`/`Alt`/`Meta`, y cada uno tiene su botón porque en la tableta no hay teclado.
- **El expediente es el mismo de `/consultorio`** (`PatientWorkspace`), así que `/flujo` no puede
  quedarse corta respecto a las rutas individuales; `/secretaria` y `/consultorio` siguen ahí y sin
  cambios.
- **Modo tableta**: una sola columna (cola arriba, expediente debajo) y botones grandes; comprobado a
  820 px.
- **Permisos**: se entra con `clinical:read`; las acciones de escritura se comprueban dentro y siguen
  las del servidor (máquina de estados + permisos).
- `npm run e2e:flujo` hace el día completo en Chromium (27 comprobaciones), **sin salir de `/flujo`**.

---

## Reportes y auditoría (Fase 9)

**`/reportes`** decide con datos: el **tablero del día** (citas, atendidas, inasistencias, pendientes,
cupo, pacientes y avisos) y **seis reportes** con los mismos filtros —fecha, rango de edad, sexo y
estado del paciente— y la misma forma: cifras, gráficas y tabla.

| Reporte | Qué muestra | Permiso |
| :--- | :--- | :--- |
| **Embudo y tasa de inasistencia** | Solicitudes → programadas → avisadas → atendidas, por día, semana o mes | `reports:read` |
| **Ocupación de la agenda** | Cupo usado por día, días completos, día de mayor demanda y **hora pico** | `reports:read` |
| **Demografía** | Pirámide por tramos de edad y sexo, con el rango editable | `reports:read` |
| **Perfil clínico** | Diabéticos, hipertensos, cardiópatas, alérgicos, anticoagulados y bifosfonatos | `reports:clinical` |
| **Salud bucal** | Caries, obturaciones y piezas ausentes por pieza y por paciente | `reports:clinical` |
| **Recetas por medicamento** | Lo más recetado en el período, con renglones y porcentaje | `reports:clinical` |

- **Exportación**: `Descargar CSV` (abre en Excel: BOM, `;` y coma decimal), `Descargar PDF`
  (A4 con el membrete, compuesto en el servidor con Chromium) e `Imprimir`.
- **Los reportes clínicos exigen `reports:clinical`** ([ADR 0039](docs/adr/0039-reportes-clinicos-con-permiso-propio.md)):
  los ve el odontólogo y el administrador; la secretaría ve los operativos, y la pantalla le explica
  por qué no ve el resto en vez de ofrecerle un botón que devuelve 403.
- **De dónde salen los datos**: de `services/reporting` (puerto 4008), un **read model propio**
  alimentado por los eventos de dominio y servido desde **vistas materializadas** que se refrescan al
  cerrar cada lote y de noche ([ADR 0040](docs/adr/0040-refresco-del-read-model-de-reportes.md));
  ningún reporte consulta las bases de los demás servicios.

**`/auditoria`** responde «quién cambió qué y cuándo»: búsqueda por rango de fechas —el día completo
en hora de Venezuela—, usuario, acción, tipo e identificador de entidad y **campo** cambiado; la lista
lleva el resumen y el motivo, y el detalle muestra el **diff antes/después** (valor anterior tachado,
nuevo en negrita), el autor, la IP y la petición. `Descargar CSV` baja exactamente el listado filtrado
(tope de 5.000 eventos, avisado en la última fila).

- `npm run smoke:reporting` provoca el recorrido completo y comprueba las cifras (81 comprobaciones).
- `npm run e2e:reportes` recorre las dos pantallas en Chromium (37 comprobaciones) y deja una captura.
- `npm run reports:latencia` mide los seis reportes con 10.000 citas (**3–8 ms** en la última medición).

---

## Cómo se trabaja este repositorio

1. **Una fase = una sesión agéntica.** Al cerrar: `npm run verify` verde, commits atómicos
   (Conventional Commits), merge a `main` y tag `fase-N`.
2. **Los contratos viven en `packages/contracts`** (una sola fuente de verdad para la API,
   la base de datos y la interfaz).
3. **Cada servicio es dueño exclusivo de su base de datos.** Nada de leer tablas ajenas:
   REST interno o eventos (outbox + pg-boss).
4. **Nunca SQL construido con texto.** Consultas parametrizadas o Drizzle; el linter lo
   verifica además de la revisión.
5. **Nada de secretos versionados.** `.env` está ignorado y `tools/check-secrets.mjs` corre
   en cada `verify`.

## Documentación

- [Plan maestro por fases](docs/PLAN_MAESTRO_FASES.md)
- [Política de secretos y tokens](docs/SEGURIDAD_SECRETOS.md)
- [Formato de historia clínica odontológica](docs/formato_historia.md)
- [Plan del servicio de odontograma](docs/implementation_plan_odontogram_microservice.md)
- [Decisiones de arquitectura (ADR)](docs/adr/README.md)
- [Instalación en Windows](infra/windows/install.md) · [Producción en Fedora](infra/fedora/INSTALL.md)
