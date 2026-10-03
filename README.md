# OdontoCRM

CRM para un consultorio odontológico: gestión de citas, secretaría, historia clínica,
odontograma, récipes, reportes y auditoría — construido como **microservicios Node.js +
TypeScript** sobre **PostgreSQL**, pensado para correr en la red local de la clínica y,
más adelante, fuera de ella por VPN.

> **Estado: Fase 0 completada** (fundación del repositorio e infraestructura local).
> El plan completo, con las 11 fases y sus criterios de aceptación, está en
> [`docs/PLAN_MAESTRO_FASES.md`](docs/PLAN_MAESTRO_FASES.md).

---

## Requisitos

| Componente | Versión usada | Nota |
| :--- | :--- | :--- |
| Node.js | 26.7 (mínimo 22.9) | `--env-file-if-exists` y `--watch` nativos |
| npm | 11 (workspaces) | no se usa pnpm ni Docker |
| PostgreSQL | 18 | una base de datos por servicio |
| PM2 | global | mantiene los servicios vivos (producción) |
| Git | 2.55 | |

---

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

# 5. Arranca (compilación en modo vigilancia + gateway + identidad + interfaz)
npm run dev
```

La primera vez que entres, el sistema te pedirá cambiar la contraseña temporal: hasta que lo
hagas, ningún módulo queda habilitado (es una regla del servidor, no solo de la interfaz).

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
está en **[`docs/COMANDOS.md`](docs/COMANDOS.md)**. Estos son los del día a día:

| Comando | Qué hace |
| :--- | :--- |
| `npm run dev` | Compila en modo vigilancia y arranca gateway + servicios + interfaz (5173) |
| `npm test` | Pruebas unitarias y de contrato (Vitest) |
| `npm run test:integration` | Suites contra PostgreSQL real (outbox, colas, sesión, pacientes, agenda, pantallas) |
| `npm run smoke:<módulo>` | Recorrido de punta a punta por el gateway: `auth`, `patients`, `agenda`, `notifications`, `screens` |
| **`npm run verify`** | **Puerta de calidad: secretos + lint + formato + compilación + pruebas unitarias** |

Antes de cerrar cualquier fase, `npm run verify` debe pasar en verde, además de
`npm run db:verify-migrations` y el humo del módulo tocado.

---

## Estructura

```
apps/gateway          API Gateway: proxy por recurso, CORS, límite de peticiones
apps/web              SPA de React (Fase 1)
packages/contracts    Enums, estados, DTOs, utilidades puras (ticket, máquina de estados)
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

### Puertos (todos en `127.0.0.1`; la red local entra solo por el gateway)

| Servicio | Puerto | Estado |
| :--- | :-: | :--- |
| gateway | 8090 | ✅ Fase 0 |
| identity | 4001 | ✅ Fase 0 (salud) · Fase 1 (usuarios y auth) |
| patients | 4002 | ✅ Fase 2 |
| scheduling | 4003 | ✅ Fase 3 |
| notifications | 4004 | ✅ Fase 4 (Telegram) · Fase 4.1 (multicanal + webhook) |
| clinical | 4005 | Fase 6 |
| odontogram | 4006 | Fase 6 |
| screens | 4007 | ✅ Fase 5 (secretaría y pantallas con SSE) |
| reporting | 4008 | Fase 9 |

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
| `POST /api/v1/agenda/notify` | Marca el lote como notificado y publica el evento que enviará la Fase 4 | `scheduling:notify` |
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
| `GET /api/v1/screens/devices` · `POST` · `PATCH /:id` · `DELETE /:id` | Registrar pantallas, ajustar su voz y volumen, y desactivarlas | `screens:manage` |
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
- La **secretaría** usa las rutas de agenda ya existentes (`check-in`, `call`, `start`,
  `attend`, `no-show`); la llamada fuera de orden registra llegada y llamado para que las
  dos transiciones queden en el historial y en la auditoría.
- `npm run smoke:screens` comprueba todo el camino contra el gateway real (26 comprobaciones).

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
