# Comandos de OdontoCRM

> Guía única de comandos: qué hace cada uno, cuándo se usa y qué necesita para
> funcionar. Todo se ejecuta **desde la raíz del repositorio** salvo donde se diga
> lo contrario. Los identificadores (nombres de scripts, servicios y variables) van
> en inglés o tal cual; las explicaciones, en español.
>
> Referencias: [`README.md`](../README.md) · [`PLAN_MAESTRO_FASES.md`](PLAN_MAESTRO_FASES.md) ·
> [`SEGURIDAD_SECRETOS.md`](SEGURIDAD_SECRETOS.md) · [ADRs](adr/README.md)

## Índice

1. [Los cinco comandos del día a día](#1-los-cinco-comandos-del-día-a-día)
2. [Puesta en marcha desde cero](#2-puesta-en-marcha-desde-cero)
3. [Calidad y pruebas](#3-calidad-y-pruebas)
4. [Base de datos y migraciones](#4-base-de-datos-y-migraciones)
5. [Datos de prueba (seeds)](#5-datos-de-prueba-seeds)
6. [Arrancar y parar servicios](#6-arrancar-y-parar-servicios)
7. [Pruebas de humo](#7-pruebas-de-humo)
8. [Operación en Windows (PM2) y Fedora](#8-operación-en-windows-pm2-y-fedora)
9. [Comandos por paquete o servicio](#9-comandos-por-paquete-o-servicio)
10. [«Quiero hacer X» → comando](#10-quiero-hacer-x--comando)
11. [Qué `.env` necesita cada cosa](#11-qué-env-necesita-cada-cosa)
12. [Problemas típicos](#12-problemas-típicos)

---

## 1. Los cinco comandos del día a día

| Comando | Qué hace | Cuándo |
| :--- | :--- | :--- |
| `npm run verify` | **Puerta de calidad**: secretos → lint → formato → compilación → pruebas unitarias | Antes de cada commit importante y **siempre** antes de cerrar una fase |
| `npm run dev` | Compila en vigilancia y arranca gateway + servicios + interfaz (Vite) | Para trabajar con la aplicación abierta |
| `npm test` | Pruebas unitarias y de contrato (Vitest, sin base de datos) | Mientras se programa: `npm run test:watch` |
| `npm run test:integration` | Las mismas suites **contra PostgreSQL real** (outbox, colas, sesiones, agenda, pantallas) | Antes de dar algo por terminado |
| `npm run smoke:<módulo>` | Recorrido de punta a punta **contra los servicios arrancados** por el gateway | Cuando algo «funciona en las pruebas pero no en la app» |

> `npm run verify` **no** ejecuta las pruebas de integración ni las de humo: no toca
> la base de datos ni arranca servicios. Para el DoD de una fase hay que correr
> también `db:verify-migrations` y el humo del módulo que se haya tocado.

---

## 2. Puesta en marcha desde cero

Requisitos: **Node.js 26**, **PostgreSQL 18** en `127.0.0.1:5432`, `npm` y (opcional,
para tener los servicios siempre vivos) `pm2`. Ver [`infra/windows/install.md`](../infra/windows/install.md).

```powershell
# 1. Dependencias
npm install

# 2. Configuración: copia la plantilla y pon la contraseña del superusuario
Copy-Item .env.example .env      # y edita PG_ADMIN_URL

# 3. Bases, roles y credenciales de cada servicio (idempotente)
npm run db:bootstrap

# 4. Claves EdDSA del JWT (una sola vez por instalación)
npm run keys:generate

# 5. Compilar (los servicios se ejecutan desde dist/) y migrar
npm run build
npm run db:migrate

# 6. Datos mínimos para poder entrar
npm run seed:users            # admin, recepcion, egomez (contraseña temporal)
npm run seed:demo -- --count 500
npm run seed:agenda

# 7. Trabajar
npm run dev                   # http://127.0.0.1:5173
```

En Windows hay un atajo que hace 3, 5 y 6 y arranca todo con PM2:

```powershell
powershell -ExecutionPolicy Bypass -File infra/windows/start-services.ps1
```

**Contraseñas sembradas** (temporales, el sistema obliga a cambiarlas al entrar):
`admin` → `admin-odontocrm-2026` · `recepcion` → `recepcion-odontocrm-2026` ·
`egomez` → `consultorio-odontocrm-2026`.

---

## 3. Calidad y pruebas

| Comando | Qué hace | Notas |
| :--- | :--- | :--- |
| `npm run verify` | Encadena `check-secrets`, `lint`, `format:check`, `build` y `test` | El estándar de cierre de fase |
| `npm run check-secrets` | Busca secretos en lo que está en *staging* | `-- --all` audita todo el repo |
| `npm run lint` | ESLint 9 (incluye las reglas anti SQL-injection) | `npx eslint <ruta>` para un archivo |
| `npm run format` / `format:check` | Prettier: escribe / comprueba | `npx prettier --write <ruta>` para un archivo |
| `npm run typecheck` | `tsc -b` (proyectos Node) + `tsc --noEmit` (web) | Igual que `build` en la parte Node |
| `npm run build` | Todo el monorepo: `tsc -b` + `vite build` | Deja los artefactos en `dist/` |
| `npm run build:node` | Solo los servicios y paquetes (`tsc -b`), sin la web | Es lo que hay que correr antes de `start:*` |
| `npm test` | Vitest: unitarias y de contrato | Sin base de datos; las de integración se **omiten** |
| `npm run test:watch` | Vitest en vigilancia | Mientras se programa |
| `npx vitest run <ruta>` | Una sola suite unitaria | Ej.: `npx vitest run packages/contracts/src/domain/screens.test.ts` |
| `npm run test:integration` | Suites contra PostgreSQL real | `-- <ruta>` para una sola; requiere `db:bootstrap`, `db:migrate` y `build` |
| `npm run db:verify-migrations` | Aplica las migraciones de **cada servicio** desde cero en bases limpias | `-- --only screens`; necesita `build` y `PG_ADMIN_URL` |

---

## 4. Base de datos y migraciones

| Comando | Qué hace | Flags |
| :--- | :--- | :--- |
| `npm run db:bootstrap` | Crea las 8 bases, un rol por servicio con privilegios solo sobre la suya, las extensiones (`pgcrypto`, `pg_trgm`), la cola compartida `odonto_events` y escribe las credenciales en cada `services/<svc>/.env` | `-- --rotate` (contraseñas nuevas), `-- --only <servicio>` |
| `npm run db:migrate` | Aplica las migraciones de todos los servicios implementados | `-- --only <servicio>` |
| `npm run db:verify-migrations` | Desde cero: crea una base temporal por servicio, migra con el migrador real, comprueba tablas/índices y la borra | `-- --only <servicio>` |
| `npm run db:generate:<servicio>` | Genera una migración a partir del esquema Drizzle del servicio | `identity`, `patients`, `scheduling`, `notifications`, `screens` |
| `npm run keys:generate` | Par de claves EdDSA del JWT en `services/identity/.keys/` (ignorado por Git) | `-- --force` regenera (invalida todas las sesiones) |

Los generadores de migración se ejecutan **desde la raíz** (drizzle-kit resuelve las
rutas contra el directorio de trabajo) y suelen necesitar nombre y revisión a mano:

```powershell
npx drizzle-kit generate --config services/screens/drizzle.config.ts --name mi_cambio
```

> `db:bootstrap` es **idempotente**: no toca lo que ya existe salvo con `--rotate`.
> Si un `.env` de servicio se borra, `db:bootstrap --only <servicio>` lo regenera.

---

## 5. Datos de prueba (seeds)

| Comando | Qué crea | Flags |
| :--- | :--- | :--- |
| `npm run seed:users` | `admin`, `recepcion` y `egomez` con contraseña temporal | `-- --reset` regenera las contraseñas |
| `npm run seed:demo` | Pacientes ficticios deterministas (cédulas 90.000.000+, `is_fictitious`) | `-- --count 5000`, `-- --reset` (borra **solo** lo ficticio) |
| `npm run seed:agenda` | Solicitudes y citas de ejemplo en el próximo día de consulta | `-- --reset` (las borra) |

Detalles que conviene saber:

- `seed:demo` **avisa** en vez de chocar si ya hay datos: la segunda ejecución sin
  `--reset` explica cómo regenerarlos.
- `seed:agenda` necesita pacientes ficticios: si no hay, lo dice y no hace nada.
- Las pruebas de humo cambian la contraseña del administrador. Después:
  `npm run seed:users -- --reset`.

---

## 6. Arrancar y parar servicios

### Desarrollo (procesos sueltos, con recarga)

| Comando | Arranca |
| :--- | :--- |
| `npm run dev` | Todo: `tsc -b --watch` + gateway + identity + patients + scheduling + notifications + screens + web |
| `npm run dev:web` | **Solo la interfaz** (Vite en `http://127.0.0.1:5173`): es lo que se usa cuando los servicios están en PM2 |
| `npm run dev:<servicio>` | Un solo servicio en vigilancia: `identity`, `patients`, `scheduling`, `notifications`, `screens`, `gateway`, `web`, `build` |
| `npm run dev:check` | Comprueba que los puertos del desarrollo estén libres y dice quién los ocupa (se ejecuta **solo** antes de `npm run dev`) |
| `npm run dev:stop` | Para lo que dejó vivo un `npm run dev` anterior (los procesos de PM2 no se tocan: los para `pm2 stop all`) |
| `npm run check:web` | Abre la interfaz con un navegador sin interfaz y verifica que **monta** y que la consola está limpia |

`npm run dev` requiere haber migrado y sembrado antes; los servicios leen
`.env` (raíz) + `services/<svc>/.env`.

> **PM2 y `npm run dev` no conviven**: los dos quieren los mismos puertos. Si tienes
> los servicios en PM2, trabaja con `npm run dev:web` (solo la web, el `/api` va por
> el proxy de Vite al gateway del 8090) o para PM2 con `pm2 stop all` y arranca todo
> con `npm run dev`. El preflight `dev:check` lo detecta y te lo dice antes de que
> nada falle a medias.

### Sin vigilancia (lo que corre PM2)

| Comando | Arranca |
| :--- | :--- |
| `npm run start:<servicio>` | Un servicio desde `dist/` (`identity`, `patients`, `scheduling`, `notifications`, `screens`, `gateway`) |
| `npm run build:node` | **Hay que compilar antes**: `start:*` ejecuta `dist/`, no el código fuente |
| `npm run preview -w @odontocrm/web` | Interfaz compilada en `http://127.0.0.1:4173` |

### Puertos

| Servicio | Puerto | | Interfaz | Puerto |
| :--- | :-: | :-: | :--- | :-: |
| gateway (única puerta) | 8090 | | web en desarrollo | 5173 |
| identity | 4001 | | web compilada (`preview`) | 4173 |
| patients | 4002 | | PostgreSQL | 5432 |
| scheduling | 4003 | | | |
| notifications | 4004 | | | |
| screens | 4007 | | | |

Todos los servicios escuchan en `127.0.0.1`: se entra **solo** por el gateway.

---

## 7. Pruebas de humo

Recorren el camino completo por el **gateway real** (sesión, permisos, proxy, eventos,
base de datos). Necesitan los servicios arrancados y datos sembrados.

| Comando | Qué recorre | Comprobaciones |
| :--- | :--- | :--- |
| `npm run smoke:auth` | Ciclo de sesión: login, refresco, permisos, cierre | 17 |
| `npm run smoke:patients` | Registro, duplicado, edición con motivo, borrado y auditoría | 26 |
| `npm run smoke:agenda` | Ticket, cupo, franja, sobrecupo, reprogramación y aviso en lote | 41 |
| `npm run smoke:notifications` | Estado de canales, plantillas, vinculación con QR y aviso de cita con `.ics` | 24 |
| `npm run smoke:screens` | Pantalla kiosko, llamado en el lobby por SSE (mide la latencia), consultorio y baja de la pantalla | 26 |

Variables opcionales (mismas en todas):

| Variable | Para qué | Por defecto |
| :--- | :--- | :--- |
| `SMOKE_GATEWAY_URL` | Apuntar a otro gateway | `http://127.0.0.1:8090` |
| `SMOKE_USERNAME` / `SMOKE_PASSWORD` | Usar otro usuario | `admin` / `admin-odontocrm-2026` |
| `SMOKE_NEW_PASSWORD` | Contraseña a la que se cambia la temporal | `prueba-e2e-odontocrm-2026` |
| `SMOKE_TELEGRAM_CHAT_ID` | Enviar de verdad por Telegram en el humo de avisos | vacío (modo simulado) |
| `SMOKE_PATIENT_DOCUMENT` | Fijar el paciente en el humo de pacientes | aleatorio |

```powershell
# Ejemplo: humo de pantallas contra un gateway en otro puerto
$env:SMOKE_GATEWAY_URL='http://127.0.0.1:8090'; npm run smoke:screens

# Al terminar, restaurar la contraseña sembrada del administrador
npm run seed:users -- --reset
```

---

## 8. Operación en Windows (PM2) y Fedora

### Windows (desarrollo)

```powershell
# Todo de una: comprueba requisitos, bootstrap si hace falta, compila, migra y arranca
powershell -ExecutionPolicy Bypass -File infra/windows/start-services.ps1

# A mano con PM2
pm2 start infra/windows/ecosystem.config.cjs            # los 6 procesos
pm2 start infra/windows/ecosystem.config.cjs --only odontocrm-screens
pm2 restart odontocrm-gateway --update-env              # tras compilar
pm2 logs odontocrm-notifications --lines 50 --nostream
pm2 status
pm2 save                                                # recuerda la lista para el próximo arranque
```

Los servicios escriben en `logs/<servicio>.out.log` y `logs/<servicio>.error.log`.
**Tras cambiar código hay que `npm run build:node` y reiniciar el proceso**: PM2
ejecuta `dist/`, no el fuente.

### Fedora (producción, Fase 10)

| Archivo | Qué hace |
| :--- | :--- |
| `sudo ./infra/fedora/install.sh` | **Simulación** (no cambia nada). Añade `--apply` para aplicarlo |
| `sudo ./infra/fedora/install.sh --apply --with-firewall --lan-cidr=192.168.1.0/24` | Instalación completa con firewall |
| `infra/fedora/systemd/odontocrm@.service` | Unidad por servicio (o `ecosystem.config.cjs` para PM2) |
| `sudo infra/fedora/backup/odontocrm-backup.sh` | Respaldo diario de las 8 bases |
| `sudo infra/fedora/backup/odontocrm-restore.sh` | Restauración (se prueba en la Fase 10) |

La guía completa está en [`infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md).

---

## 9. Comandos por paquete o servicio

Cualquier script de un paquete se puede ejecutar desde la raíz con `-w`:

```powershell
npm run db:migrate -w @odontocrm/screens      # migrar solo un servicio
npm run start -w @odontocrm/scheduling        # arrancar solo ese servicio
npm run seed:demo -w @odontocrm/patients -- --count 5000
npm run build -w @odontocrm/web
npm run typecheck -w @odontocrm/web
```

| Paquete / servicio | Scripts propios |
| :--- | :--- |
| `@odontocrm/contracts`, `@odontocrm/events`, `@odontocrm/db`, `@odontocrm/kernel`, `@odontocrm/testing` | `build` |
| `@odontocrm/ui` | ninguno (se consume como código fuente) |
| `@odontocrm/identity` | `build`, `start`, `db:migrate`, `keys:generate`, `seed:users` |
| `@odontocrm/patients` | `build`, `start`, `db:migrate`, `seed:demo` |
| `@odontocrm/scheduling` | `build`, `start`, `db:migrate`, `seed:agenda` |
| `@odontocrm/notifications` | `build`, `start`, `db:migrate` |
| `@odontocrm/screens` | `build`, `start`, `db:migrate` |
| `@odontocrm/gateway` | `build`, `start` |
| `@odontocrm/web` | `dev`, `build`, `preview`, `typecheck` |

Los scripts de un workspace cargan **dos** `.env`: el de la raíz (común) y el suyo
(`../../.env` + `.env`). Si se ejecutan desde la raíz con `-w`, npm usa el `cwd` del
workspace y las rutas siguen siendo correctas.

---

## 10. «Quiero hacer X» → comando

| Quiero… | Comando |
| :--- | :--- |
| Levantar todo y usar la app | `npm run dev` (o `infra/windows/start-services.ps1`) |
| Usar la app con los servicios en PM2 | `npm run dev:web` (solo la web; el `/api` va al gateway por el proxy) |
| Saber si la pantalla está en negro por culpa de un servidor viejo | `npm run check:web` y `npm run dev:check` |
| Liberar los puertos que dejó una sesión anterior | `npm run dev:stop` |
| Saber si puedo commitear | `npm run verify` |
| Probar solo lo que toqué | `npx vitest run <ruta>` y luego `npm run test:integration -- <ruta>` |
| Verificar que las migraciones siguen aplicándose desde cero | `npm run db:verify-migrations` |
| Añadir una columna a un servicio | editar `src/db/schema.ts` → `npx drizzle-kit generate --config services/<svc>/drizzle.config.ts --name <cambio>` → revisar el SQL → `npm run db:migrate -- --only <svc>` |
| Vaciar y rehacer los datos de prueba | `npm run seed:demo -- --reset` y `npm run seed:agenda -- --reset` |
| Recuperar el acceso del administrador | `npm run seed:users -- --reset` |
| Ver por qué un aviso no se envió | `npm run smoke:notifications`, la bandeja `/notificaciones` y `logs/notifications.*.log` |
| Ver por qué un llamado no llega al lobby | `npm run smoke:screens`, `logs/screens.out.log` y `logs/scheduling.out.log` |
| Probar con Telegram real | token en `services/notifications/.env` + `TELEGRAM_MODE=auto` y `npm run smoke:notifications` |
| Probar WhatsApp | credenciales `WHATSAPP_*` en `services/notifications/.env`; el webhook es `/api/v1/notifications/webhook/whatsapp` |
| Registrar una pantalla kiosko | módulo `/pantallas` → «Nueva pantalla» → abrir el enlace con el token en el televisor |
| Revisar la auditoría de un cambio | módulo `/auditoria` o `GET /api/v1/audit/events` |
| Parar todo | `pm2 stop all` |

---

## 11. Qué `.env` necesita cada cosa

| Comando | `.env` que lee |
| :--- | :--- |
| `db:bootstrap` | raíz (`PG_ADMIN_URL`) |
| `db:migrate`, `db:verify-migrations` | raíz (`PG_ADMIN_URL`) + el de cada servicio (`DATABASE_URL`) |
| `keys:generate`, `seed:users` | raíz + `services/identity/.env` |
| `seed:demo` | raíz + `services/patients/.env` |
| `seed:agenda` | raíz + `services/scheduling/.env` |
| `dev:*`, `start:*` | raíz + el del servicio (y `apps/gateway/.env` para el gateway) |
| `test:integration` | los `.env` de los servicios (los lee `tools/test-integration.mjs` y los expone como `TEST_*_DATABASE_URL`) |
| `smoke:*` | ninguno: hablan por HTTP con el gateway |

Secretos que van **solo** en los `.env` (nunca al repositorio): `PG_ADMIN_URL`,
`INTERNAL_SERVICE_SECRET`, `COOKIE_SECRET`, `TELEGRAM_BOT_TOKEN`, `WHATSAPP_*` y las
claves de `services/identity/.keys/`. Detalle en
[`SEGURIDAD_SECRETOS.md`](SEGURIDAD_SECRETOS.md).

---

## 12. Problemas típicos

| Síntoma | Causa y qué hacer |
| :--- | :--- |
| **`127.0.0.1:5173` en negro / en blanco** | Casi siempre es un servidor de Vite **de una sesión anterior** que sigue ocupando el 5173 con el grafo de módulos roto: `npm run dev` no puede tomar el puerto (`strictPort`) y el navegador sigue mirando el viejo. Diagnóstico y arreglo: `npm run check:web` (dice si monta o no) → `npm run dev:stop` → `npm run dev`. Si el paquete no arranca, la propia página muestra un aviso con el error en vez de quedarse en negro |
| `EADDRINUSE` en 4001-4007 o 8090 | Ya hay un servicio arrancado (PM2 o un `dev` viejo): `npm run dev:check` dice quién es; `pm2 status` para los de PM2 y `npm run dev:stop` para los sueltos |
| El 5173 está ocupado | Quedó un Vite de otra sesión: `npm run dev:stop` antes de `npm run dev` |
| `listen EACCES` en 8090 | Es el aviso de la Fase 0: el 8080 lo ocupa Windows; el gateway usa 8090 |
| «Falta packages/db/dist» | Falta compilar: `npm run build` (o `build:node`) |
| Cambio código y la app no cambia | PM2 sigue con el código viejo: `npm run build:node` y `pm2 restart <proceso> --update-env` |
| Login 401 con la contraseña sembrada | Alguien (una prueba de humo) la cambió: `npm run seed:users -- --reset` |
| 423 «cuenta bloqueada» | 5 intentos fallidos: 15 minutos, o `npm run seed:users -- --reset` |
| Las pruebas de integración se saltan | Falta `TEST_*_DATABASE_URL`: ejecútalas con `npm run test:integration`, no con `npm test` |
| Un servicio no arranca y menciona una variable | La configuración se valida con Zod al arrancar: falta esa variable en su `.env` (míralo en `.env.example`) |
| El bot no responde en Telegram | `409 Conflict` por dos `getUpdates`: el poller es **único**, para el otro proceso |
| `git status` con `.env` o `*.pem` | Nunca deben versionarse: revisa `.gitignore` y corre `npm run check-secrets` |

---

> Este documento es la lista viva de comandos: si un comando cambia, se cambia aquí
> y en el `package.json` en el mismo commit.
