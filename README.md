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

| Comando | Qué hace |
| :--- | :--- |
| `npm run dev` | Compila en modo vigilancia y arranca gateway + identity + patients + interfaz |
| `npm run build` | Compila todo el monorepo (`tsc -b` + `vite build`) |
| `npm run typecheck` | Igual que `build`: el proyecto se valida compilando |
| `npm test` | Pruebas unitarias y de contrato (Vitest) |
| `npm run test:watch` | Pruebas en modo vigilancia |
| `npm run test:integration` | Suite completa contra PostgreSQL real (outbox, cola compartida, autenticación, pacientes y rendimiento); requiere `db:bootstrap`, `db:migrate` y `build` |
| `npm run lint` | ESLint (incluye las reglas anti SQL-injection) |
| `npm run format` / `format:check` | Prettier |
| `npm run check-secrets` | Busca secretos antes de commitear (`-- --all` audita todo) |
| `npm run db:bootstrap` | Crea bases, roles y credenciales (`-- --rotate`, `-- --only identity`) |
| `npm run db:migrate` | Aplica las migraciones de todos los servicios |
| `npm run db:verify-migrations` | Comprueba que las migraciones se aplican **desde cero** en una base limpia (crea y borra una base temporal) |
| `npm run db:generate:identity` | Genera la migración de identity desde su esquema (desde la raíz) |
| `npm run keys:generate` | Genera el par de claves EdDSA del JWT (no sobrescribe; `-- --force` regenera e invalida sesiones) |
| `npm run seed:users` | Crea `admin`, `recepcion` y `egomez` con contraseña temporal (`-- --reset` las regenera) |
| `npm run seed:demo` | Pacientes ficticios deterministas (`-- --count 5000`, `-- --reset` borra solo lo ficticio) |
| `npm run db:generate:patients` | Genera la migración del servicio de pacientes desde su esquema |
| **`npm run verify`** | **Puerta de calidad: secretos + lint + formato + compilación + pruebas** |

Antes de cerrar cualquier fase, `npm run verify` debe pasar en verde.

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
| scheduling | 4003 | Fase 3 |
| notifications | 4004 | Fase 4 |
| clinical | 4005 | Fase 6 |
| odontogram | 4006 | Fase 6 |
| screens | 4007 | Fase 5 |
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
