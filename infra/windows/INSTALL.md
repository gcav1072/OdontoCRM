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
| Software | Node.js 22.9+, PostgreSQL 18, Git. Si falta, la pieza 1 lo instala con `winget` |

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
| `--admin-url=URL` | Cómo entrar a PostgreSQL como administrador. **Obligatorio**: en Windows no hay socket «peer». Si no se pasa, se usa `PG_ADMIN_URL`. |
| `--ip=IP` | La IP de la LAN (si no, se deduce). |
| `--nombre-mdns=NOMBRE` | El nombre del servidor (va al certificado y a `WEB_ORIGIN`). Por defecto `odontocrm`. |
| `--solo=preparar\|aprovisionar\|desplegar\|verificar` | Ejecuta **una** pieza. |
| `--sin-preguntas` | No pregunta nada (clave del admin al azar, bot simulado). |
| `--clave-admin=…` `--token-telegram=…` `--whatsapp-token=…` | Dan los valores por bandera. |

## 4. Las cuatro piezas

El instalador no es un guion que hace siete cosas: son **cuatro piezas que se pueden ejecutar
y comprobar por separado**, encadenadas por un comando. Si algo falla, se retoma exactamente
desde la pieza que falló (todas son idempotentes: correrlas cinco veces deja lo mismo).

| Pieza | Qué hace | Se ejecuta sola |
| :--- | :--- | :--- |
| `10-preparar.ps1` | Node, PostgreSQL (servicio, puerto y `pg_hba` en `scram-sha-256`), los binarios `mkcert.exe` y `caddy.exe`, el PATH, la política de ejecución y los directorios con sus permisos | `.\10-preparar.ps1` |
| `20-aprovisionar.ps1` | **Genera los secretos una vez** en `C:\ProgramData\OdontoCRM\env`, crea los roles y las bases con *esas mismas* contraseñas y **comprueba cada una conectándose** | `.\20-aprovisionar.ps1 --admin-url=…` |
| `30-desplegar.ps1` | Código sin secretos, compilación, **Chromium** para los PDF, claves JWT, migraciones, usuarios iniciales, el servicio de PM2, el comando `odontocrm`, certificado TLS, Caddy, firewall, rol de respaldo y tareas programadas | `.\30-desplegar.ps1` |
| `40-verificar.ps1` | El **efecto**: cada credencial conecta, los 11 procesos responden, HTTPS sirve la aplicación, la CA se descarga y el firewall está bien | `.\40-verificar.ps1` |

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
| **Token del bot de Telegram** | los avisos salen de verdad | el bot queda en **modo simulado** y los avisos esperan en la bandeja |
| **WhatsApp Cloud API** | activa ese canal | el canal no se activa; lo demás funciona igual |

Se crea **una sola cuenta: `admin`**. El resto del personal se da de alta desde `/usuarios`.
Los tokens van a `C:\ProgramData\OdontoCRM\env` (solo Administradores y el servicio, en
lectura) y no se imprimen.

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

Los servicios corren como **`NT AUTHORITY\LocalService`** (PM2 y Caddy) y se conceden permisos
**por SID**, no por nombre, porque en un Windows en español la cuenta se llama «SERVICIO LOCAL».

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
| OdontoCRM · respaldo diario | 03:30 | `odontocrm-backup.ps1 --include-config` |
| OdontoCRM · alertas | cada 5 min | el tablero en modo alertas; falla si hay algún problema |
| OdontoCRM · red | cada 5 min | adapta firewall, certificado, CORS y proxy si cambió la IP |

```powershell
# Un respaldo ahora, con la configuración (CONTIENE SECRETOS):
odontocrm respaldar

# Ver qué respaldos hay y probar una restauración sin tocar la base real:
.\infra\windows\backup\odontocrm-restore.ps1 --list
.\infra\windows\backup\odontocrm-restore.ps1 --from C:\OdontoCRM\backups\2026-10-06 --db odonto_identity --dry-run
```

Los respaldos **contienen datos clínicos** y, con `--include-config`, también secretos:
cópialos a un medio protegido. El cifrado en reposo está pendiente, igual que en Fedora.

## 10. Solución de problemas

| Síntoma | Causa y solución |
| :--- | :--- |
| `este guion necesita una consola de Administrador` | Abre PowerShell con clic derecho → «Ejecutar como administrador». |
| `en Windows hace falta el administrador de PostgreSQL` | Pasa `--admin-url="postgres://postgres:CLAVE@127.0.0.1:5432/postgres"`. |
| `no encuentro «node»` | Node no está en el PATH: ejecuta `10-preparar.ps1` (o instálalo desde nodejs.org, instalación **estándar**, no `nvm`). |
| Al ejecutar un `.ps1` no arranca y salen símbolos raros | El archivo perdió el BOM: guárdalo como **UTF-8 con BOM**. |
| `no se puede cargar el archivo …pm2.ps1` | Política de ejecución: `Set-ExecutionPolicy -Scope LocalMachine RemoteSigned`. |
| PM2 no ve los procesos / `pm2 list` sale vacío | PM2 corre como `LocalService`: habla con él desde una consola de **Administrador**. |
| `HTTP 502` desde fuera pero `https://127.0.0.1` va bien | El firewall o el gateway: `Get-NetFirewallRule -DisplayName 'OdontoCRM Web (HTTPS)'`, y `pm2 status`. |
| Los PDF (récipe, factura, reportes) devuelven 503 | Falta Chromium: `.\40-verificar.ps1` lo señala; repite la pieza 3 (`30-desplegar.ps1`). |
| `password authentication failed` | Vuelve a aprovisionar (`20-aprovisionar.ps1`): converge la base a lo que dicen los archivos. |
| El puerto 443 no responde desde otro aparato | La red de Windows debe estar en perfil **Privado**: las reglas se crean solo para ese perfil. |
| `psql: error: … no password supplied` | Falta `C:\ProgramData\OdontoCRM\env\.pgpass` o `backup.env`: ejecuta `crear-rol-respaldo.ps1`. |

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
