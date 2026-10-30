# OdontoCRM — Guía de instalación en Windows (servidor de la consulta)

> **Qué es este documento.** La guía para dejar un **servidor de la clínica** funcionando en
> un Windows 10/11. Si lo que buscas es **desarrollo** en tu PC, este no es el documento:
> mira [`DESARROLLO.md`](DESARROLLO.md).
>
> Windows es un **segundo destino de producción** soportado, además de Fedora
> ([ADR 0050](../../docs/adr/0050-windows-segundo-destino-de-produccion.md)). El código, las
> migraciones y los contratos son los mismos; lo que cambia es la orquestación.

---

## Índice

1. [Qué queda instalado y en qué puertos](#1-qué-queda-instalado-y-en-qué-puertos)
2. [Requisitos](#2-requisitos)
3. [Instalación completa en un comando](#3-instalación-completa-en-un-comando)
4. [Las cuatro piezas](#4-las-cuatro-piezas)
5. [Lo que pregunta (y por qué)](#5-lo-que-pregunta-y-por-qué)
6. [Dónde vive cada cosa](#6-dónde-vive-cada-cosa)
7. [El certificado en los equipos](#7-el-certificado-en-los-equipos)
8. [El día a día: `odontocrm`](#8-el-día-a-día-odontocrm)
9. [Respaldos](#9-respaldos)
10. [Solución de problemas](#10-solución-de-problemas)
11. [Desinstalar](#11-desinstalar)

---

## 1. Qué queda instalado y en qué puertos

```
   Navegador de la LAN (PC, tablet) ─┐
   TV sala de espera / consultorio ──┤  https://<IP-del-servidor>  (TLS interno)
                                     ▼
                      ┌──────────────────────────────┐
                      │ Caddy (proxy inverso)         │  ← único puerto abierto a la LAN
                      │  · sirve la SPA compilada     │
                      │  · /api/** → 127.0.0.1:8090   │
                      └──────────────┬───────────────┘
                                     ▼
                      ┌──────────────────────────────┐
                      │ gateway (Fastify) :8090       │  ← solo 127.0.0.1
                      └───┬───────┬───────┬───────┬───┘
                          ▼       ▼       ▼       ▼
            identity:4001 patients:4002 scheduling:4003 notifications:4004
            clinical:4005 odontogram:4006 screens:4007 reporting:4008 billing:4009
                          │  (todos en 127.0.0.1, REST interno + outbox)
                          ▼
                      PostgreSQL 18 en 127.0.0.1:5432 — una base por servicio + la cola
```

Reglas que no se negocian:

1. **Ningún servicio escucha en la LAN**: todos en `127.0.0.1`. La única puerta es el proxy.
2. **Cada servicio es dueño de su base**: la comunicación es REST interno o eventos del outbox.
3. **Sin Docker, sin RabbitMQ, sin Redis**: la cola es `pg-boss` sobre el mismo PostgreSQL.
4. **La SPA se sirve compilada** (estáticos) desde el proxy.

| Puerto | Qué | Escucha en | Abierto a la LAN |
| ---: | :--- | :--- | :--- |
| 80 | Caddy (redirección y descarga de la CA) | `0.0.0.0` | sí (solo perfil privado) |
| 443 | Caddy (HTTPS) | `0.0.0.0` | sí (solo perfil privado) |
| 8090 | gateway | `127.0.0.1` | no |
| 4001–4009 | los servicios | `127.0.0.1` | no |
| 5432 | PostgreSQL | `127.0.0.1` | no |

## 2. Requisitos

| Requisito | Valor |
| :--- | :--- |
| Windows | 10 u 11 (64 bits), con PowerShell 5.1 |
| Acceso | una consola **como Administrador** |
| Red | IP **fija** o reserva DHCP (los equipos entran por la IP) |
| Hora | zona `Venezuela Standard Time` (UTC-4) |
| Disco | separa, si puedes, los adjuntos y los respaldos |
| Recursos | 11 procesos Node pequeños + PostgreSQL + Chromium para PDF: **4 vCPU / 8 GB RAM / 60 GB SSD** como punto de partida |
| Software | Node.js 22.9+, PostgreSQL 18, Git. Si falta, la pieza 1 **lo instala sola** con `winget` |

> **Único requisito previo: `winget`.** Windows 10/11 lo trae (Microsoft Store →
> «Instalador de aplicaciones»). Con `winget` y red **no hace falta nada más instalado**
> antes de ejecutar los scripts: la pieza 1 pone Node, Git, PostgreSQL 18 y los binarios
> `mkcert.exe`/`caddy.exe`. Si tu Windows no lo trae —p. ej. una LTSC—, o lo instalas
> (<https://learn.microsoft.com/windows/package-manager/winget/>) o preinstalas a mano lo
> que falte ANTES de ejecutar el instalador:
>
> | Qué | Dónde |
> | :-- | :---- |
> | Node.js 22.9+ (MSI, no `nvm`) | <https://nodejs.org> |
> | Git | <https://git-scm.com/download/win> |
> | PostgreSQL 18 (EDB) | <https://www.postgresql.org/download/windows/> |
>
> `10-preparar.ps1 --comprobar` dice exactamente qué falta antes de empezar.

> **Node «estándar», no `nvm`.** El servicio de PM2 no soporta `nvm-for-windows`: instala
> Node con el MSI de <https://nodejs.org> (o deja que lo haga `winget`).

## 3. Instalación completa en un comando

```powershell
# Desde la raíz del repositorio, en una consola de Administrador:
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1
```

Antes, para saber si la máquina está lista **sin tocar nada** (se puede sin Administrador):

```powershell
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1 --comprobar
```

Y para revisar el plan completo sin ejecutarlo:

```powershell
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1 --dry-run
```

Banderas útiles:

| Bandera | Para qué |
| :--- | :--- |
| `--admin-url=URL` | Cómo entrar a PostgreSQL como administrador. Si no se pasa, se usa `PG_ADMIN_URL` y, si tampoco hay, **se pide la contraseña del usuario `postgres` por teclado** (oculta). |
| `--admin-usuario=…` `--admin-host=…` `--admin-puerto=…` | Si el administrador no es `postgres@127.0.0.1:5432` (lo normal si otra aplicación ya usa ese motor). |
| `--recuperar-postgres` | PostgreSQL ya estaba instalado y su contraseña se perdió: la que se dé pasa a ser la **nueva**. |
| `--ip=IP` | La IP de la LAN (si no, se deduce). |
| `--nombre-mdns=NOMBRE` | El nombre del servidor (va al certificado y a `WEB_ORIGIN`). Por defecto `odontocrm`. |
| `--solo=preparar\|aprovisionar\|desplegar\|verificar` | Ejecuta **una** pieza. |
| `--sin-preguntas` | No pregunta nada (clave del admin al azar, bot simulado). |
| `--clave-admin=…` `--token-telegram=…` `--whatsapp` | Dan los valores por bandera; `--whatsapp` deja el canal encendido para vincularlo por QR. |

## 4. Las cuatro piezas

El instalador no es un guion que hace siete cosas: son **cuatro piezas que se pueden ejecutar
y comprobar por separado**, encadenadas por un comando. Si algo falla, se retoma exactamente
desde la pieza que falló (todas son idempotentes: correrlas cinco veces deja lo mismo).

| Pieza | Qué hace | Se ejecuta sola |
| :--- | :--- | :--- |
| `10-preparar.ps1` | Node, PostgreSQL (servicio, puerto, una contraseña del administrador **conocida y comprobada** y `pg_hba` en `scram-sha-256`), los binarios `mkcert.exe` y `caddy.exe`, el PATH, la política de ejecución y los directorios con sus permisos | `.\10-preparar.ps1` |
| `20-aprovisionar.ps1` | **Genera los secretos una vez** en `C:\ProgramData\OdontoCRM\env`, crea los roles y las bases con *esas mismas* contraseñas y **comprueba cada una conectándose** | `.\20-aprovisionar.ps1` |
| `30-desplegar.ps1` | Código sin secretos, compilación, **Chromium** para los PDF, claves JWT, migraciones, usuarios iniciales, el servicio de PM2 (más el **bot de administración**, si está configurado), el comando `odontocrm`, certificado TLS, Caddy, firewall, rol de respaldo y tareas programadas | `.\30-desplegar.ps1` |
| `40-verificar.ps1` | El **efecto**: cada credencial conecta, los 11 procesos responden, **el PDF de prueba sale con Chromium**, HTTPS sirve la aplicación, la CA se descarga y el firewall está bien | `.\40-verificar.ps1` |

### Una sola fuente de verdad para las credenciales (ADR 0043)

Este es el punto que más caro costó en Fedora y el que el diseño protege. **Los secretos viven
en un solo sitio**: `C:\ProgramData\OdontoCRM\env`. El código desplegado en `C:\OdontoCRM` **no
contiene ninguno** y se puede borrar y volver a clonar sin perder nada. Una credencial se da
por buena **cuando conecta**, no cuando se escribió el archivo: `40-verificar.ps1` lo comprueba
conexión por conexión.

## 5. Lo que pregunta (y por qué)

En una instalación nueva, `instalar.ps1` **pregunta una vez** —con Enter se omite cada cosa—
para no tener que pelearse después con los archivos de `C:\ProgramData\OdontoCRM\env`:

| Pregunta | Para qué | Si se omite |
| :--- | :--- | :--- |
| **Contraseña del administrador** | es la cuenta con la que se entra la primera vez | se genera una temporal y se imprime UNA vez (queda en `C:\ProgramData\OdontoCRM\contrasena-inicial.txt`) |
| **Contraseña de `postgres` de PostgreSQL** | es la llave del *motor*: sin ella no se pueden crear las bases (en Windows no hay socket «peer») ni el rol de respaldo | si lo instala la pieza 1, con Enter se **genera una al azar y se imprime UNA vez** (esa contraseña nace con el motor); si el motor ya estaba instalado, la instalación se detiene antes de crear las bases —o repite con `--recuperar-postgres`— |
| **Token del bot de Telegram** | los avisos salen de verdad | el bot queda en **modo simulado** y los avisos esperan en la bandeja. El token se **comprueba contra Telegram** y su nombre (`@usuario`) se guarda solo |
| **Token del bot de administración** | avisa al dueño de los fallos del sistema | no hay avisos de infraestructura. El **chat se detecta solo**: se te pide escribirle «/start» al bot |
| **WhatsApp** | se activa y se vincula después por QR o código en **Configuración → Canales** | el canal queda apagado; lo demás funciona igual. Cloud API sigue disponible como proveedor alternativo |

Se crea **una sola cuenta: `admin`**. El resto del personal se da de alta desde `/usuarios`.
Los tokens van a `C:\ProgramData\OdontoCRM\env` (solo Administradores y el servicio, en
lectura) y no se imprimen. La contraseña de PostgreSQL **no se guarda en ningún sitio**: la
pide cada vez y solo vive en la memoria del instalador.

> **Los canales se guardan siempre**, aunque se ejecute una sola pieza (`--solo=desplegar`): quien
> escribe los tokens es el aprovisionador, así que el instalador lo llama en modo «solo archivos»
> cuando esa pieza no va a correr. Antes se pedían y se perdían al terminar, sin avisar.

> **PostgreSQL: los tres casos.** El instalador nunca deja el servidor sin poder crear las
> bases: si el motor ya estaba y la contraseña se sabe, la **comprueba**; si lo acaba de
> instalar la pieza 1, la contraseña que des **nace con el motor** —se la pasa al instalador
> en un fichero de opciones, nunca por la línea de órdenes— y se **comprueba**; con Enter se
> genera una **al azar y se imprime UNA vez** (no se guarda en ningún sitio: anótala). Y si
> el motor venía de antes y la contraseña se perdió, `--recuperar-postgres` la **reinicia**
> (abre la conexión local sin contraseña unos segundos, fija la nueva y restaura
> `pg_hba.conf` tal como estaba).

> **Los datos del consultorio** (nombre, RIF, teléfonos, logo y **odontólogos con su MPPS**) no
> se piden aquí: viven en la sección editable del código, `packages/contracts/src/clinic.ts`, y
> se cambian **antes** de desplegar (o con la «vía B» de
> [`docs/IDENTIDAD_Y_DATOS.md`](../../docs/IDENTIDAD_Y_DATOS.md) §9.1). El paso a paso está en ese
> mismo documento.

## 6. Dónde vive cada cosa

| Qué | Dónde | Quién puede |
| :--- | :--- | :--- |
| Código (clon, sin secretos) | `C:\OdontoCRM` | Administradores (control total) · servicio (lectura) |
| Adjuntos, navegador, datos | `C:\OdontoCRM\data` | Administradores · servicio (escritura) |
| Logs | `C:\OdontoCRM\logs` | Administradores · servicio (escritura) |
| Respaldos | `C:\OdontoCRM\backups` | Administradores y SYSTEM (tareas programadas) |
| **Secretos** (`.env`) | `C:\ProgramData\OdontoCRM\env` | Administradores (total) · servicio (lectura) |
| Certificado y su clave | `C:\ProgramData\OdontoCRM\tls` | Administradores · servicio (lectura) |
| CA pública que se descarga | `C:\OdontoCRM\data\www\ca` | Administradores · servicio (lectura) |
| `mkcert.exe`, `caddy.exe` | `C:\ProgramData\OdontoCRM\bin` | Administradores · servicio (lectura) |
| Comando `odontocrm` | `C:\ProgramData\OdontoCRM\bin\cmd` (en el PATH) | todos |
| PM2 | `C:\ProgramData\pm2` · prefijo npm `C:\ProgramData\npm` | `LocalService` |

> **Un solo PM2 por máquina.** En Windows PM2 nombra sus «pipes» en fijo y global
> (`\\.\pipe\rpc.sock` y `\\.\pipe\pub.sock`), así que **solo puede haber un demonio de PM2** a la
> vez. El del servidor es el que arranca el **servicio** (como `LocalService`); si en esta máquina
> hay además un PM2 de desarrollo, los dos se pelearán por los pipes y el servicio quedará caído.
> Tampoco hace falta reiniciar la consola tras instalar PM2: el instalador y `odontocrm` se llevan
> el entorno de máquina (`PM2_HOME`) por su cuenta.

Los servicios corren como **`NT AUTHORITY\LocalService`** (PM2 y Caddy) y se conceden permisos
**por SID**, no por nombre, porque en un Windows en español la cuenta se llama «SERVICIO LOCAL».

> **El código y los datos comparten carpeta.** El clon del repositorio vive en `C:\OdontoCRM`,
> junto a `data`, `logs` y `backups` (en Fedora son árboles distintos: `/opt/odontocrm` y
> `/var/lib/odontocrm`). Por eso el instalador **no** exige que esa carpeta esté vacía —la llena él
> mismo en la pieza 1—, clona conservando esas carpetas y `.gitignore` las ignora, para que
> `git status` en el servidor salga limpio y un `git add -A` no suba datos clínicos.

## 7. El certificado en los equipos

El TLS es **interno**: el navegador avisa la primera vez hasta que se instala la CA en cada
aparato. No es un fallo. La CA se descarga **desde el propio servidor** (una sola vez por
equipo):

| Aparato | Cómo |
| :--- | :--- |
| Android | `http://<IP>/ca.crt` → Ajustes → Seguridad → Cifrado y credenciales → Instalar un certificado → Certificado de CA |
| iPhone / iPad | `http://<IP>/ca.crt` (abrir con **Safari**) → Ajustes → Perfil descargado → y luego Información → Ajustes de confianza de certificados → **activar** |
| Windows | `http://<IP>/ca.der` (doble clic) o, en PowerShell como administrador: `irm http://<IP>/ca-windows.ps1 \| iex` |
| macOS | `http://<IP>/ca.crt` → Llavero «Sistema» → Confiar siempre |
| Linux | `curl -fsSL http://<IP>/ca-linux.sh \| sudo bash` |
| Firefox | Tiene su propio almacén: `about:config` → `security.enterprise_roots.enabled = true` |

La guía completa, sistema por sistema, está en
[`docs/CERTIFICADO_EN_LOS_EQUIPOS.md`](../../docs/CERTIFICADO_EN_LOS_EQUIPOS.md).

> La **misma CA** que en Fedora: un equipo que ya confíe en un servidor OdontoCRM validará
> también el otro.

## 8. El día a día: `odontocrm`

> El comando vive en `C:\ProgramData\OdontoCRM\bin\cmd` y lo pone el instalador en el PATH de la
> máquina. Si acabas de instalar y no se reconoce, **abre una consola nueva** (la anterior no ve el
> PATH recién escrito) y comprueba el paso 9/9 de `.\40-verificar.ps1`.

El comando del servidor es una sola puerta (en una consola de **Administrador**):

```powershell
odontocrm estado        # tablero completo: procesos, bases, cola, outbox y alertas
odontocrm alertas       # solo los problemas; sale con 1 si hay alguno
odontocrm verificar     # los procesos, HTTPS, la CA y el firewall
odontocrm respaldar     # respaldo ahora (bases + configuración)
odontocrm actualizar    # trae el código nuevo, compila, migra y reinicia
odontocrm certificado   # el certificado, la CA y cómo instalarla en cada aparato
odontocrm credenciales  # comprueba que cada credencial CONECTA
odontocrm red           # en qué IP se está sirviendo
odontocrm red --arreglar  # reemite el certificado y actualiza CORS y el proxy con la IP nueva
odontocrm servicios     # estado de los procesos (PM2)
odontocrm logs clinical 100
odontocrm parar / arrancar / reiniciar
odontocrm compilar / recompilar
odontocrm con-entorno identity -- node services/identity/dist/seed.js
```

## 9. Respaldos

Tres tareas programadas quedan registradas solas (mira `taskschd.msc`):

| Tarea | Cuándo | Qué hace |
| :--- | :--- | :--- |
| OdontoCRM · respaldo diario | 03:30 | `odontocrm-backup.ps1 --include-config --include-storage` (bases, config y almacén) |
| OdontoCRM · alertas | cada 5 min | el tablero en modo alertas; falla si hay algún problema |
| OdontoCRM · red | cada 5 min | adapta firewall, certificado, CORS y proxy si cambió la IP |

```powershell
# Un respaldo ahora (bases + almacén + configuración, que CONTIENE SECRETOS):
odontocrm respaldar

# Ver qué respaldos hay y probar una restauración sin tocar la base real:
.\infra\windows\backup\odontocrm-restore.ps1 --list
.\infra\windows\backup\odontocrm-restore.ps1 --from C:\OdontoCRM\backups\2026-10-06 --db odonto_identity --dry-run
```

Los respaldos **contienen datos clínicos** y, con `--include-config`, también secretos:
cópialos a un medio protegido. El cifrado en reposo está pendiente, igual que en Fedora.

El respaldo diario incluye el **almacén** (radiografías y PDFs) además de las bases y la
configuración, para que un fallo físico del disco sea recuperable. Para reponer un respaldo
completo en una máquina nueva o tras un fallo, sigue
[`RUNBOOK.md` §"Recuperación completa"](RUNBOOK.md).

> **A demanda y sin consola de Administrador**: por Telegram, `/respaldo` del bot de administración
> (o `npm run respaldo:manual` en la máquina) deja la copia **completa** —bases, almacén y
> configuración— en `C:\OdontoCRM\data\respaldo-manual\<AAAA-MM-DD_HHMMSS>\`, con los tres bloques,
> `SHA256SUMS` y `manifest.txt`. No va a `C:\OdontoCRM\backups` porque esa carpeta es solo de
> Administradores y el bot corre como `LocalService`. Es restaurable tal cual
> (`odontocrm recuperar --from <carpeta>`) y conserva las 5 últimas copias
> (`ODONTOCRM_BACKUP_MANUAL_KEEP`). Ver [`docs/RECUPERACION.md` §3b](../../docs/RECUPERACION.md).

## 10. Solución de problemas

| Síntoma | Causa y solución |
| :--- | :--- |
| `este guion necesita una consola de Administrador` | Abre PowerShell con clic derecho → «Ejecutar como administrador». |
| `sin administrador de PostgreSQL: no puedo crear las bases` | Repite la pieza 2 y **escribe la contraseña** cuando la pida, o pásala con `--admin-url="postgres://postgres:CLAVE@127.0.0.1:5432/postgres"`. |
| `la contraseña de «postgres» no conecta con este PostgreSQL` | El motor venía de antes y la contraseña no es esa. Si no la tienes: `10-preparar.ps1 --recuperar-postgres` (la que escribas pasa a ser la nueva). |
| `no encuentro PostgreSQL 18 y la instalación automática no lo dejó en su sitio` | Instálalo a mano desde postgresql.org (instalación **estándar**) y anota la contraseña de `postgres`: la pieza 2 la necesita. |
| `no encuentro «node»` | Node no está en el PATH: ejecuta `10-preparar.ps1` (o instálalo desde nodejs.org, instalación **estándar**, no `nvm`). |
| `odontocrm` no se reconoce al teclearlo | `C:\ProgramData\OdontoCRM\bin\cmd` no está en el **PATH de la máquina** (o tu consola es anterior al cambio). Míralo con `.\40-verificar.ps1`, que ahora lo comprueba en su paso 9/9. Solución: pieza 1 (`.\10-preparar.ps1`) y **abre una consola nueva** —la que tengas abierta de antes no ve el PATH recién escrito—. |
| Al ejecutar un `.ps1` no arranca y salen símbolos raros | El archivo perdió el BOM: guárdalo como **UTF-8 con BOM**. |
| `no se puede cargar el archivo …pm2.ps1` | Política de ejecución: `Set-ExecutionPolicy -Scope LocalMachine RemoteSigned`. |
| PM2 no ve los procesos / `pm2 list` sale vacío | PM2 corre como `LocalService`: habla con él desde una consola de **Administrador**. Si además tienes un PM2 de desarrollo en la misma máquina, se pelean por los «pipes» globales de PM2: para el servidor, uno solo |
| El servicio `pm2.exe` está en `Stopped` | Suele ser un demonio de PM2 de **otra cuenta** ocupando los pipes: `pm2 kill` en la consola de esa cuenta y `Restart-Service pm2.exe`. El instalador lo hace solo; el log está en `C:\ProgramData\pm2\service\service.log` |
| `npm run setup` falla con `Could not find "pm2.exe" service after 10 attempts` | node-windows cree el servicio «instalado» solo con los **archivos** `C:\ProgramData\pm2\service\daemon\pm2.exe`+`pm2.xml`, no mirando el servicio: si un desinstalar anterior los dejó, la reinstalación no crea ningún servicio. `instalar-pm2.ps1` los detecta y los retira; si el fallo persiste, el servicio quedó «marcado para eliminación» → reinicia Windows y repite |
| `40-verificar.ps1` dice «… no está en PM2» con los procesos en marcha | El `ConvertFrom-Json` de PowerShell 5.1 no puede con el JSON de `pm2 jlist`: el `env` de cada proceso trae `username` y `USERNAME`, claves que solo difieren en mayúsculas, y las da por duplicadas. La lista se quedaba vacía y todo salía «ausente»; la verificación la resume ahora `tools\pm2-resumen.mjs` |
| La verificación dice «http devolvió 200 (se esperaba 301)» o «el SSE devolvió 0» con el servidor bien | Falsos del verificador, no del servidor: `Invoke-WebRequest` sigue las redirecciones y **lanza** en los 4xx (el SSE sin token devuelve 401). El chequeo usa ahora `HttpWebRequest` y ve el código real; si dudas, `curl -sk -o NUL -w "%{http_code}" <url>` |
| El instalador se queda **colgado** en «Supervisión (PM2)», o un `pm2` no responde nunca | El CLI llegó antes de que el servicio publicara su «message bus», no encontró demonio y **se montó uno propio** (del Administrador) que robó los «pipes»: `pm2 kill` en las consolas abiertas, `Restart-Service pm2.exe` y repite `servicios\instalar-pm2.ps1`. Los guiones ahora esperan al bus, retiran los demonios sueltos y ponen techo de tiempo a cada `pm2` |
| Los procesos están «online» pero **ningún puerto escucha** y los registros de la app están vacíos | PM2 arrancó en modo **cluster** (basta declarar `instances`, aunque sea `1`): en Windows no puede cargar apps ESM y el proceso queda vacío. El ecosistema de producción lleva `exec_mode: 'fork'` explícito; **no añadas `instances`** a un `ecosystem.cjs` |
| `HTTP 502` desde fuera pero `https://127.0.0.1` va bien | El firewall o el gateway: `Get-NetFirewallRule -DisplayName 'OdontoCRM Web (HTTPS)'`, y `pm2 status`. |
| La SPA, la API y la CA devuelven `0`, y el servicio `caddy` está en `Stopped` | Caddy corre como `LocalService` y tiene que poder **leer y ejecutar** `C:\ProgramData\OdontoCRM\bin\caddy.exe`. Suele pasar cuando el binario se movió desde `%TEMP%` (conserva sus ACL): repite la **pieza 1** (`instalar.ps1`), que revisa ese permiso. El motivo exacto está en `Get-EventLog System -Source "Service Control Manager" -Newest 5` (`%%5` = acceso denegado) |
| Los PDF (récipe, factura, reportes) devuelven 503 | `.\40-verificar.ps1` lo señala («Los imprimibles») y dice cuál de las dos causas: **falta Chromium** → repite la pieza 3 (`30-desplegar.ps1`); o **«EPERM … mkdtemp …playwright-artifacts»** → los procesos heredaron el `%TEMP%` de la consola del administrador y LocalService no puede escribir ahí. La pieza 3 fija `TMP`/`TEMP`/`TMPDIR` en `data\tmp` (`ecosystem.produccion.config.cjs`) y rearranca los servicios; basta con repetirla |
| `C:\OdontoCRM` tiene cosas que no puso el instalador | El instalador se niega a clonar donde hay algo ajeno y te dice **qué** encontró. Muévelo aparte (`Rename-Item C:\OdontoCRM C:\OdontoCRM.viejo`) y repite. Las carpetas `data`, `logs` y `backups` **no** cuentan: son suyas y se conservan |
| `sin PG_ADMIN_URL no puedo crear el rol de respaldo` | La pieza 3 lo necesita para su paso 10/10: repite `instalar.ps1 --solo=desplegar` y escribe la contraseña de `postgres` cuando la pida, o ejecuta `infra\windows\backup\crear-rol-respaldo.ps1` (también la pide). |
| La «contraseña temporal» del instalador no entra | El instalador genera una **nueva** en cada ejecución, pero el seed **omite los usuarios que ya existen**: solo es la de verdad si la cuenta se acaba de crear. En una reinstalación, regenera la clave con `seed.js --reset --usuarios=admin` y `SEED_PASSWORD_ADMIN` (RUNBOOK §5, «Usuarios») |
| Los avisos de Telegram no salen (quedan «modo simulado») | El token no quedó en `C:\ProgramData\OdontoCRM\env\notifications.env`, o es incorrecto: compruébalo abriendo `https://api.telegram.org/bot<token>/getMe` en el navegador. Repite `instalar.ps1 --solo=desplegar` con el token y se guardará. |
| `password authentication failed` | Vuelve a aprovisionar (`20-aprovisionar.ps1`): converge la base a lo que dicen los archivos. |
| El puerto 443 no responde desde otro aparato | La red de Windows debe estar en perfil **Privado**: las reglas se crean solo para ese perfil. El instalador lo pone solo y `40-verificar.ps1` lo señala como fallo; a mano: `Set-NetConnectionProfile -NetworkCategory Private` |
| `psql: error: … no password supplied` | Falta `C:\ProgramData\OdontoCRM\env\.pgpass` o `backup.env`: ejecuta `crear-rol-respaldo.ps1`. |
| `'tsc' no se reconoce como un comando interno o externo` al compilar | La consola traía `NODE_ENV=production` (o `NPM_CONFIG_OMIT=dev`) y `npm ci` dejó `node_modules` **sin devDependencies**. Los guiones compilan ya con el entorno limpio (`Con-EntornoNpmLimpio`); a mano: `Remove-Item Env:\NODE_ENV`, `npm ci` otra vez y repite `30-desplegar.ps1` |

## 11. Desinstalar

```powershell
# Enseña lo que borraría; no toca nada:
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\desinstalar.ps1 --dry-run

# Lo hace (guarda antes los secretos y un pg_dump de cada base):
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\desinstalar.ps1 --si
```

Quita el servicio de PM2, el de Caddy, las tareas programadas, el código, las reglas de
firewall, los directorios de datos **y las bases y los roles** —y antes **guarda** los secretos
y un `pg_dump` de cada base en `C:\OdontoCRM-antes-de-desinstalar-<fecha>\`—. Con
`--conservar-datos` no borra adjuntos, registros ni respaldos. **Node.js, PostgreSQL y sus
datos de instalación no se tocan**, a propósito.

Si el volcado de una base falló, esa base **no se borra** (el motivo queda en
`<base>.dump.error` dentro de la carpeta de la copia); y si no se pudo volcar ninguna, no se
borra ninguna. Ojo: las bases `odonto_*` son **las mismas** del stack de desarrollo
(`npm run dev`): lo que haya entrado por cualquiera de los dos pilas se borra aquí.
