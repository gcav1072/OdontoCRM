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

# 4. Compila y aplica migraciones
npm run build
npm run db:migrate

# 5. Arranca (compilación en modo vigilancia + gateway + identidad)
npm run dev
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

| Comando | Qué hace |
| :--- | :--- |
| `npm run dev` | Compila en modo vigilancia y arranca gateway + identity |
| `npm run build` | Compila todo el monorepo (`tsc -b`, incremental) |
| `npm run typecheck` | Igual que `build`: el proyecto se valida compilando |
| `npm test` | Pruebas unitarias y de integración (Vitest) |
| `npm run test:watch` | Pruebas en modo vigilancia |
| `npm run test:integration` | Pruebas contra PostgreSQL real (outbox y cola `pg-boss`); requiere `db:bootstrap` y `db:migrate` |
| `npm run lint` | ESLint (incluye las reglas anti SQL-injection) |
| `npm run format` / `format:check` | Prettier |
| `npm run check-secrets` | Busca secretos antes de commitear (`-- --all` audita todo) |
| `npm run db:bootstrap` | Crea bases, roles y credenciales (`-- --rotate`, `-- --only identity`) |
| `npm run db:migrate` | Aplica las migraciones de todos los servicios |
| `npm run db:generate:identity` | Genera la migración de identity desde su esquema (desde la raíz) |
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
| patients | 4002 | Fase 2 |
| scheduling | 4003 | Fase 3 |
| notifications | 4004 | Fase 4 |
| clinical | 4005 | Fase 6 |
| odontogram | 4006 | Fase 6 |
| screens | 4007 | Fase 5 |
| reporting | 4008 | Fase 9 |

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
