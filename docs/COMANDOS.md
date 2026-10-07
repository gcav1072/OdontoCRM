# Comandos de OdontoCRM

> Guía única de comandos: qué hace cada uno, cuándo se usa y qué necesita para
> funcionar. Todo se ejecuta **desde la raíz del repositorio** salvo donde se diga
> lo contrario. Los identificadores (nombres de scripts, servicios y variables) van
> en inglés o tal cual; las explicaciones, en español.
>
> Referencias: [`README.md`](../README.md) · [`PLAN_MAESTRO_FASES.md`](PLAN_MAESTRO_FASES.md) ·
> [`SEGURIDAD_SECRETOS.md`](SEGURIDAD_SECRETOS.md) · [ADRs](adr/README.md)

> **¿Buscas los comandos del servidor de la clínica?** Este documento es para
> **desarrollo** (levantar la pila local, pruebas, seeds). Para el sistema en marcha está
> [`COMANDOS_PRODUCCION.md`](COMANDOS_PRODUCCION.md).

## Índice

1. [Los cinco comandos del día a día](#1-los-cinco-comandos-del-día-a-día)
2. [Puesta en marcha desde cero](#2-puesta-en-marcha-desde-cero)
3. [Calidad y pruebas](#3-calidad-y-pruebas)
4. [Base de datos y migraciones](#4-base-de-datos-y-migraciones)
5. [Datos de prueba (seeds)](#5-datos-de-prueba-seeds)
5-bis. [Estado del sistema (observabilidad)](#5-bis-estado-del-sistema-observabilidad)
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
| `npm run verify` | **Puerta de calidad**: secretos → lint → formato → **tipos (Node y web)** → compilación → pruebas unitarias | Antes de cada commit importante y **siempre** antes de cerrar una fase |
| `npm run stack:status` | ¿Qué pila está corriendo y quién la tiene? (una sola a la vez: `dev` con recarga o `fijo` con PM2) | Al empezar a trabajar y cuando la aplicación «no cambia» |
| `npm run stack:dev` / `stack:fijo` / `stack:down` | Cambiar de modo sin dejar dos pilas: con recarga, con PM2 o parar todo | Al pasar de trabajar el código a dejarlo corriendo, y al revés |
| `npm test` | Pruebas unitarias y de contrato (Vitest, sin base de datos) | Mientras se programa: `npm run test:watch` |
| `npm run test:integration` | Las mismas suites **contra PostgreSQL real** (outbox, colas, sesiones, agenda, pantallas) | Antes de dar algo por terminado |
| `npm run smoke:<módulo>` | Recorrido de punta a punta **contra los servicios arrancados** por el gateway | Cuando algo «funciona en las pruebas pero no en la app» (`auth`, `patients`, `agenda`, `notifications`, `screens`, `odontogram`, `clinical`, `prescription`, `billing`) |

> `npm run verify` **no** ejecuta las pruebas de integración ni las de humo: no toca
> la base de datos ni arranca servicios. Para el DoD de una fase hay que correr
> también `db:verify-migrations` y el humo del módulo que se haya tocado.

---

## 2. Puesta en marcha desde cero

Requisitos: **Node.js 26**, **PostgreSQL 18** en `127.0.0.1:5432`, `npm` y (opcional,
para tener los servicios siempre vivos) `pm2`. Ver [`infra/windows/DESARROLLO.md`](../infra/windows/DESARROLLO.md).

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
| `npm run verify` | Encadena `check-secrets`, `lint`, `format:check`, `typecheck`, `build` y `test` | El estándar de cierre de fase |
| `npm run check-secrets` | Busca secretos en lo que está en *staging* | `-- --all` audita todo el repo |
| `npm run lint` | ESLint 9 (incluye las reglas anti SQL-injection) | `npx eslint <ruta>` para un archivo |
| `npm run format` / `format:check` | Prettier: escribe / comprueba | `npx prettier --write <ruta>` para un archivo |
| `npm run typecheck` | `tsc -b` (proyectos Node) + `tsc --noEmit` (web) | Igual que `build` en la parte Node |
| `npm run build` | Todo el monorepo: `tsc -b` + `vite build` | Deja los artefactos en `dist/` |
| `npm run build:node` | Solo los servicios y paquetes (`tsc -b`), sin la web | Es lo que hay que correr antes de `start:*` |
| `npm test` | Vitest: unitarias y de contrato | Sin base de datos; las de integración se **omiten** |
| `npm run test:watch` | Vitest en vigilancia | Mientras se programa |
| `npx vitest run <ruta>` | Una sola suite unitaria | Ej.: `npx vitest run packages/contracts/src/domain/screens.test.ts` |
| `npm run test:integration` | Suites contra PostgreSQL real | `-- <ruta>` para una sola; requiere `db:bootstrap`, `db:migrate` y `build`. Corre con 4 workers (varias suites esperan a que los servicios en marcha auditen sus eventos) y le prepara a la de reportes **una base temporal propia** que borra al terminar |
| `npm run db:verify-migrations` | Aplica las migraciones de **cada servicio** desde cero en bases limpias | `-- --only screens`; necesita `build` y `PG_ADMIN_URL` |
| `npm run audit` | **Auditoría de conexiones**: eventos (quién publica y quién escucha), HTTP (rutas ↔ gateway ↔ interfaz, internas no expuestas), permisos y configuración, y bases + cola compartida | `-- --solo eventos\|http\|permisos\|datos`; sale con error solo si algo es estructural |

---

## 4. Base de datos y migraciones

| Comando | Qué hace | Flags |
| :--- | :--- | :--- |
| `npm run db:bootstrap` | Crea las 8 bases, un rol por servicio con privilegios solo sobre la suya, las extensiones (`pgcrypto`, `pg_trgm`), la cola compartida `odonto_events` y escribe las credenciales en cada `services/<svc>/.env` | `-- --rotate` (contraseñas nuevas), `-- --only <servicio>` |
| `npm run db:migrate` | Aplica las migraciones de todos los servicios implementados | `-- --only <servicio>` |
| `npm run db:verify-migrations` | Desde cero: crea una base temporal por servicio, migra con el migrador real, comprueba tablas/índices y la borra | `-- --only <servicio>` |
| `npm run db:generate:<servicio>` | Genera una migración a partir del esquema Drizzle del servicio | `identity`, `patients`, `scheduling`, `notifications`, `screens`, `clinical`, `odontogram`, `reporting` |
| `npm run db:reset` | **Borra absolutamente todo** y deja el sistema **listo para usar**: las 9 bases `odonto_*` (con `with (force)`) y el contenido de `storage/`; después compila, hace `db:bootstrap`, `db:migrate` y **siembra los usuarios**. Solo consola y **exige `--yes`** | `-- --yes` (hace falta) · `-- --solo-bases` (conserva los archivos) · `-- --remoto` (permite una base que no es de esta máquina) |
| `npm run env:check` | Compara cada `services/<svc>/.env` con su **plantilla** (`.env.example`) y dice qué claves faltan y qué se pierde con cada una. Nunca imprime valores | `-- --todo` (informa también de los `.env` ausentes) |
| `npm run keys:generate` | Par de claves EdDSA del JWT en `services/identity/.keys/` (ignorado por Git) | `-- --force` regenera (invalida todas las sesiones) |

Los generadores de migración se ejecutan **desde la raíz** (drizzle-kit resuelve las
rutas contra el directorio de trabajo) y suelen necesitar nombre y revisión a mano:

```powershell
npx drizzle-kit generate --config services/screens/drizzle.config.ts --name mi_cambio
```

> `db:bootstrap` es **idempotente**: no toca lo que ya existe salvo con `--rotate`.
> Si un `.env` de servicio se borra, `db:bootstrap --only <servicio>` lo regenera.

### Los `.env` y sus plantillas

Cada servicio tiene **dos** archivos de entorno:

| Archivo | Qué es | ¿Va a Git? |
| :--- | :--- | :--- |
| `services/<svc>/.env` | El de verdad: credenciales de su base, secretos y el **token del bot**. Lo escribe `npm run db:bootstrap` (salvo lo que solo sabes tú, como el token). | No (ignorado) |
| `services/<svc>/.env.example` | La **plantilla**: qué claves existen, cuáles son obligatorias, cuáles opcionales y su valor por defecto. El modelo real está en `services/<svc>/src/config.ts`. | Sí |

**Convención de la plantilla:** las líneas **sin comentar** son claves que deben estar
en el `.env` (las repone `db:bootstrap`, más el token del bot y su usuario); las
**comentadas** son opcionales, con su valor por defecto entre paréntesis.

```powershell
npm run env:check        # ¿a algún .env le falta una clave de su plantilla?
```

Es lo que faltaba cuando un corte de luz dejó los ocho `.env` con el tamaño de antes y
el contenido a ceros: al rehacerlos se perdió el `TELEGRAM_BOT_TOKEN` (no lo conoce
`db:bootstrap`) y el bot quedó en **modo simulado** —dejó de contestar— sin que nada lo
dijera. Ahora lo dicen `env:check` y `dev:check`. El bot también lo avisa al arrancar
(«Sin TELEGRAM_BOT_TOKEN: el servicio arranca en modo simulado») y la bandeja
`/notificaciones` muestra el modo.

**Restaurar el token del bot** (lo da BotFather: `/mybots` → tu bot → *API Token*):

```powershell
notepad services\notifications\.env      # TELEGRAM_BOT_TOKEN=<token>  y  TELEGRAM_BOT_USERNAME=odegcrmbot
npm run env:check                        # tiene que decir «todas las claves» ✔
pm2 restart odontocrm-notifications      # o `npm run stack:fijo`
```

### Empezar de cero (`db:reset`)

Los seeds **no** dejan la base limpia: solo quitan lo ficticio, y la historia clínica, las
sesiones, los récipes y el odontograma **no se pueden borrar** por diseño (son documentos
inmutables: [ADR 0034](adr/0034-sesion-clinica-evolucion.md),
[ADR 0036](adr/0036-recipe-emitido-documento-archivado.md)). Para empezar de cero de verdad:

```powershell
npm run stack:down                  # el comando se niega a borrar con la pila en marcha
npm run db:reset -- --yes           # borra todo y reconstruye (deja la app lista para usar)
npm run stack:fijo                  # (o stack:dev) y a probar
```

- Es una herramienta **de consola y solo de consola**: ningún servicio, ruta ni botón la llama,
  y sin `--yes` no borra nada (explica lo que haría y sale con código 1). Una bandera que no
  conozca **no se ignora**: el comando se detiene y dice cuáles valen.
- **Los usuarios se siembran siempre.** Existió una bandera `--sin-sembrar` que los omitía y
  solo servía para dejar la aplicación inservible (sin usuarios no entra nadie, con ninguna
  contraseña): se retiró el 2026-10-04.
- **No toca** los roles de PostgreSQL, los `.env`, las claves del JWT (`.keys/`) ni la
  configuración.
- Al terminar hay que **volver a iniciar sesión** (las sesiones y los refrescos viven en la base).
- Lo que queda sembrado: los **3 usuarios** (admin, recepción y el odontólogo, con contraseña
  temporal), las **10 franjas** de la plantilla de jornada y los **25 medicamentos** del catálogo
  (de las migraciones), y las **20 plantillas** de mensajes (al arrancar `notifications`).

**Guardas (por qué es difícil hacerlo mal):**

| Guarda | Qué evita |
| :--- | :--- |
| `--yes` obligatorio | Un dedo en el sitio equivocado |
| **Bloqueo de mantenimiento** (`tmp/mantenimiento.lock`, con el PID) | Arrancar la pila *mientras* se recrean las bases: los servicios que apunten a una base que ya no existe se caen al conectar y el bot falla con `ECONNREFUSED`. Lo miran `dev:check` (la puerta de `npm run dev`) y `stack:dev` / `stack:fijo`. Si el proceso que lo creó murió, el bloqueo está **caducado** y se limpia solo (no se queda pegado como un candado ciego) |
| Pila parada (puertos libres) | Borrar la base debajo de los servicios en marcha |
| `NODE_ENV=production` | Reiniciar por descuido la base de la clínica |
| Host de `PG_ADMIN_URL` local | Borrar por accidente la base de un servidor remoto (se puede con `--remoto`, dicho a propósito) |
| Lista cerrada de 9 bases | Que un nombre calculado se lleve por delante otra base de la instancia |
| `with (force)` | Que una conexión suelta (pgAdmin) deje el borrado a medias |
| Comprobación de la ruta de `storage/` | Un borrado recursivo sobre una ruta no verificada |

- `npm run dev:check` comprueba además que **las 9 bases existan** y avisa si no hay usuarios
  antes de arrancar: si un `db:reset` quedó a medias, lo dice con esas palabras en vez de dejar
  media pila en pie.
- **Si el login dice «todavía no hay ningún usuario»** (o `dev:check` avisa de lo mismo), es que
  las migraciones corrieron pero no el seed: `npm run seed:users` y listo. El login lo dice él
  mismo (código `no_users` del problema RFC 7807) en vez de culpar a la contraseña.

### Si se corta la luz (o el equipo se apaga de golpe)

PostgreSQL es resistente a un apagón (WAL + `fsync`), pero **los archivos de configuración
generados sí pueden quedar con el tamaño de antes y el contenido a ceros** (le pasó a los ocho
`services/<svc>/.env` el 2026-10-04). Síntoma: los servicios no arrancan o no conectan y el
`.env` del servicio tiene bytes nulos. Se arregla sin perder datos ni migraciones:

```powershell
npm run stack:down
npm run db:bootstrap     # reescribe los .env (y rota la contraseña del rol si no pudo leerla)
npm run db:migrate       # comprueba que los 8 servicios conectan (es idempotente)
npm run stack:fijo
```

Las bases, los datos y las claves del JWT (`.keys/`, que no se regeneran) sobreviven al corte.
Si el `.env` quedó con una línea de ceros conservada por el bootstrap, se puede limpiar
(`\0` fuera) sin tocar las claves.

---

## 5. Datos de prueba (seeds)

| Comando | Qué crea | Flags |
| :--- | :--- | :--- |
| `npm run seed:users` | `admin`, `recepcion` y **un odontólogo por cada uno de `CLINIC.dentists`** (`packages/contracts/src/clinic.ts`) con contraseña temporal | `-- --reset` regenera las contraseñas · `-- --print` **recuerda** las claves sin tocar nada |
| `npm run seed:demo` | Pacientes ficticios deterministas (cédulas 90.000.000+, `is_fictitious`) | `-- --count 5000`, `-- --reset` (borra **solo** lo ficticio) |
| `npm run seed:agenda` | Solicitudes y citas de ejemplo en el próximo día de consulta | `-- --reset` (las borra) |
| **`npm run seed:test`** | **Mundo de prueba completo del modo test** (Fases 10 y 11): 40 pacientes, sus solicitudes y citas (atendidas, inasistencias, canceladas, reprogramadas y la jornada de hoy), historias firmadas, sesiones cerradas, odontogramas, récipes emitidos, cupos del mes, **la facturación del mundo** (histórico de tasas, aranceles del catálogo, la factura de cada sesión cerrada con sus cobros y la nota de crédito de la anulada) **y los eventos** que alimentan reportes, auditoría y pantallas | `-- --anchor 2026-10-02` fija el día de referencia · `-- --solo billing` siembra una parte · `-- --dry-run` explica sin tocar nada |
| **`npm run seed:verify`** | No crea nada: comprueba por **huellas** que lo sembrado es exactamente el mundo (pacientes, agenda, clínica, odontograma y facturación, con el `sha256` de cada PDF archivado) | `-- --con-proyeccion` comprueba además el read model de reportes (necesita la pila arriba) |
| **`npm run seed:reset`** | Borra **solo** el mundo de `seed:test` (pacientes, citas, historias, sesiones, récipes y sus PDF, odontogramas, facturas, cobros, notas de crédito y sus PDF, tasas, aranceles a cero, avisos, proyección, auditoría del seed y sus eventos) | — |

> Los tres `--reset` quitan **solo datos de prueba**: pacientes ficticios, sus citas y las
> contraseñas. La clínica (historias, sesiones, récipes, odontogramas) y la auditoría se quedan.
> Para una base limpia de verdad: [`npm run db:reset`](#empezar-de-cero-dbreset).

### El modo test (Fase 10)

`seed:test` es el seed determinista del [ADR 0020](adr/0020-modo-test.md) y **solo corre con el
modo test activo**:

```bash
# En el .env de la raíz (nunca en la instalación de la clínica)
TEST_MODE=true
ALLOW_TEST_MODE=true

npm run build          # los seeds corren sobre dist/: compila primero
npm run seed:test      # siembra (repetirlo no duplica: es idempotente)
npm run seed:verify    # comprueba que lo sembrado es el mundo
npm run seed:reset     # lo borra y deja las secuencias como estaban
```

- **Con `NODE_ENV=production` los tres comandos se niegan a correr**, aunque las banderas estén
  en `true`: es el criterio de aceptación de la fase.
- Los datos llevan cédulas **90.000.000+**, tickets, récipes, facturas, recibos y notas de crédito del
  rango reservado **900.000+** y la nota «MODO TEST»; la interfaz pinta el banner rojo y los envíos
  reales quedan bloqueados.
- El día de referencia es **hoy** (hora de Venezuela) salvo que se fije con `--anchor`: así la
  jornada siempre tiene sala de espera y consultorio, y los reportes tienen semanas de historia.
- **Los eventos se entregan cuando la pila está arriba** (el outbox de cada servicio los publica y
  los consumidores proyectan). Con la pila parada, `seed:verify` valida las bases operativas pero
  el read model de reportes queda vacío hasta que arranques.
- **La facturación se escribe en la base, no esperando a la cola**: el borrador nace del cierre de la
  sesión clínica, así que el seed escribe el borrador de cada sesión (y su factura, si ya se cobró) y
  **reclama el evento de cierre** en `billing.processed_events`. Con la pila arriba o parada, la caja
  abre con el mismo trabajo: las tres sesiones más recientes en borrador y el resto con su historia
  cobrada. El día del ancla queda con su tasa publicada, así que se puede emitir y cobrar sin tocar
  nada más.

Los tres comandos anteriores (`seed:users`, `seed:demo`, `seed:agenda`) siguen existiendo y
**no emiten eventos**: son para poblar a mano. El mundo del modo test es el camino completo.

### ¿Cuál era la clave del admin?

```powershell
npm run seed:users -- --print
```

No escribe nada: lista los tres usuarios con su **contraseña por defecto** (la que
siembra el sistema) y, consultando la base, dice de cada una si **sigue valiendo**, si
alguien ya la cambió o si la cuenta está **bloqueada** por intentos fallidos (con la hora
a la que se desbloquea).

| Usuario | Contraseña por defecto | Rol |
| :--- | :--- | :--- |
| `admin` | `admin-odontocrm-2026` | administrador (acceso total) |
| `recepcion` | `recepcion-odontocrm-2026` | secretaria |
| `egomez` | `consultorio-odontocrm-2026` | odontóloga |

> **Otro odontólogo:** las cuentas de odontólogo salen de `CLINIC.dentists` en
> [`packages/contracts/src/clinic.ts`](../packages/contracts/src/clinic.ts) —nombre, usuario y MPPS—;
> cambia esa sección (o añade otra entrada a la lista) y `npm run seed:users` crea su cuenta con la
> misma contraseña temporal. Ver «Poner el sistema con otro odontólogo» en el
> [`README`](../README.md#poner-el-sistema-con-otro-odontólogo).

- Nacen como **temporales**: el sistema obliga a cambiarlas en el primer acceso.
- **Las pruebas de humo cambian la del `admin`** a `prueba-e2e-odontocrm-2026`; después,
  `npm run seed:users -- --reset` la devuelve a la temporal (y limpia bloqueos e intentos).
- 5 intentos fallidos bloquean la cuenta 15 minutos. `--reset` también lo limpia.
- En producción (`NODE_ENV=production`) estas claves **no existen**: hay que indicarlas en
  `SEED_PASSWORD_ADMIN`, `SEED_PASSWORD_RECEPCION` y `SEED_PASSWORD_EGOMEZ`.

Detalles que conviene saber:

- `seed:demo` **avisa** en vez de chocar si ya hay datos: la segunda ejecución sin
  `--reset` explica cómo regenerarlos.
- `seed:agenda` necesita pacientes ficticios: si no hay, lo dice y no hace nada.
- Las pruebas de humo cambian la contraseña del administrador. Después:
  `npm run seed:users -- --reset`.

---

## 5-bis. Estado del sistema (observabilidad)

```bash
npm run estado                      # una foto: 9 servicios, bases, cola, outbox, envíos
npm run estado -- --alertas         # solo los problemas; sale con 1 si hay alguno
npm run estado -- --json            # la foto en JSON (para una máquina)
npm run estado -- --sin-servicios   # sin preguntar por HTTP (pila parada)
npm run estado -- --vigilar 5       # refresca cada 5 s (terminal abierta)
```

Qué mira, y por qué importa cada cosa:

| Sección | Qué dice | Cuándo es un problema |
| :--- | :--- | :--- |
| Servicios | `/health` y `/ready` de los 9, con la latencia y el chequeo que falla | alguno no responde o no está listo |
| Bases | versión, tamaño y conexiones | no se puede conectar |
| Cola | `pg-boss`: pendientes, fallidos y completados por cola | hay fallidos o pendientes viejos |
| Outbox | eventos sin publicar, con reintentos y último error | lleva más de 5 min sin publicar (el publicador no corre) |
| Envíos | mensajes en cola, fallidos y sin canal | hay envíos atascados (> 15 min) o fallidos |
| Reportes | eventos proyectados y último refresco | el último refresco falló |
| Disco | espacio libre en la raíz | queda menos del 10 % |

**Modo test**: si está activo, el tablero lo avisa en la primera línea (los datos son
ficticios y los envíos están bloqueados).

En Fedora, `infra/fedora/systemd/odontocrm-alertas.timer` ejecuta
`npm run estado -- --alertas` cada cinco minutos: sin salida y con código 0 significa
«todo bien»; si algo falla, el servicio queda en `failed` y se ve con
`systemctl --failed`. Detalle en [INSTALL.md §10.6](../infra/fedora/INSTALL.md).

---

## 6. Arrancar y parar servicios

### Una sola pila a la vez

Los servicios, la puerta y la interfaz ocupan **puertos fijos**, así que no puede haber
dos pilas vivas: la segunda se queda sin puerto y falla a medias (fue un caso real: una
pila sin recarga servía la aplicación mientras `npm run dev` reintentaba en bucle y PM2
acumulaba reinicios; nadie sabía qué estaba corriendo). Los puertos son la fuente de
verdad y `stack:*` los cambia de modo sin dejar dos vivas:

| Comando | Qué hace |
| :--- | :--- |
| `npm run stack:status` | **Empieza por aquí**: qué pila está corriendo, en qué puertos, quién la tiene y desde cuándo |
| `npm run stack:dev` | Para lo que haya y arranca **todo con recarga** (`tsc -b --watch` + servicios + Vite), en primer plano |
| `npm run stack:fijo` | Para lo que haya, compila (`tsc -b`) y arranca **todo con PM2** (servicios + interfaz): sobrevive a la terminal |
| `npm run stack:down` | Para la pila (aplicaciones de PM2 incluidas) y deja los puertos libres |
| `npm run stack:guard` | Comprueba si hay pila y **falla** si la hay (`--puerto 4005` para uno solo) |

`stack:down` solo mata procesos de la pila (los reconoce por su línea de comandos): si
un puerto lo ocupa un programa ajeno, avisa y lo deja en paz.

### Desarrollo (procesos sueltos, con recarga)

| Comando | Arranca |
| :--- | :--- |
| `npm run dev` | Todo: `tsc -b --watch` + gateway + identity + patients + scheduling + notifications + screens + clinical + odontogram + web |
| `npm run dev:web` | **Solo la interfaz** (Vite en `http://127.0.0.1:5173`) |
| `npm run dev:<servicio>` | Un solo servicio en vigilancia: `identity`, `patients`, `scheduling`, `notifications`, `screens`, `clinical`, `odontogram`, `gateway`, `web`, `build` |
| `npm run dev:check` | Comprueba que los puertos del desarrollo estén libres y dice quién los ocupa (se ejecuta **solo** antes de `npm run dev`) |
| `npm run dev:stop` | Para procesos sueltos de un `npm run dev` anterior (los de PM2 no se tocan: los para `npm run stack:down`) |
| `npm run check:web` | Abre la interfaz con un navegador sin interfaz y verifica que **monta** y que la consola está limpia |

`npm run dev` requiere haber migrado y sembrado antes; los servicios leen
`.env` (raíz) + `services/<svc>/.env`.

> **PM2 y `npm run dev` no conviven**: los dos quieren los mismos puertos, y el
> preflight `dev:check` lo dice antes de que nada falle a medias. Para cambiar de modo
> no hay que pensar en PIDs: `npm run stack:dev` (con recarga) o `npm run stack:fijo`
> (sin ella). La **interfaz va incluida en los dos modos** (`stack:fijo` levanta Vite
> dentro de PM2), así que no hace falta tener una terminal aparte sirviendo la web.

### Sin vigilancia (lo que corre PM2)

| Comando | Arranca |
| :--- | :--- |
| `npm run stack:fijo` | **La pila completa** con PM2 (los 8 servicios + la interfaz), compilando antes |
| `npm run start:<servicio>` | Un servicio desde `dist/` (`identity`, `patients`, `scheduling`, `notifications`, `screens`, `clinical`, `odontogram`, `gateway`) |
| `npm run build:node` | **Hay que compilar antes**: `start:*` ejecuta `dist/`, no el código fuente |
| `npm run preview -w @odontocrm/web` | Interfaz compilada en `http://127.0.0.1:4173` |
| `pm2 logs odontocrm-clinical` | Registros de un servicio (también en `logs/<servicio>.out.log`) |

### Puertos

| Servicio | Puerto | | Interfaz | Puerto |
| :--- | :-: | :-: | :--- | :-: |
| gateway (única puerta) | 8090 | | web en desarrollo | 5173 |
| identity | 4001 | | web compilada (`preview`) | 4173 |
| patients | 4002 | | PostgreSQL | 5432 |
| scheduling | 4003 | | | |
| notifications | 4004 | | | |
| clinical | 4005 | | | |
| odontogram | 4006 | | | |
| screens | 4007 | | | |
| reporting | 4008 | | | |
| billing | 4009 | | | |

Todos los servicios escuchan en `127.0.0.1`: se entra **solo** por el gateway.

### Qué se instala aparte

| Qué | Cuándo | Comando |
| :--- | :--- | :--- |
| Chromium de Playwright | Para el **PDF A5 del récipe** (Fase 7B) y para las capturas de revisión | `npx playwright install chromium` |

Los adjuntos de la sesión y los PDF de los récipes y las facturas se guardan en disco:
`STORAGE_DIR` es una **raíz compartida** (`./storage/patients` de serie;
`/var/lib/odontocrm/storage` en el servidor) y cada servicio escribe en su subcarpeta, así que los
archivos de `patients`, `clinical` y `billing` viven bajo el mismo árbol
(`<raíz>/billing/<paciente>/factura-….pdf`). Está en `.gitignore` y **entra en el respaldo** junto
con la base de datos (Fase 10).

Con `STORAGE_ENCRYPTION_KEY` puesta, todo lo que se guarda va **cifrado en reposo**
(AES-256-GCM). Los ficheros anteriores a la clave se siguen leyendo sin tocarla.

| Comando | Qué hace | Flags |
| :--- | :--- | :--- |
| `npm run recifrar:almacen` | Pasa a cifrado lo que quedó en claro. Idempotente: lo que ya está cifrado no se vuelve a tocar. Escribe a un temporal, renombra y comprueba el `sha256` después | `-- --estado` (solo mira y cuenta) · `-- --todos` (re-cifra **todo**, al cambiar la clave: guarda la vieja antes) |
| `npm run verify:backup` | **Simulacro de restauración**: coge el último respaldo, lo restaura en bases temporales (`odonto_verify_*`), cuenta la tabla de control de cada una y las borra. Detecta un `.dump` truncado o con un bit cambiado | `-- --from <carpeta>` (por defecto, el más reciente) · `-- --dest <carpeta>` · `-- --db patients` (solo esa base, repetible; vale el nombre corto o el completo) · `-- --conservar` (no borra las temporales) · `-- --estado` (no restaura, solo lista) · `-- --sin-aviso` |

> El simulacro **no toca las bases de verdad**: las temporales se crean desde `template0` y se
> borran siempre, también cuando algo falla. Si sale mal, el aviso de emergencia va al bot de
> administración (`ADMIN_TELEGRAM_BOT_TOKEN` / `ADMIN_TELEGRAM_CHAT_ID`).

---

## 7. Pruebas de humo

Recorren el camino completo por el **gateway real** (sesión, permisos, proxy, eventos,
base de datos). Necesitan los servicios arrancados y datos sembrados.

| Comando | Qué recorre | Comprobaciones |
| :--- | :--- | :--- |
| `npm run telegram:menu` | El **menú de comandos** que Telegram tiene registrado para el bot, comparado con el catálogo del contrato | 1 (con `-- --set` lo vuelve a registrar) |
| `npm run smoke:auth` | Ciclo de sesión: login, refresco, permisos, cierre | 17 |
| `npm run smoke:patients` | Registro, duplicado, edición con motivo, borrado y auditoría · **subida, listado y descarga de un adjunto** | 29 |
| `npm run smoke:agenda` | Ticket, cupo, franja, sobrecupo, reprogramación y aviso en lote | 41 |
| `npm run smoke:notifications` | Estado de canales, plantillas, vinculación con QR, aviso de cita con `.ics` y el botón «Notificar» sin duplicar | 27 |
| `npm run smoke:screens` | Pantalla kiosko, llamado en el lobby por SSE (mide la latencia), consultorio y baja de la pantalla | 26 |
| `npm run smoke:odontogram` | Boca por teclado, superación de caras por la pieza completa, borrado y auditoría | 29 |
| `npm run smoke:clinical` | Sesión clínica: abrir, autoguardar, cerrar (y no cerrar en blanco), enmendar, hallazgo del odontograma ligado a la sesión y «atendido» con y sin sesión (estrena paciente y busca hora libre en cada corrida) | 30 |
| `npm run smoke:prescription` | Fase 7B: adjunto de la sesión (subida, listado, descarga y pieza), catálogo, borrador del récipe, **emisión con número y PDF A5**, no emitir dos veces, reimpresión auditada, anulación con motivo, **verificación pública sin token**, y que la secretaría imprime pero no receta | 32 |
| `npm run smoke:reporting` | Fase 9: **el recorrido que alimenta los reportes** —alta, teléfono editado con motivo, cita, aviso, historia firmada con diabetes y alergia, sesión cerrada, récipe emitido y tres hallazgos del odontograma— y después el tablero, los **seis reportes** con sus cifras, la **exportación CSV y PDF**, los permisos de la secretaría (operativos 200 / clínicos 403) y la **auditoría del teléfono** con su valor anterior, el nuevo y el motivo | 81 |
| `npm run smoke:billing` | Fase 11, sesión B: el recorrido de la caja —sesión clínica cerrada → el **borrador** que deja el consumidor → preciar sus líneas (el catálogo entra en 0) → **lote de formas** y **tasa del día** → **emitir** (los dos números, la tasa congelada y el PDF archivado con su `sha256`) → **cobrar** en bolívares y en divisas → saldo, estado, `/auditoria` y el PDF en el almacén— (da de alta el lote solo si no queda ninguno, como el mostrador; estrena paciente) | 30 |
| `npm run e2e:flujo` | Fase 8: **el día completo en Chromium** sobre `/flujo`. La odontóloga entra con su usuario `odontologo`, registra al paciente, le da cita, registra la llegada, llama con `F4`, lo pasa a consulta, escribe y cierra la sesión con `F8` y marca la cita atendida **sin salir de `/flujo`**; después comprueba `/secretaria` y `/consultorio` y que la consola y la red queden limpias | 27 |
| `npm run e2e:reportes` | Fase 9: `/reportes` y `/auditoria` en **Chromium**. Entra por el menú lateral, comprueba las tarjetas del tablero, las **gráficas de Recharts**, la tabla y las descargas, recorre **las seis pestañas**, cambia el rango de fechas, y en `/auditoria` filtra por la acción del cambio de teléfono y verifica el **diff antes/después** con el motivo; deja una captura en `tmp/e2e-reportes.png` | 37 |
| `npm run reports:latencia` | Fase 9: llena el read model con **10.000 citas y 3.000 pacientes sintéticos** (marcados, y los borra al terminar) y cronometra los seis reportes por el gateway. Falla si alguno pasa de 2 s (`REPORTS_LIMIT_MS`); `-- --keep` deja los datos para mirar la pantalla y `-- --clean` los borra | 6 |

> `smoke:prescription` necesita Chromium (lo usa el propio servicio para componer el PDF):
> `npx playwright install chromium`. Si el navegador no está, la emisión responde 500 y el humo lo
> dice con claridad.
>
> `e2e:flujo` necesita además la **interfaz** levantada (5173) y Chromium. Cambia la contraseña del
> odontólogo sembrado (`egomez`); al terminar, `npm run seed:users -- --reset`.

Variables opcionales (mismas en todas):

| Variable | Para qué | Por defecto |
| :--- | :--- | :--- |
| `SMOKE_GATEWAY_URL` | Apuntar a otro gateway | `http://127.0.0.1:8090` |
| `SMOKE_USERNAME` / `SMOKE_PASSWORD` | Usar otro usuario | `admin` / `admin-odontocrm-2026` |
| `SMOKE_NEW_PASSWORD` | Contraseña a la que se cambia la temporal | `prueba-e2e-odontocrm-2026` |
| `SMOKE_TELEGRAM_CHAT_ID` | Enviar de verdad por Telegram en el humo de avisos | vacío (modo simulado) |
| `SMOKE_PATIENT_DOCUMENT` | Fijar el paciente en el humo de pacientes | aleatorio |
| `E2E_WEB_URL` / `E2E_GATEWAY_URL` | Apuntar la prueba de `/flujo` a otra interfaz o gateway | `http://127.0.0.1:5173` / `http://127.0.0.1:8090` |
| `E2E_USERNAME` / `E2E_PASSWORD` / `E2E_NEW_PASSWORD` | Usuario de la prueba de `/flujo` (tiene que ser `odontologo`) | `egomez` / `consultorio-odontocrm-2026` / `flujo-odontocrm-2026` |

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
| `infra/fedora/systemd/odontocrm-verificar-respaldo.timer` | **Simulacro semanal** (domingos 04:30): `tools/verify-backup.mjs` restaura el último respaldo en bases temporales y avisa si falla |

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
| `@odontocrm/reporting` | `build`, `start`, `db:migrate` (su refresco de vistas también se puede forzar por `POST /internal/v1/reporting/refresh`) |
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
| **Cerrar una fase con todo revisado** | `npm run verify` + `npm run audit` + `npm run test:integration` + el humo del módulo |
| Usar la app con los servicios en PM2 | `npm run dev:web` (solo la web; el `/api` va al gateway por el proxy) |
| Saber si la pantalla está en negro por culpa de un servidor viejo | `npm run check:web` y `npm run dev:check` |
| Liberar los puertos que dejó una sesión anterior | `npm run dev:stop` |
| Saber si puedo commitear | `npm run verify` |
| Probar solo lo que toqué | `npx vitest run <ruta>` y luego `npm run test:integration -- <ruta>` |
| Verificar que las migraciones siguen aplicándose desde cero | `npm run db:verify-migrations` |
| Comprobar que el respaldo se puede restaurar | `npm run verify:backup` (no toca las bases de verdad: usa temporales) |
| Saber cuántos ficheros del almacén están sin cifrar | `npm run recifrar:almacen -- --estado` |
| Cifrar el historial que quedó en claro | `npm run recifrar:almacen` (idempotente; se puede cortar y repetir) |
| Cambiar la clave de cifrado del almacén | guardar la vieja → nueva `STORAGE_ENCRYPTION_KEY` en los tres servicios → `npm run recifrar:almacen -- --todos` |
| Reemplazar el logo de la clínica | `assets/clinic/logo.svg` → `npm run marca:css` |
| Añadir una columna a un servicio | editar `src/db/schema.ts` → `npx drizzle-kit generate --config services/<svc>/drizzle.config.ts --name <cambio>` → revisar el SQL → `npm run db:migrate -- --only <svc>` |
| Vaciar y rehacer los datos de prueba | `npm run seed:demo -- --reset` y `npm run seed:agenda -- --reset` |
| Recuperar el acceso del administrador | `npm run seed:users -- --reset` |
| Ver por qué un aviso no se envió | `npm run smoke:notifications`, la bandeja `/notificaciones` y `logs/notifications.*.log` |
| Ver por qué un llamado no llega al lobby | `npm run smoke:screens`, `logs/screens.out.log` y `logs/scheduling.out.log` |
| Probar con Telegram real | token en `services/notifications/.env` + `TELEGRAM_MODE=auto` y `npm run smoke:notifications` |
| Probar WhatsApp | credenciales `WHATSAPP_*` en `services/notifications/.env`; el webhook es `/api/v1/notifications/webhook/whatsapp` |
| Registrar una pantalla kiosko | módulo `/pantallas` → «Nueva pantalla» → abrir el enlace con el token en el televisor |
| Revisar la auditoría de un cambio | módulo `/auditoria` o `GET /api/v1/audit/events` |
| Un paciente con cita sigue como «en espera de cita» | `node tools/reparar-estados-pacientes.mjs` (informa) y `--apply` para repararlo · requiere `npm run build:node` |
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
| `recifrar:almacen` | el `.env` de **cada** servicio (`STORAGE_DIR` y `STORAGE_ENCRYPTION_KEY`) |
| `verify:backup` | raíz (`PG_ADMIN_URL`) y, para el aviso, las claves del bot de administración |

Secretos que van **solo** en los `.env` (nunca al repositorio): `PG_ADMIN_URL`,
`INTERNAL_SERVICE_SECRET`, `COOKIE_SECRET`, `TELEGRAM_BOT_TOKEN`, `WHATSAPP_*`,
`STORAGE_ENCRYPTION_KEY`, `ADMIN_TELEGRAM_BOT_TOKEN` y las
claves de `services/identity/.keys/`. Detalle en
[`SEGURIDAD_SECRETOS.md`](SEGURIDAD_SECRETOS.md).

---

## 12. Problemas típicos

| Síntoma | Causa y qué hacer |
| :--- | :--- |
| **`127.0.0.1:5173` en negro / en blanco** | Casi siempre es un servidor de Vite **de una sesión anterior** que sigue ocupando el 5173 con el grafo de módulos roto: `npm run dev` no puede tomar el puerto (`strictPort`) y el navegador sigue mirando el viejo. Diagnóstico y arreglo: `npm run check:web` (dice si monta o no) → `npm run dev:stop` → `npm run dev`. Si el paquete no arranca, la propia página muestra un aviso con el error en vez de quedarse en negro |
| `EADDRINUSE` en 4001-4008 o 8090 | Ya hay un servicio arrancado (PM2 o un `dev` viejo): `npm run dev:check` dice quién es; `pm2 status` para los de PM2 y `npm run dev:stop` para los sueltos |
| El 5173 está ocupado | Quedó un Vite de otra sesión: `npm run dev:stop` antes de `npm run dev` |
| `listen EACCES` en 8090 | Es el aviso de la Fase 0: el 8080 lo ocupa Windows; el gateway usa 8090 |
| «Falta packages/db/dist» | Falta compilar: `npm run build` (o `build:node`) |
| Cambio código y la app no cambia | PM2 sigue con el código viejo: `npm run build:node` y `pm2 restart <proceso> --update-env` |
| Login 401 con la contraseña sembrada | Alguien (una prueba de humo) la cambió: `npm run seed:users -- --print` te lo dice y `npm run seed:users -- --reset` la restaura |
| 423 «cuenta bloqueada» | 5 intentos fallidos: 15 minutos, o `npm run seed:users -- --reset` (que además limpia el bloqueo) |
| «¿Cuál era la clave del admin?» | `npm run seed:users -- --print` |
| Las pruebas de integración se saltan | Falta `TEST_*_DATABASE_URL`: ejecútalas con `npm run test:integration`, no con `npm test` |
| `verify:backup` dice que un archivo no es un `.dump` | El respaldo se cortó o se corrompió: míralo con `npm run verify:backup -- --estado` y revisa el `SHA256SUMS` de esa carpeta. Los respaldos anteriores siguen ahí |
| Un adjunto se abre como basura | El fichero está **cifrado** y el servicio no tiene `STORAGE_ENCRYPTION_KEY` (una clave distinta da lo mismo). Restaura la clave: sin ella esos ficheros no se leen. Los que estén en claro se ven igual |
| Un servicio no arranca y menciona una variable | La configuración se valida con Zod al arrancar: falta esa variable en su `.env` (míralo en `.env.example`) |
| El bot no responde en Telegram | `409 Conflict` por dos `getUpdates`: el poller es **único**, para el otro proceso |
| Al paciente no le sale el menú `/` en Telegram | Comprueba el registro con `npm run telegram:menu` (y `npm run telegram:menu -- --set` si no coincide). Si ahí aparece y en el móvil no, cierra y abre la aplicación de Telegram: cachea la lista |
| `git status` con `.env` o `*.pem` | Nunca deben versionarse: revisa `.gitignore` y corre `npm run check-secrets` |

---

> Este documento es la lista viva de comandos: si un comando cambia, se cambia aquí
> y en el `package.json` en el mismo commit.
