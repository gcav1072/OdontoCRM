# Changelog

Todos los cambios relevantes de OdontoCRM. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
fases: cada fase termina con sus commits atómicos y su etiqueta `fase-N`.

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
