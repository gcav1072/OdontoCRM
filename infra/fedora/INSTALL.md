# OdontoCRM — Guía de instalación en Fedora (servidor de producción)

> **Estado: BORRADOR de la Fase 0.** Este documento se **completa y se prueba** en la
> Fase 10 del [plan maestro](../../docs/PLAN_MAESTRO_FASES.md) (§13, Fase 10). Ninguna
> afirmación marcada con `> PENDIENTE FASE 10:` está verificada todavía: son puntos
> que deben comprobarse contra el Fedora real antes de usar el sistema con datos de
> pacientes.
>
> **Destino:** Fedora 43 o superior, servidor local de la clínica (LAN), **nunca
> expuesto a internet**. El desarrollo se hace en Windows; la producción es Fedora.
>
> **Decisiones que esta guía respeta** (no se proponen alternativas):
> nativo sin Docker (§1.1) · PostgreSQL 18 local, una base y un rol por servicio
> (§1.2) · outbox + `pg-boss` sobre el mismo PostgreSQL, sin RabbitMQ ni Redis
> (§1.3) · 9 servicios Node escuchando en `127.0.0.1` (§2.2) · JWT EdDSA + refresh
> rotativo en cookie `Secure` (§1.5, §11) · PM2 o unidades `systemd` (§1.1, §11) ·
> secretos en `/etc/odontocrm` — **dos archivos por servicio**
> (`odontocrm.env` común + `<servicio>.env` propio, como el `.env` de la raíz y
> `services/<servicio>/.env` del desarrollo), con `0600` y propietario `root`,
> cargados con `EnvironmentFile=` (§11, §8.1) · almacenamiento de archivos con
> abstracción S3-ready (§2.2, Fase 7) · récipes A5 con Playwright/Chromium (§1.15) ·
> acceso remoto por VPN mesh tipo Tailscale (§1.21) · respaldos `pg_dump` diarios con
> retención de 30 días y restauración probada (§11).

---

## Índice

1. [Cómo usar esta guía](#1-cómo-usar-esta-guía)
2. [Arquitectura que se instala y tabla de puertos](#2-arquitectura-que-se-instala-y-tabla-de-puertos)
3. [Preparación del sistema](#3-preparación-del-sistema)
4. [Paquetes base (dnf)](#4-paquetes-base-dnf)
5. [Node.js 26, npm y PM2](#5-nodejs-26-npm-y-pm2)
6. [PostgreSQL 18](#6-postgresql-18)
7. [Usuario de sistema y layout de directorios](#7-usuario-de-sistema-y-layout-de-directorios)
8. [Variables de entorno y secretos](#8-variables-de-entorno-y-secretos)
9. [Despliegue del código y compilación](#9-despliegue-del-código-y-compilación)
10. [Arranque y supervisión: systemd (recomendado) o PM2](#10-arranque-y-supervisión-systemd-recomendado-o-pm2)
11. [Red: firewalld](#11-red-firewalld)
12. [SELinux](#12-selinux)
13. [TLS interno y reverse proxy](#13-tls-interno-y-reverse-proxy)
14. [Tailscale (acceso remoto futuro)](#14-tailscale-acceso-remoto-futuro)
15. [Respaldos](#15-respaldos)
16. [Restauración y prueba de restauración](#16-restauración-y-prueba-de-restauración)
17. [Verificación final y lista de comprobación](#17-verificación-final-y-lista-de-comprobación)
18. [Rollback y desinstalación segura](#18-rollback-y-desinstalación-segura)
19. [Solución de problemas](#19-solución-de-problemas)
20. [Registro de verificación de la Fase 10](#20-registro-de-verificación-de-la-fase-10)
21. [Anexos](#21-anexos)

---

## 1. Cómo usar esta guía

### 1.1 Archivos que acompañan a esta guía

| Archivo | Para qué sirve |
| :--- | :--- |
| [`install.sh`](install.sh) | Aprovisionamiento idempotente: paquetes, usuario de sistema, directorios, plantillas de `/etc/odontocrm`, PM2 y arranque automático. **Por defecto solo simula** (`--dry-run`); con `--apply` ejecuta. |
| [`systemd/odontocrm@.service`](systemd/odontocrm@.service) | Unidad plantilla para los 8 servicios internos (`odontocrm@identity`, `odontocrm@clinical`, …). Carga `/etc/odontocrm/odontocrm.env` + `/etc/odontocrm/%i.env` y arranca `services/%i/dist/index.js`. |
| [`systemd/odontocrm-gateway.service`](systemd/odontocrm-gateway.service) | Unidad del gateway (puerto 8090, sin base de datos). Carga `/etc/odontocrm/odontocrm.env` + `/etc/odontocrm/gateway.env` y arranca `apps/gateway/dist/index.js`. |
| [`systemd/odontocrm-alertas.service`](systemd/odontocrm-alertas.service) + [`systemd/odontocrm-alertas.timer`](systemd/odontocrm-alertas.timer) | **Observabilidad (Fase 10)**: cada 5 minutos corre `node tools/estado.mjs --alertas` y deja el servicio en `failed` si algo no responde, el outbox se atasca, la cola tiene fallidos o queda poco disco. Ver §10.6. |
| [`logrotate/odontocrm`](logrotate/odontocrm) | Rotación diaria (30 días, comprimida) de `/var/log/odontocrm/*.log`. Con `systemd` los servicios van al journal, que rota solo; esto cubre los logs de operación y los de PM2 si se elige ese supervisor. |
| [`ecosystem.config.cjs`](ecosystem.config.cjs) | **Alternativa a `systemd`**: procesos de PM2 para Fedora, con rutas absolutas (`/opt/odontocrm/...`) y los mismos dos `--env-file-if-exists=/etc/odontocrm/...`. Nunca los dos supervisores a la vez (§10.1 y §10.4). |
| [`backup/odontocrm-backup.sh`](backup/odontocrm-backup.sh) | Respaldo diario de las 8 bases (`pg_dump -Fc`), verificación de integridad, retención configurable y copias opcionales. |
| [`backup/odontocrm-restore.sh`](backup/odontocrm-restore.sh) | Restauración de una base o de todas, con paso previo por una base temporal de verificación. |

Los tres scripts deben ser **ejecutables** (Git en Windows puede no conservar el bit
de ejecución). Después de clonar en el servidor:

```bash
cd /opt/odontocrm
sudo chmod +x infra/fedora/install.sh infra/fedora/backup/odontocrm-*.sh
# Si el bit de ejecución no se registró en Git y quieres arreglarlo de raíz:
sudo git update-index --chmod=+x infra/fedora/install.sh \
     infra/fedora/backup/odontocrm-backup.sh infra/fedora/backup/odontocrm-restore.sh
```

### 1.2 Convenciones

- Los comandos se escriben **como se teclean**. `sudo` se indica explícitamente;
  si ya eres `root`, omítelo.
- `<...>` es un valor que debes sustituir (por ejemplo `<IP_DEL_SERVIDOR>`).
- `> PENDIENTE FASE 10:` marca algo **no verificado**. Si aparece en un paso que vas
  a ejecutar, compruébalo antes y anota el resultado en §20.
- Los identificadores, nombres de archivo y comandos van en inglés; la explicación,
  en español (convención del plan §14).

### 1.3 Antes de empezar: lo que este documento NO puede garantizar

- **Versiones exactas de los paquetes.** Fedora cambia de versión cada ~6 meses.
  `postgresql18-server`, `postgresql18-contrib` y el canal de Node.js 26 deben
  confirmarse en el Fedora que se instale.
  > PENDIENTE FASE 10: (P-01) ejecutar `dnf list installed | grep -E 'postgresql18|nodejs|pm2'`
  > y pegar el resultado en §20.
- **Nombres de las variables de entorno.** Las plantillas que genera
  [`install.sh`](install.sh) ya siguen el contrato real de la Fase 0
  (`packages/kernel/src/config.ts`, `services/identity/src/config.ts`,
  `apps/gateway/src/config.ts`, `.env.example`, `infra/db/bootstrap.mjs`), pero **cada
  fase añade variables propias** para sus servicios.
  > PENDIENTE FASE 10: (P-03) al cerrar cada fase, reconciliar
  > `/etc/odontocrm/<servicio>.env` con el `config.ts` de ese servicio y con
  > `.env.example`; el kernel falla rápido (`ConfigError`) si falta una obligatoria.
- **Comportamiento de Chromium bajo `systemd` endurecido** (el soporte de
  `install-deps` en Fedora ya está resuelto: no lo hay, se usa la lista de `dnf`). Ver §9.5.
- **Nada de lo relacionado con datos clínicos** debe considerarse listo hasta que la
  prueba de restauración de §16 esté hecha y registrada.

---

## 2. Arquitectura que se instala y tabla de puertos

### 2.1 Qué queda corriendo

```
   Navegador de la LAN (PC, tablet) ─┐
   TV sala de espera / consultorio ──┤  https://odontocrm.local  (TLS interno)
                                     ▼
                      ┌──────────────────────────────┐
                      │ reverse proxy (Caddy/nginx)   │  ← único puerto abierto a la LAN
                      │  · sirve la SPA compilada     │
                      │  · /api/** → 127.0.0.1:8090   │
                      └──────────────┬───────────────┘
                                     ▼
                      ┌──────────────────────────────┐
                      │ gateway (Fastify) :8090       │  ← solo 127.0.0.1
                      └───┬───────┬───────┬───────┬───┘
                          ▼       ▼       ▼       ▼
            identity:4001 patients:4002 scheduling:4003 notifications:4004
            clinical:4005 odontogram:4006 screens:4007 reporting:4008
                          │  (todos en 127.0.0.1, REST interno + outbox)
                          ▼
                      PostgreSQL 18 en 127.0.0.1:5432 — 8 bases + outbox + pg-boss
```

Reglas que no se negocian:

1. **Ningún servicio escucha en la LAN**: todos en `127.0.0.1`. La única puerta es el
   reverse proxy (§11 y §13).
2. **Cada servicio es dueño de su base**: la comunicación entre servicios es REST
   interno (service JWT) o eventos del outbox, nunca consultas cruzadas.
3. **Sin Docker, sin RabbitMQ, sin Redis**: la cola es `pg-boss` sobre el mismo
   PostgreSQL.
4. **La SPA se sirve compilada** (estáticos) desde el reverse proxy.

### 2.2 Tabla de puertos

| Puerto | Servicio | Escucha en | Base de datos | Rol de BD (por defecto) | Unidad `systemd` | Nombre en PM2 |
| ---: | :--- | :--- | :--- | :--- | :--- | :--- |
| 443 | reverse proxy (Caddy/nginx) | `0.0.0.0` (solo LAN, firewalld) | — | — | `caddy` / `nginx` | — |
| 8090 | `gateway` | `127.0.0.1` | — | — | `odontocrm-gateway.service` | `odontocrm-gateway` |
| 4001 | `identity` | `127.0.0.1` | `odonto_identity` | `odonto_identity` | `odontocrm@identity.service` | `odontocrm-identity` |
| 4002 | `patients` | `127.0.0.1` | `odonto_patients` | `odonto_patients` | `odontocrm@patients.service` | `odontocrm-patients` |
| 4003 | `scheduling` | `127.0.0.1` | `odonto_scheduling` | `odonto_scheduling` | `odontocrm@scheduling.service` | `odontocrm-scheduling` |
| 4004 | `notifications` | `127.0.0.1` | `odonto_notifications` | `odonto_notifications` | `odontocrm@notifications.service` | `odontocrm-notifications` |
| 4005 | `clinical` | `127.0.0.1` | `odonto_clinical` | `odonto_clinical` | `odontocrm@clinical.service` | `odontocrm-clinical` |
| 4006 | `odontogram` | `127.0.0.1` | `odonto_odontogram` | `odonto_odontogram` | `odontocrm@odontogram.service` | `odontocrm-odontogram` |
| 4007 | `screens` | `127.0.0.1` | `odonto_screens` | `odonto_screens` | `odontocrm@screens.service` | `odontocrm-screens` |
| 4008 | `reporting` | `127.0.0.1` | `odonto_reporting` | `odonto_reporting` | `odontocrm@reporting.service` | `odontocrm-reporting` |
| 5432 | PostgreSQL 18 | `127.0.0.1` | — | — | `postgresql-18.service` | — |

Los nombres de PM2 son `odontocrm-<servicio>` en las dos plataformas
(`infra/windows/ecosystem.config.cjs` para desarrollo y `infra/fedora/ecosystem.config.cjs`
para producción), así que el mismo comando sirve en Windows y en Fedora:
`pm2 restart odontocrm-clinical`. La variable de entorno del puerto **no** es un `PORT`
genérico: cada servicio lee la suya (`GATEWAY_PORT`, `IDENTITY_PORT`, …; §8.2).

> PENDIENTE FASE 10: (P-08) los nombres de rol ya están confirmados en
> `infra/db/bootstrap.mjs` (el rol se llama **igual que la base**), pero conviene
> reconfirmarlos con `sudo -u postgres psql -c '\du'` en el servidor real y ajustar
> `ROLE_odonto_*` en `/etc/odontocrm/backup.env` si cambiara (§15.2).
>
> PENDIENTE FASE 10: (P-04) el artefacto compilado es `dist/index.js` en todos los
> servicios (`services/<servicio>/dist/index.js` y `apps/gateway/dist/index.js`, según
> `package.json` y `ecosystem.config.cjs`). Confirmarlo con `ls` tras compilar.

### 2.3 Requisitos previos

| Requisito | Valor / comprobación |
| :--- | :--- |
| Fedora | 43 o superior · `cat /etc/fedora-release` |
| Acceso | `root` o un usuario con `sudo` |
| Red | IP **fija** o reserva DHCP + nombre resoluble (`odontocrm.local`) en los equipos cliente |
| Hora | `chrony` activo y zona `America/Caracas` (el plan fija UTC-4 sin DST) |
| Disco | Separar, si es posible, `/var/lib/odontocrm` (radiografías) y `/var/backups/odontocrm` |
| Recursos | 9 procesos Node pequeños + PostgreSQL + Chromium para PDF: se recomienda **4 vCPU / 8 GB RAM / 60 GB SSD** como punto de partida |
| SELinux | `enforcing` (no se desactiva) |
| firewalld | activo, solo el puerto del proxy abierto a la LAN |

> PENDIENTE FASE 10: (P-13) medir el consumo real (RAM/CPU/disco) con la clínica en
> marcha y ajustar la recomendación; decidir cifrado de disco (LUKS) para los datos
> clínicos, que el plan §11 pide para la BD.

---

## 3. Preparación del sistema

```bash
# 1) Sistema al día (primer comando tras instalar Fedora)
sudo dnf upgrade --refresh -y

# 2) Zona horaria fija del proyecto
sudo timedatectl set-timezone America/Caracas
timedatectl                      # comprobar «Time zone: America/Caracas (UTC-04)»

# 3) Nombre del servidor y sincronización de hora
sudo hostnamectl set-hostname odontocrm
sudo systemctl enable --now chronyd
chronyc tracking                 # «Leap status: Normal»

# 4) Que la máquina arranque sin depender de una sesión gráfica
sudo systemctl set-default multi-user.target
```

Añade el nombre al archivo `hosts` del propio servidor (y en tus equipos cliente, o en
el DNS de la clínica):

```bash
echo '127.0.1.1  odontocrm.local odontocrm' | sudo tee -a /etc/hosts
```

> PENDIENTE FASE 10: (P-12) decidir si el certificado interno se emite para
> `odontocrm.local`, para la IP del servidor o para ambos, y cómo se reparte la CA a
> los dispositivos (§13.5).

---

## 4. Paquetes base (dnf)

Instalación manual (equivalente a lo que hace `install.sh`):

```bash
sudo dnf install -y \
  git tar gzip xz zstd rsync curl ca-certificates \
  logrotate chrony firewalld \
  policycoreutils-python-utils setools-console setroubleshoot-server audit \
  postgresql18-server postgresql18-contrib
```

| Paquete | Para qué |
| :--- | :--- |
| `postgresql18-server` | Motor de base de datos (misma versión mayor que desarrollo). |
| `postgresql18-contrib` | Extensiones (`pgcrypto`, `pg_trgm`) y utilidades; `pg_dump`/`pg_restore`. |
| `firewalld` | Cortafuegos: solo el puerto del proxy a la LAN. |
| `policycoreutils-python-utils` | `semanage` y `restorecon` (contextos SELinux) y `audit2why` (leer un rechazo). |
| `setools-console` | `sesearch`, `seinfo`, `sediff`: consultar la política cuando SELinux bloquea algo. |
| `setroubleshoot-server` | `sealert`, que resume en lenguaje llano los rechazos del registro de auditoría. |
| `audit` | `ausearch`: buscar los rechazos AVC en `/var/log/audit/audit.log`. |
| `git` | Clonar el repositorio en `/opt/odontocrm`. |
| `logrotate` | Rotación de `/var/log/odontocrm/*.log`. |
| `chrony` | Hora correcta (afecta a tickets, citas y JWT). |
| `tar`, `gzip`, `xz`, `zstd`, `rsync` | Respaldos, copias externas y compresión. |

> **Ojo con los nombres (corregido en la Fase 10):** esta guía pedía `setools-conftools`, que
> **no existe en Fedora**; el paquete es `setools-console`. Y las herramientas que se le
> atribuían vienen de otro sitio: `sealert` es de `setroubleshoot-server`, `audit2why` de
> `policycoreutils-python-utils` y `ausearch` de `audit`. Si `dnf` se queja de un paquete que
> no encuentra, comprueba el nombre con `dnf provides '*/<comando>'` antes de dar el paso por
> perdido.


### 4.1 Dependencias de Chromium (PDF de récipes, Fase 7)

El PDF A5 con membrete y QR se genera en el servidor con **Playwright/Chromium**, así
que hacen falta las bibliotecas del navegador:

**En Fedora esta es la vía, no el plan B.** Medido en la Fase 10: `install-deps` de
Playwright **no soporta Fedora** —no hay paquete oficial para la distribución, así que
cae a `ubuntu24.04` e intenta `apt-get`, que no existe— y muere con código 127. El
navegador en sí funciona: le faltan estas bibliotecas, que sí están empaquetadas.

```bash
# Conjunto de bibliotecas que necesita Chromium en Fedora 44 (comprobado con ldd):
sudo dnf install -y \
  nss nspr atk at-spi2-atk cups-libs libdrm mesa-libgbm libxshmfence \
  libX11 libXext libXcursor libXi libXtst libXcomposite libXdamage \
  libXfixes libXrandr pango alsa-lib libxkbcommon libxkbcommon-x11 \
  liberation-fonts dejavu-sans-fonts
```

Comprueba que no falte ninguna biblioteca compartida (el navegador se descarga en
§9.5 y vive fuera del `HOME`):

```bash
ldd /var/lib/odontocrm/ms-playwright/chromium-*/chrome-linux/chrome | grep 'not found' || \
  echo 'OK: todas las bibliotecas presentes'
```

### 9.5-bis Dónde tiene que estar el navegador

Playwright busca Chromium en **una de estas dos** rutas, y la que manda es la variable:

1. `PLAYWRIGHT_BROWSERS_PATH` (la que se pone en la configuración): `/var/lib/odontocrm/ms-playwright`.
2. Sin esa variable, la caché del usuario que ejecuta el servicio: con `HOME=/var/lib/odontocrm`
   (que es lo que fija la unidad) sería `/var/lib/odontocrm/.cache/ms-playwright`.

Los servicios que generan PDF son **dos**: `clinical` (récipes A5) y `reporting`
(exportación de reportes). Los dos tienen que llevar la variable; si falta en uno, ese
servicio responde `503 «No se pudo generar el PDF en este momento»` y el resto del
sistema parece estar bien — así se descubrió en la Fase 10. El navegador, además, tiene
que ser **ejecutable por el usuario `odontocrm`** (el directorio es `0750`):

```bash
sudo grep -H PLAYWRIGHT_BROWSERS_PATH /etc/odontocrm/{clinical,reporting}.env
sudo -u odontocrm test -x /var/lib/odontocrm/ms-playwright/chromium-*/chrome-linux/chrome \
  && echo 'el navegador se puede ejecutar'
```

> **P-06 (resuelto en la Fase 10, `fedora:check-ok`):** el comando
> `npx playwright install-deps chromium` **no funciona en Fedora** (cae a `ubuntu24.04`
> y muere en `apt-get`; código 127). La lista
> de arriba es la definitiva: con ella, `ldd` no reporta ninguna biblioteca ausente y
> Chromium genera los PDF. El script `infra/fedora/install.sh` intenta el comando y, si
> falla, instala la lista (por eso el intento queda en el código).
>
> PENDIENTE FASE 10: (P-07) confirmar que Chromium arranca bajo la unidad `systemd`
> endurecida (§10.3) y que puede crear *user namespaces* sin privilegios. Si falla, la
> salida documentada del plan §16 es el PDF con `pdfmake` (sin navegador).

---

## 5. Node.js 26, npm y PM2

### 5.1 Qué canal usar (decisión)

El plan pide **Node.js 26** (§15). Los módulos de `dnf` (`dnf module enable nodejs:26`)
**ya no son el mecanismo de Fedora** para Node: la modularidad se retiró de las
versiones recientes, así que no es una opción fiable. Las alternativas reales son:

| Canal | Ventaja | Inconveniente | Decisión |
| :--- | :--- | :--- | :--- |
| Repositorios de Fedora (`dnf install nodejs`) | Firmado por Fedora, cero configuración extra | Normalmente trae una versión **anterior** a 26 | Solo si ya ofrece 26 |
| **NodeSource** (`rpm.nodesource.com/setup_26.x`) | Versión exacta que exige el plan; incluye npm 11 | Repositorio de terceros: hay que revisar el script de alta | **Elegido por defecto** |
| COPR de la comunidad Node.js (`nodejs/nodejs26`) | Alternativa si NodeSource no tiene 26 | Repositorio de terceros; disponibilidad variable | Alternativa |

`install.sh` implementa las tres rutas (`--node-channel=auto|nodesource|copr|distro`)
y por defecto usa NodeSource, descargando el script a un archivo temporal y mostrando
su `sha256` antes de ejecutarlo (no se canaliza directamente a `bash`).

### 5.2 Instalación

```bash
# Opción elegida: NodeSource
curl -fsSL -o /tmp/nodesource-setup_26.x.sh https://rpm.nodesource.com/setup_26.x
sha256sum /tmp/nodesource-setup_26.x.sh        # anota la suma y revisa el script
less /tmp/nodesource-setup_26.x.sh             # revisión consciente
sudo bash /tmp/nodesource-setup_26.x.sh
sudo dnf install -y nodejs
rm -f /tmp/nodesource-setup_26.x.sh

# Verificación
node --version      # debe empezar por v26.
npm --version       # debe ser 11.x (Node 26 ya no incluye Corepack; el monorepo usa npm)
```

> PENDIENTE FASE 10: (P-02) confirmar que `setup_26.x` existe y qué versión exacta
> entrega; si no existiera, cambiar a `--node-channel=copr` (`dnf copr enable -y
> nodejs/nodejs26`) y anotarlo en §20.

### 5.3 PM2 (global)

```bash
sudo npm install -g pm2
pm2 --version
```

PM2 se usa como **alternativa** al `systemd` nativo (§10.4). El plan acepta ambos
(§1.1, §11); lo importante es que **solo uno** supervise los servicios:

- **`systemd` (recomendado)**: sin demonio extra, logs al journal, endurecimiento por
  unidad, arranque garantizado tras reinicio.
- **PM2**: cómodo si ya lo usas en Windows; requiere `pm2 save` después de cada
  cambio y, para leer los `.env` de `/etc/odontocrm` (corre como `odontocrm`, no como
  root), esos archivos deben quedar en `0640 root:odontocrm` (§10.4).

---

## 6. PostgreSQL 18

### 6.1 Inicializar el clúster y arrancarlo

```bash
sudo postgresql-18-setup --initdb          # crea /var/lib/pgsql/data (solo si no existe)
sudo systemctl enable --now postgresql-18
systemctl status postgresql-18 --no-pager

# Verificación
sudo -u postgres psql -c 'SELECT version();'
pg_isready -h 127.0.0.1 -p 5432
ss -lntp | grep 5432        # debe escuchar SOLO en 127.0.0.1:5432
```

> PENDIENTE FASE 10: (P-09) comprobar la ruta real del socket unix y el contenido por
> defecto de `pg_hba.conf` en Fedora (`/var/lib/pgsql/data/pg_hba.conf`) y ajustar
> `PG_HOST` en `/etc/odontocrm/backup.env` en consecuencia.

### 6.2 Endurecimiento de `postgresql.conf`

Edita `/var/lib/pgsql/data/postgresql.conf` (propietario `postgres`):

```conf
listen_addresses = '127.0.0.1'      # nunca escuchar en la LAN
port = 5432
password_encryption = 'scram-sha-256'
timezone = 'America/Caracas'        # el plan guarda timestamptz; la zona es fija
log_timezone = 'America/Caracas'
log_line_prefix = '%m [%p] %q%u@%d '
log_min_duration_statement = 1000   # consultas lentas (>1 s)
log_connections = on
log_disconnections = on
# Ajustes iniciales para un servidor pequeño (2-5 usuarios + 2 pantallas)
shared_buffers = '1GB'
work_mem = '8MB'
maintenance_work_mem = '128MB'
max_connections = 120               # 9 servicios + pg-boss + psql + respaldos
```

```bash
sudo systemctl restart postgresql-18
```

> PENDIENTE FASE 10: (P-13) estos valores son de partida; ajustarlos tras medir con
> `pg_stat_statements`/`pg_stat_activity` en uso real.

### 6.3 `pg_hba.conf` (quién puede conectarse y cómo)

**Esto no es opcional en Fedora.** Medido en la PC de pruebas (Fase 10): el clúster
que crea `postgresql-setup --initdb` deja las conexiones **TCP en `ident`**, no en
`scram-sha-256` (`select auth_method from pg_hba_file_rules` lo confirma). Con
`ident` y sin servidor de identidad, **ningún servicio puede entrar** por
`127.0.0.1` («la autentificación Ident falló para el usuario …») aunque la
contraseña esté bien. Hay que dejar el archivo así:

```conf
# TYPE      DATABASE        USER            ADDRESS         METHOD
local       all             postgres                        peer
local       all             all                             peer
host        all             all             127.0.0.1/32    scram-sha-256
host        all             all             ::1/128         scram-sha-256
# (ninguna línea para 0.0.0.0/0: PostgreSQL no se expone a la red)
```

Se cambia con dos comandos (el respaldo del original primero, que aquí no se sabe
si hará falta):

```bash
sudo cp /var/lib/pgsql/data/pg_hba.conf /var/lib/pgsql/data/pg_hba.conf.orig
sudo sed -i -E \
  's#^(host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)ident#\1scram-sha-256#' \
  /var/lib/pgsql/data/pg_hba.conf
sudo systemctl reload postgresql

# Verificación (con el usuario que tenga superusuario por peer)
psql "postgres:///postgres?host=/var/run/postgresql" \
  -c "select type, database, user_name, address, auth_method from pg_hba_file_rules"
```

> PENDIENTE FASE 10: si el respaldo se ejecuta como `root` por el socket con
> autenticación `peer`, hay que mapear el usuario del sistema al rol de PostgreSQL
> (`pg_ident.conf` + `map=` en `pg_hba.conf`), o usar el rol de respaldo por TCP con
> `.pgpass`. La opción recomendada es la segunda y está descrita en §15.2.

### 6.4 Crear las 8 bases y sus roles

**No lo hace `install.sh` a propósito** (no debe tocar datos). El camino previsto es el
bootstrap del repositorio (Fase 0: `infra/db/bootstrap.mjs`), que crea las 8 bases, un
rol por servicio **con el mismo nombre que la base** y con privilegios solo sobre ella,
habilita `pgcrypto` y `pg_trgm` y fija la zona horaria de cada base. Es idempotente y
genera las contraseñas aleatorias de cada rol.

```bash
cd /opt/odontocrm
sudo npm run build                 # las migraciones y el bootstrap corren sobre dist/

# Si el clon lo hizo OTRO usuario (p. ej. `git clone` como root de un repositorio
# tuyo, o al revés), git puede negarse a leerlo con «detected dubious ownership» y
# los `git pull` fallan → te quedas en un commit viejo **sin que nadie lo diga**.
# Se arregla declarando el directorio como seguro:
sudo git config --global --add safe.directory /opt/odontocrm
git -C /opt/odontocrm log --oneline -1     # comprueba SIEMPRE qué commit quedó

# El bootstrap lee PG_ADMIN_URL del .env de la RAÍZ del repositorio (nunca se imprime).
# Ese archivo NO se versiona (.gitignore). Créelo solo para el bootstrap:
sudo install -m 0600 -o root -g root /dev/null /opt/odontocrm/.env
sudo tee /opt/odontocrm/.env >/dev/null <<'EOF'
PG_ADMIN_URL=postgres://postgres:CAMBIAR_PASSWORD_DEL_SUPERUSUARIO@127.0.0.1:5432/postgres
NODE_ENV=production
LOG_LEVEL=info
EOF

sudo npm run db:bootstrap          # crea lo que falte (no borra nada)
sudo npm run db:bootstrap -- --only identity     # un solo servicio
sudo npm run db:bootstrap -- --rotate            # cambia contraseñas (¡reinicie después!)
```

**Alternativa sin contraseña de superusuario (la más cómoda en Fedora).** El clúster
que crea `postgresql-setup --initdb` usa autenticación **`peer`** en el socket local:
el usuario del sistema entra como el rol que se llame igual. Se le da superusuario a
tu usuario y el bootstrap entra por el socket, sin escribir ninguna contraseña en
ningún archivo:

```bash
# OJO: dentro de un script con sudo, $USER es root: usa tu usuario de verdad.
sudo -u postgres createuser --superuser "$USER"

sudo tee /opt/odontocrm/.env >/dev/null <<'EOF'
PG_ADMIN_URL=postgres:///postgres?host=/var/run/postgresql
NODE_ENV=production
LOG_LEVEL=info
EOF
```

Con esta forma, las URLs que genera el bootstrap para los servicios siguen siendo
**TCP a 127.0.0.1** con la contraseña aleatoria de cada rol: el socket solo lo usa el
administrador. Es el camino probado en la PC Fedora de pruebas (Fase 10).

> Nota de seguridad: el bootstrap también usa `/opt/odontocrm/.env` (o el `.env` de la
> raíz) solo para leer `PG_ADMIN_URL`; cuando termines puedes **borrarlo**
> (`sudo shred -u /opt/odontocrm/.env`). Las contraseñas de cada rol quedan en
> `services/<servicio>/.env` **dentro del repo** (ignorados por Git): en producción hay
> que **trasladarlas a `/etc/odontocrm/<servicio>.env` y borrar esos `.env`** — es el
> paso obligatorio de §8.6, y al final `find /opt/odontocrm -name .env` debe salir vacío.

Verificación:

```bash
sudo -u postgres psql -c '\l'      # deben aparecer las 8 bases
sudo -u postgres psql -c '\du'     # deben aparecer los 8 roles con el nombre de su base
```

Si prefieres el equivalente a mano (referencia, no es necesario si usas el bootstrap):

```sql
-- Como superusuario (sudo -u postgres psql)
CREATE ROLE odonto_identity LOGIN PASSWORD 'CAMBIAR_password_larga_y_aleatoria';
CREATE DATABASE odonto_identity OWNER odonto_identity;
\connect odonto_identity
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
REVOKE ALL ON DATABASE odonto_identity FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE odonto_identity TO odonto_identity;
```

Repite para `odonto_patients`, `odonto_scheduling`, `odonto_notifications`,
`odonto_clinical`, `odonto_odontogram`, `odonto_screens`, `odonto_reporting`.

> PENDIENTE FASE 10: (P-05) confirmar en el servidor el flujo exacto
> `PG_ADMIN_URL` → `npm run db:bootstrap` → `npm run db:migrate`, y anotar quién
> conserva el `.env` de la raíz (o si se elimina tras el bootstrap).

---

## 7. Usuario de sistema y layout de directorios

### 7.1 Usuario `odontocrm`

Sin shell de login, sin `sudo`, sin contraseña. `HOME` apunta a `/var/lib/odontocrm`
(escribible por el servicio: Chromium y las cachés de Node necesitan un `HOME` con
permiso de escritura, y `/opt` queda de solo lectura por el endurecimiento de §10.3).

```bash
sudo useradd --system --create-home --home-dir /var/lib/odontocrm \
  --shell /usr/sbin/nologin --comment 'OdontoCRM · servicios Node (sin login)' \
  --user-group odontocrm

getent passwd odontocrm
# odontocrm:x:...:/var/lib/odontocrm:/usr/sbin/nologin
```

### 7.2 Directorios, propietario y permisos

| Ruta | Propietario | Modo | Contenido |
| :--- | :--- | :--- | :--- |
| `/opt/odontocrm` | `root:root` | `0755` | Código del repositorio (compilado). Legible por el proxy para servir la SPA. |
| `/var/lib/odontocrm` | `odontocrm:odontocrm` | `0750` | `HOME` del usuario, datos y cachés. |
| `/var/lib/odontocrm/storage` | `odontocrm:odontocrm` | `0750` | Radiografías, adjuntos y PDFs de récipes (Fase 7). |
| `/var/lib/odontocrm/ms-playwright` | `odontocrm:odontocrm` | `0750` | Navegador Chromium de Playwright (fuera del `HOME`). |
| `/var/lib/odontocrm/tmp` | `odontocrm:odontocrm` | `0750` | Temporales de trabajo. |
| `/var/log/odontocrm` | `odontocrm:odontocrm` | `0750` | `backup.log`, `restore.log`, logs en archivo. |
| `/etc/odontocrm` | `root:odontocrm` | `0750` | Configuración. **Directorio atravesable** por el servicio para leer las claves (§8.4) y, si el supervisor es PM2, también los `.env` (§10.4). |
| `/etc/odontocrm/odontocrm.env` y `/etc/odontocrm/<servicio>.env` | `root:root` | `0600` | Variables y secretos: el archivo **común** y el **propio** de cada servicio (§8.1). Los lee `systemd` como root. Con PM2 pasan a `0640 root:odontocrm` (§10.4). |
| `/etc/odontocrm/keys` | `root:odontocrm` | `0750` | Claves EdDSA de firma de JWT (las lee el servicio). |
| `/var/backups/odontocrm` | `root:root` | `0700` | Respaldos (`pg_dump` + config + storage). |

```bash
sudo install -d -m 0755 -o root -g root /opt/odontocrm
sudo install -d -m 0750 -o odontocrm -g odontocrm /var/lib/odontocrm{,/storage,/ms-playwright,/tmp}
sudo install -d -m 0750 -o odontocrm -g odontocrm /var/log/odontocrm
sudo install -d -m 0750 -o root -g odontocrm /etc/odontocrm{,/keys}
sudo install -d -m 0700 -o root -g root /var/backups/odontocrm

# Verificación de permisos
ls -ld /opt/odontocrm /var/lib/odontocrm /var/lib/odontocrm/storage \
       /var/log/odontocrm /etc/odontocrm /var/backups/odontocrm
sudo find /etc/odontocrm -maxdepth 1 -name '*.env' -printf '%m %u:%g %p\n'
```

> **¿Por qué `0600 root:root` en los `.env` y el servicio igual funciona?**
> Porque `systemd` (que corre como root) abre los archivos indicados en los dos
> `EnvironmentFile=` y le pasa las variables al proceso. El servicio **no lee** los
> archivos, así que no necesita permiso sobre ellos (plan §11).
>
> **Excepción (PM2):** PM2 no es root: arranca `node` como `odontocrm` y los lee con
> `--env-file-if-exists` (§10.4). Si eliges PM2 como supervisor, los `.env` deben ser
> `0640 root:odontocrm` (el directorio ya es `0750 root:odontocrm`, así que el grupo
> puede atravesarlo y leerlos):
>
> ```bash
> sudo chown root:odontocrm /etc/odontocrm/*.env && sudo chmod 0640 /etc/odontocrm/*.env
> ```
>
> Es un intercambio consciente: el grupo `odontocrm` (el usuario con el que corren los
> servicios) puede leer **todos** los `.env`, no solo el suyo. Con systemd no hace
> falta y se mantiene `0600 root:root`.

---

## 8. Variables de entorno y secretos

### 8.1 Plantillas: DOS archivos de entorno por servicio (común + propio)

El arranque real del proyecto carga **dos** archivos de entorno, y en producción se
reproduce exactamente esa separación:

| En desarrollo (en el repositorio) | En producción (Fedora) | Qué lleva |
| :--- | :--- | :--- |
| `.env` en la raíz del repo | `/etc/odontocrm/odontocrm.env` | **Común** a los 9 servicios: `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY`, `TZ`, `SERVICE_VERSION`, `TEST_MODE`, todos los `<SERVICIO>_PORT` y `<SERVICIO>_HOST`, todas las `*_URL` y `WEB_ORIGIN`. |
| `services/<servicio>/.env` (`apps/gateway/.env` en el gateway) | `/etc/odontocrm/<servicio>.env` | **Propio** del servicio: `DATABASE_URL`, `INTERNAL_SERVICE_SECRET` y las suyas (`COOKIE_SECRET` en `identity`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_BOT_USERNAME` en `notifications`…). |

Es la misma pareja de archivos que usa el arranque de desarrollo (`package.json` →
`start:<servicio>`), solo que con rutas absolutas:

```bash
# Desarrollo (Windows o Linux, desde la raíz del repo)
node --env-file-if-exists=.env --env-file-if-exists=services/identity/.env \
     services/identity/dist/index.js

# Fedora con systemd (§10.2): dos EnvironmentFile= EN ESE ORDEN
EnvironmentFile=/etc/odontocrm/odontocrm.env    # común
EnvironmentFile=/etc/odontocrm/identity.env     # propio
```

`install.sh --apply` genera **las dos plantillas** para los 9 servicios (10 archivos
`.env` en total, más `backup.env` y `.pgpass`), **sin secretos reales**: cada valor
pendiente lleva el marcador `CAMBIAR_*`. Nunca sobrescribe un archivo existente.

```bash
sudo ./infra/fedora/install.sh --dry-run     # ver qué haría (no cambia nada)
sudo ./infra/fedora/install.sh --apply       # crear usuario, directorios y plantillas
sudo ls -l /etc/odontocrm/                   # odontocrm.env + <servicio>.env
sudo grep -c CAMBIAR /etc/odontocrm/*.env    # valores por reemplazar
```

Los nombres de las variables están tomados del **contrato real del código de la Fase 0**
(`packages/kernel/src/config.ts`, `services/identity/src/config.ts`,
`apps/gateway/src/config.ts`, `.env.example` e `infra/db/bootstrap.mjs`).

> PENDIENTE FASE 10: (P-03) los servicios de las Fases 2-9 todavía no existen, así que
> sus variables propias (`services/<servicio>/src/config.ts`) se irán añadiendo; al
> cerrar cada fase, actualiza la plantilla de `install.sh` **y** este documento en el
> mismo commit. Antes de la puesta en marcha, comprueba que cada servicio arranca sin
> `ConfigError` (el kernel falla rápido si falta una variable obligatoria).

### 8.2 Variables: archivo común y archivos propios

**`/etc/odontocrm/odontocrm.env` — común a los 9 servicios** (equivale al `.env` de la
raíz del repositorio):

| Variable | Valor en producción | Notas |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | `baseEnvSchema`. Desactiva el modo test y los seeds (plan §12). |
| `LOG_LEVEL` | `info` | `baseEnvSchema` (en desarrollo es `debug`). |
| `LOG_PRETTY` | `false` | Sin colores: los logs van al journal. |
| `TZ` | `America/Caracas` | Zona fija del proyecto (plan §16). |
| `SERVICE_VERSION` | `0.1.0` | Informativa; aparece en logs y `/health`. |
| `TEST_MODE`, `ALLOW_TEST_MODE` | `false` y `false` | El plan §12 usa `ALLOW_TEST_MODE` y `.env.example` usa `TEST_MODE`; en producción **nunca** `true`. |
| `GATEWAY_PORT` | `8090` | **No existe una variable `PORT` genérica**: cada servicio lee la suya (`<SERVICIO>_PORT`). |
| `IDENTITY_PORT` … `REPORTING_PORT` | `4001` … `4008` | Una por servicio, en el orden de §2.2. |
| `<SERVICIO>_HOST` | `127.0.0.1` | Los 9 escuchan **solo** en loopback (plan §11). |
| `IDENTITY_URL` … `REPORTING_URL` | `http://127.0.0.1:400x` | URLs internas que usa el gateway para el proxy por recurso; una URL **vacía** significa «ese servicio todavía no existe». |
| `WEB_ORIGIN` | `https://odontocrm.local, https://192.168.1.50` | CORS del gateway: el origen con el que se abre la SPA. Admite **varios separados por comas** —pon el nombre **y** la IP, que son las dos formas en que entra un equipo de la clínica—; con uno solo, entrar por el otro da un error de CORS y la pantalla queda en blanco. |

Nombres exactos de los puertos (los del código y los de §2.2):

| Servicio | Variable | Valor |
| :--- | :--- | ---: |
| `gateway` | `GATEWAY_PORT` | 8090 |
| `identity` | `IDENTITY_PORT` | 4001 |
| `patients` | `PATIENTS_PORT` | 4002 |
| `scheduling` | `SCHEDULING_PORT` | 4003 |
| `notifications` | `NOTIFICATIONS_PORT` | 4004 |
| `clinical` | `CLINICAL_PORT` | 4005 |
| `odontogram` | `ODONTOGRAM_PORT` | 4006 |
| `screens` | `SCREENS_PORT` | 4007 |
| `reporting` | `REPORTING_PORT` | 4008 |

> **¿Por qué el gateway usa 8090 y no 8080?** Porque en Windows (máquina de desarrollo)
> el 8080 lo ocupa el servicio de red del host (`hns`/Hyper-V) y `listen` falla con
> `EACCES`; el valor por defecto del código y de `.env.example` es `8090`
> (`apps/gateway/src/config.ts`). En Fedora no hay tal conflicto, pero se mantiene 8090
> para que desarrollo y producción sean idénticos. Si prefieres 8080, cámbialo **en los
> tres sitios**: `/etc/odontocrm/odontocrm.env`, el `proxy_pass` del reverse proxy
> (§13.3/§13.4) y las comprobaciones de §17.

**`/etc/odontocrm/<servicio>.env` — propio de cada servicio** (equivale a
`services/<servicio>/.env`):

| Variable | Servicios | Notas |
| :--- | :--- | :--- |
| `DATABASE_URL` | los 8 con BD | `postgres://<rol>:<clave>@127.0.0.1:5432/<base>`; la genera `npm run db:bootstrap` y se traslada aquí (§8.6). |
| **`EVENTS_DATABASE_URL`** | los 8 con BD | **La cola compartida** (`odonto_events`): **el mismo valor en los ocho**, con el rol `odonto_events`. Sin ella cada servicio usaría **su propia base** para `pg-boss` y los eventos no llegarían a los demás (el read model de reportes se queda vacío y la auditoría no ve nada). La escribe el bootstrap en `services/<servicio>/.env` y se traslada aquí (§8.6). |
| `DATABASE_POOL_MAX` | los 8 con BD | Conexiones por servicio (valor por defecto del código: 10). |
| `INTERNAL_SERVICE_SECRET` | los 9 | Secreto HS256 de los JWT de servicio. **El mismo valor en los 9.** |
| `COOKIE_SECRET` | `identity` | Secreto de cookies; lo genera el bootstrap. |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` | `identity` | Claves EdDSA (§8.4). |
| `COOKIE_SECURE=true` | `identity` | Exige HTTPS: es la razón del TLS interno (§13). |
| `STORAGE_DRIVER`, `STORAGE_ROOT` | `patients`, `clinical` | `local` + `/var/lib/odontocrm/storage` (abstracción S3-ready). |
| `PLAYWRIGHT_BROWSERS_PATH` | `clinical` | `/var/lib/odontocrm/ms-playwright`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MODE=auto` | `notifications` | Token de BotFather, entregado por archivo (nunca por chat ni en el repo). El modo es **`auto` \| `real` \| `simulado`** (el modo test fuerza `simulado`); el *long polling* es el transporte, no un modo: `polling` **no** es un valor válido y el servicio no arranca con él. |

**Regla de precedencia:** si una variable aparece en los dos archivos, gana la del
archivo **propio** (es el segundo `--env-file-if-exists` / el segundo
`EnvironmentFile=`). No dupliques variables comunes dentro del archivo propio.

### 8.3 Generar los valores

```bash
# Secretos compartidos y contraseñas de base (48 bytes → base64)
openssl rand -base64 48

# Ejemplo: fijar el mismo secreto interno en los 9 archivos
SECRETO="$(openssl rand -base64 48)"
for f in /etc/odontocrm/{gateway,identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.env; do
  sudo sed -i "s|^INTERNAL_SERVICE_SECRET=.*|INTERNAL_SERVICE_SECRET=${SECRETO}|" "$f"
done
sudo chmod 0600 /etc/odontocrm/*.env && sudo chown root:root /etc/odontocrm/*.env
```

### 8.4 Claves de firma EdDSA (servicio `identity`)

```bash
sudo openssl genpkey -algorithm ED25519 -out /etc/odontocrm/keys/jwt-private.pem
sudo openssl pkey -in /etc/odontocrm/keys/jwt-private.pem \
     -pubout -out /etc/odontocrm/keys/jwt-public.pem

# Estas claves SÍ las lee el servicio (no pasan por EnvironmentFile):
sudo chown root:odontocrm /etc/odontocrm/keys/jwt-*.pem
sudo chmod 0640 /etc/odontocrm/keys/jwt-private.pem
sudo chmod 0644 /etc/odontocrm/keys/jwt-public.pem
```

Guarda una copia de `jwt-private.pem` en el respaldo de configuración
(`odontocrm-backup.sh --include-config`): sin ella no se pueden validar los tokens
emitidos, y los usuarios tendrían que volver a iniciar sesión.

### 8.5 Rotación del token del bot de Telegram

El token lo entrega BotFather **por archivo**, nunca por chat (plan §16). Rotarlo es
editar `TELEGRAM_BOT_TOKEN` en `/etc/odontocrm/notifications.env` y reiniciar el
servicio:

```bash
sudo systemctl restart odontocrm@notifications.service   # o: pm2 restart odontocrm-notifications
sudo journalctl -u odontocrm@notifications -n 50 --no-pager
```

> PENDIENTE FASE 10: (P-19) documentar la rotación de la clave de firma JWT
> (procedimiento con doble clave pública) y la revisión de secretos con
> `tools/check-secrets.mjs` antes de cada commit.

### 8.6 Trasladar los secretos del bootstrap a `/etc/odontocrm` (paso obligatorio)

`npm run db:bootstrap` (§6.4) crea las 8 bases y sus roles y **escribe las credenciales
generadas** (contraseña aleatoria de 32 bytes por rol, más `INTERNAL_SERVICE_SECRET` y
el `COOKIE_SECRET` de `identity`) en los `.env` **dentro del repositorio**
(`services/<servicio>/.env`; ver `infra/db/bootstrap.mjs`). Esos archivos están
ignorados por Git y son el mecanismo normal en desarrollo, pero **en producción no
deben quedarse ahí**: el código de `/opt/odontocrm` es de solo lectura para el servicio
y los secretos viven únicamente en `/etc/odontocrm` (plan §11).

Se hace **una sola vez**, después del bootstrap y antes de arrancar los servicios:

```bash
cd /opt/odontocrm

# 1) Trasladar SOLO los valores generados al archivo propio de producción y borrar el
#    .env del repositorio. El resto de la plantilla (URLs, claves, rutas) ya está puesto.
#    OJO: EVENTS_DATABASE_URL va incluida —es la cola compartida y sin ella los
#    servicios no se ven entre sí—.
for s in identity patients scheduling notifications clinical odontogram screens reporting; do
  src="services/$s/.env"; dst="/etc/odontocrm/$s.env"
  [ -f "$src" ] || { echo "AVISO: todavía no existe $src (¿ejecutaste db:bootstrap?)"; continue; }
  sudo bash -c "
    set -euo pipefail
    grep -vE '^(DATABASE_URL|EVENTS_DATABASE_URL|INTERNAL_SERVICE_SECRET|COOKIE_SECRET)=' '$dst' > '$dst.tmp'
    grep -E  '^(DATABASE_URL|EVENTS_DATABASE_URL|INTERNAL_SERVICE_SECRET|COOKIE_SECRET)=' '$src' >> '$dst.tmp'
    install -m 0640 -o root -g odontocrm '$dst.tmp' '$dst'
    rm -f '$dst.tmp' '$src'
  "
done

# 2) El gateway no tiene base de datos: comparte el INTERNAL_SERVICE_SECRET de identity.
sudo bash -c 'v="$(sed -n "s/^INTERNAL_SERVICE_SECRET=//p" /etc/odontocrm/identity.env)"
  sed -i "s|^INTERNAL_SERVICE_SECRET=.*|INTERNAL_SERVICE_SECRET=${v}|" /etc/odontocrm/gateway.env'

# 3) Permisos. El `install -m 0640 -o root -g odontocrm` deja los archivos legibles por
#    el grupo odontocrm: solo hace falta si el supervisor es PM2 (§10.4). Con systemd,
#    endurece a la política del plan §11 (0600 root:root):
sudo chown root:root /etc/odontocrm/*.env && sudo chmod 0600 /etc/odontocrm/*.env

# 4) Comprobación: NINGÚN .env dentro del código desplegado
sudo find /opt/odontocrm -type f -name '.env' -not -path '*/node_modules/*'
#    → debe salir vacío (`.env.example` es del repositorio y no contiene secretos).

# 5) Comprobación: los ocho tienen la cola compartida (el mismo valor en todos)
sudo grep -c '^EVENTS_DATABASE_URL=' /etc/odontocrm/{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.env
#    → un 1 por archivo; si falta en alguno, ese servicio no verá los eventos de los demás
```

Notas:

- El bootstrap conserva las contraseñas ya generadas si vuelve a ejecutarse, así que
  repetirlo no invalida lo que ya está en `/etc/odontocrm`; pero **volverá a crear los
  `.env` del repositorio**: repite el paso 4 (o borra los `.env` a mano) después.
- Si eliges el supervisor PM2, los `.env` deben quedar en `0640 root:odontocrm`
  (paso 3 omitido) porque PM2 corre como `odontocrm` y los lee con
  `--env-file-if-exists` (§10.4). Con systemd el proceso **no** los lee: se los inyecta
  systemd como root.
- Las migraciones (§9.3) son la única tarea que necesita encontrar esos valores dentro
  del árbol del código; la sección indica cómo hacerlo sin dejar ningún `.env` ahí.

---

## 9. Despliegue del código y compilación

### 9.1 Traer el código a `/opt/odontocrm`

```bash
sudo git clone <URL_DEL_REPOSITORIO> /opt/odontocrm
cd /opt/odontocrm
sudo git checkout fase-9          # etiqueta de la última fase cerrada (plan §14)
sudo git log --oneline -1
sudo chown -R root:root /opt/odontocrm
sudo chmod -R go-w /opt/odontocrm      # el código no se modifica en producción
```

### 9.2 Instalar dependencias y compilar

```bash
cd /opt/odontocrm
sudo npm ci                            # monorepo npm workspaces (no pnpm, no yarn)
sudo npm run build                     # compila los 9 servicios y la SPA
sudo npm run verify                    # typecheck + lint + test (opcional en el servidor)
```

- El código se compila como root y queda con propietario `root:root` (`0755`): el
  usuario `odontocrm` solo necesita **leer**.
- Si quieres reducir superficie, tras compilar puedes ejecutar
  `sudo npm prune --omit=dev` para dejar solo dependencias de ejecución.
- No hay secretos en el repositorio: las credenciales viven en `/etc/odontocrm`
  (plan §11) y se trasladan ahí desde el bootstrap (§8.6). Al terminar el despliegue
  **no debe quedar ningún `.env`** dentro de `/opt/odontocrm`.

### 9.3 Migraciones

`npm run db:migrate` (Fase 0: `tools/migrate-all.mjs`) recorre todos los servicios
implementados y ejecuta `services/<servicio>/dist/db/migrate.js` **leyendo los `.env`
del repositorio** (`--env-file-if-exists=.env` y
`--env-file-if-exists=services/<servicio>/.env`) desde la raíz del monorepo. En
producción los secretos viven en `/etc/odontocrm`, así que hay dos formas de que el
migrador los encuentre — y **ninguna deja `.env` dentro de `/opt/odontocrm` al
terminar** (§8.6):

**Opción A — enlaces simbólicos temporales (no duplica secretos):**

```bash
cd /opt/odontocrm
# El .env de la raíz son las variables COMUNES (§8.1); el de cada servicio, las suyas.
sudo ln -sfn /etc/odontocrm/odontocrm.env /opt/odontocrm/.env
for s in identity patients scheduling notifications clinical odontogram screens reporting; do
  sudo ln -sfn "/etc/odontocrm/$s.env" "/opt/odontocrm/services/$s/.env"
done

sudo npm run db:migrate                 # todos los servicios implementados
sudo npm run db:migrate -- --only identity

# ... y se retiran EN CUANTO terminen: en el árbol del código no debe quedar ningún .env
sudo rm -f /opt/odontocrm/.env /opt/odontocrm/services/*/.env
sudo find /opt/odontocrm -type f -name '.env' -not -path '*/node_modules/*'   # vacío
```

**Opción B — inyectar el entorno a mano** (sin tocar el árbol del código):

```bash
cd /opt/odontocrm
# Las variables del entorno tienen prioridad sobre los --env-file-if-exists, y esos
# archivos no existen en producción: no hace falta crearlos.
sudo bash -c 'set -a; source /etc/odontocrm/odontocrm.env; source /etc/odontocrm/identity.env; set +a; \
  npm run db:migrate -- --only identity'
```

> PENDIENTE FASE 10: (P-05) decidir y fijar **una** de las dos opciones y comprobar que
> `npm run db:migrate` funciona con las credenciales de `/etc/odontocrm` (hoy el
> migrador está pensado para los `.env` de desarrollo; el `.env` del gateway no lo usa
> ninguna migración, así que no se enlaza). Antes de migrar en producción:
> **respaldo reciente verificado** (§15).

### 9.4 Servir la SPA

La SPA compilada (`apps/web/dist`) la sirve el reverse proxy. Hay dos variantes
(§13.3): apuntar el proxy a `/opt/odontocrm/apps/web/dist` con la etiqueta SELinux
adecuada, o publicar una copia en `/var/www/odontocrm`.

```bash
ls -l /opt/odontocrm/apps/web/dist/index.html      # debe existir
sudo chmod -R a+rX /opt/odontocrm/apps/web/dist
```

> PENDIENTE FASE 10: (P-17) decidir la variante definitiva y dejarla fijada aquí.

### 9.5 Chromium para los récipes A5 (Fase 7)

El navegador se descarga **una vez**, en la ruta que el servicio tiene permitida
(§10.3) y con el `HOME` del usuario `odontocrm`:

```bash
sudo -u odontocrm env HOME=/var/lib/odontocrm \
  PLAYWRIGHT_BROWSERS_PATH=/var/lib/odontocrm/ms-playwright \
  npx playwright install chromium

sudo chown -R odontocrm:odontocrm /var/lib/odontocrm/ms-playwright
ls /var/lib/odontocrm/ms-playwright
```

Prueba de humo (genera un PDF con membrete y luego bórralo):

```bash
sudo -u odontocrm env HOME=/var/lib/odontocrm \
  PLAYWRIGHT_BROWSERS_PATH=/var/lib/odontocrm/ms-playwright \
  node -e "console.log(require('playwright').chromium.executablePath())"
```

> PENDIENTE FASE 10: (P-07) el navegador debe poder crear *user namespaces*. No añadas
> `RestrictNamespaces=true` ni `MemoryDenyWriteExecute=true` a las unidades (§10.3).
> Si Chromium no arranca bajo el endurecimiento, documenta aquí la excepción y su
> justificación.

---

## 10. Arranque y supervisión: systemd (recomendado) o PM2

### 10.1 Regla de oro

**Un solo supervisor.** Si habilitas PM2 con `pm2 startup` *y* las unidades
`odontocrm@*.service`, ambos intentarán enlazar los mismos puertos y verás
`EADDRINUSE` en los logs. Elige uno:

| Criterio | `systemd` (recomendado) | PM2 |
| :--- | :--- | :--- |
| Arranque tras reinicio | `systemctl enable` (nativo) | `pm2 startup` + `pm2 save` |
| Logs | journald (`journalctl -u`) | `pm2 logs` (+ archivos) |
| Endurecimiento por servicio | Sí (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths`) | No |
| Lectura de `/etc/odontocrm/odontocrm.env` y `<servicio>.env` (`0600 root:root`) | Sí (root los inyecta) | Sí, si se ponen en `0640 root:odontocrm` (§10.4) |
| Procesos extra | Ninguno | Demonio de PM2 |

**Y una sola pila.** No basta con elegir un supervisor: si la máquina tiene además una
pila de desarrollo (`npm run dev`, `stack:dev`) en los mismos puertos, los dos conjuntos
de procesos se pelean por ellos y el diagnóstico se vuelve **mentiroso** —los servicios
de `systemd` quedan en `failed` por `EADDRINUSE` mientras `/health` responde 200, porque
lo contesta la otra pila—. Pasó en el banco de pruebas de la Fase 10. Antes de arrancar:
`ss -lntp` sobre los puertos de la pila y `npm run stack:status`; si hay algo,
`npm run stack:down` (§10.2).

### 10.2 Instalar las unidades `systemd`

```bash
cd /opt/odontocrm
sudo install -m 0644 -o root -g root infra/fedora/systemd/odontocrm@.service /etc/systemd/system/
sudo install -m 0644 -o root -g root infra/fedora/systemd/odontocrm-gateway.service /etc/systemd/system/
# Observabilidad (Fase 10): alertas cada 5 minutos (§10.6)
sudo install -m 0644 -o root -g root infra/fedora/systemd/odontocrm-alertas.service /etc/systemd/system/
sudo install -m 0644 -o root -g root infra/fedora/systemd/odontocrm-alertas.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/odontocrm@.service \
                            /etc/systemd/system/odontocrm-gateway.service \
                            /etc/systemd/system/odontocrm-alertas.service
```

Las unidades cargan **los dos archivos de entorno** en el mismo orden que
`node --env-file-if-exists` en desarrollo (§8.1); `odontocrm@<servicio>` resuelve `%i`:

```ini
# odontocrm@.service  →  odontocrm@identity.service
EnvironmentFile=/etc/odontocrm/odontocrm.env    # común a los 9
EnvironmentFile=/etc/odontocrm/%i.env           # propio del servicio
ExecStart=/usr/bin/node /opt/odontocrm/services/%i/dist/index.js

# odontocrm-gateway.service
EnvironmentFile=/etc/odontocrm/odontocrm.env
EnvironmentFile=/etc/odontocrm/gateway.env
ExecStart=/usr/bin/node /opt/odontocrm/apps/gateway/dist/index.js
```

Comprobación rápida de que las variables llegan al proceso (no imprime secretos):

```bash
sudo systemctl show odontocrm@identity -p EnvironmentFiles
sudo systemctl show odontocrm-gateway -p EnvironmentFiles
```

**Antes de arrancar: comprueba que los puertos están libres.** Si en la máquina
quedó una pila de desarrollo (`npm run dev`, `stack:dev`) —o cualquier proceso suelto—
los servicios de `systemd` entran en bucle con `EADDRINUSE`, agotan el límite de
arranques y quedan en `failed`… **mientras `/health` responde 200**: lo responde la
otra pila, y el operador cree que todo está bien. Pasó en el banco de pruebas de la
Fase 10 y es el escenario que evita el [ADR 0037](../../docs/adr/0037-una-sola-pila-a-la-vez.md).

```bash
# ¿Hay algo escuchando en los puertos de la pila? (debe salir vacío)
ss -lntp | grep -E ':(4001|4002|4003|4004|4005|4006|4007|4008|8090)\b'
# En una máquina que también se usa para desarrollar:
cd /opt/odontocrm && npm run stack:status      # quién corre y desde cuándo
npm run stack:down                             # si hay una pila de desarrollo, se para
```

Arranque en orden (primero la base de datos, luego los servicios, el gateway al final):

```bash
sudo systemctl enable --now postgresql-18
sudo systemctl enable --now \
  odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service
sudo systemctl enable --now odontocrm-gateway.service

systemctl --no-pager --type=service 'odontocrm*' | cat
systemctl status odontocrm@identity --no-pager
```

**Y comprueba que quien escucha es la unidad**, no otro proceso: el `/health` en 200 no
lo garantiza. Para el ejemplo de `identity` (repite cambiando servicio y puerto):

```bash
unidad=odontocrm@identity; puerto=4001
systemctl is-active "$unidad"
[[ "$(ss -lntpH "sport = :$puerto" | grep -oP 'pid=\K[0-9]+' | head -1)" \
   == "$(systemctl show -p MainPID --value "$unidad")" ]] \
  && echo "el $puerto lo sirve $unidad" || echo "¡el $puerto lo sirve OTRO proceso!"
```

Si alguno quedó en `failed`: `journalctl -u odontocrm@<servicio> -n 50 --no-pager`. Con
`EADDRINUSE` al principio del registro, la causa es la pila de más.

Operación diaria:

```bash
sudo systemctl restart odontocrm@clinical.service     # reiniciar un servicio
sudo systemctl stop odontocrm@{identity,patients}.service   # detener varios
sudo systemctl disable --now odontocrm@reporting.service    # sacar de circulación
journalctl -u odontocrm@clinical -f                   # logs en vivo
journalctl -u 'odontocrm@*' --since today --no-pager | tail -50
```

### 10.3 Endurecimiento de las unidades (qué hace y qué no tocar)

Las unidades incluyen: `NoNewPrivileges=true`, `ProtectSystem=strict`,
`ProtectHome=true`, `PrivateTmp=true`, `ProtectKernel*`, `ProtectControlGroups`,
`RestrictSUIDSGID=true`, `LockPersonality=true`, `CapabilityBoundingSet=` vacío y
`ReadWritePaths=/var/lib/odontocrm /var/log/odontocrm`.

Consecuencias prácticas:

- `ProtectSystem=strict` deja **todo** el sistema de archivos de solo lectura salvo
  `/dev`, `/proc`, `/sys` y lo listado en `ReadWritePaths`. Si un servicio intenta
  escribir fuera de esas rutas, falla con `EROFS`/`EACCES`.
- `ProtectHome=true` hace inaccesibles `/home`, `/root` y `/run/user`. Por eso no
  pongas datos ahí (el plan §11 lo prohíbe para secretos).
- `PrivateTmp=true` da un `/tmp` privado a cada servicio. **Consecuencia:** la conexión
  a PostgreSQL debe ser por **TCP a `127.0.0.1:5432`** (como está configurado), no por
  el socket unix en `/tmp`.
- **No añadas** `MemoryDenyWriteExecute=true` (rompe el JIT de V8/Node) ni
  `RestrictNamespaces=true` (rompe el *sandbox* de Chromium en `clinical`).

Errores típicos al arrancar:

| Síntoma en `systemctl status` | Causa | Solución |
| :--- | :--- | :--- |
| `status=203/EXEC` | `ExecStart` no existe o no es ejecutable | Compilar (§9.2) y revisar la ruta `dist/index.js` (P-04) |
| `status=200/CHDIR` | `WorkingDirectory` inexistente | Comprobar que `/opt/odontocrm` existe y es legible |
| `status=226/NAMESPACE` | El endurecimiento impide una operación | Revisar `ReadWritePaths`; no relajar `ProtectSystem` sin motivo |
| El proceso muere al escribir en `$HOME` | `HOME` fuera de `ReadWritePaths` | Añadir la ruta a `ReadWritePaths` o usar `/var/lib/odontocrm` |
| `EnvironmentFile=... No such file` | Falta `odontocrm.env` o `<servicio>.env` | `install.sh --apply` (§8.1) y luego rellenar secretos (§8.6) |
| `ConfigError: Configuración inválida …` en el journal | Falta una variable obligatoria (`DATABASE_URL`, `IDENTITY_URL`, …) | El kernel falla rápido a propósito: completa `/etc/odontocrm/<servicio>.env` |
| El proceso muere al escribir en `logs/` o `.keys/` | Ruta relativa a la raíz del repo (solo lectura) | Usar rutas absolutas en las variables (p. ej. `STORAGE_ROOT`) |

### 10.4 Alternativa con PM2

El repositorio trae **dos** configuraciones de PM2, una por plataforma:

| Archivo | Para qué | Rutas |
| :--- | :--- | :--- |
| `infra/windows/ecosystem.config.cjs` | Desarrollo en Windows (`pm2 start infra/windows/ecosystem.config.cjs` desde la raíz del repo) | Relativas al repositorio |
| **`infra/fedora/ecosystem.config.cjs`** | **Producción en Fedora** | **Absolutas**: `/opt/odontocrm/...`, `/etc/odontocrm/...`, `/var/log/odontocrm/...` |

`infra/fedora/ecosystem.config.cjs` define cada proceso con `name: odontocrm-<servicio>`,
`cwd: /opt/odontocrm`, el punto de entrada compilado
(`/opt/odontocrm/services/<servicio>/dist/index.js` y
`/opt/odontocrm/apps/gateway/dist/index.js`) y **los dos archivos de entorno**, igual que
las unidades `systemd`:

```js
node_args: [
  '--env-file-if-exists=/etc/odontocrm/odontocrm.env',  // común
  '--env-file-if-exists=/etc/odontocrm/identity.env',   // propio del servicio
],
```

```bash
cd /opt/odontocrm
sudo -u odontocrm env HOME=/var/lib/odontocrm PM2_HOME=/var/lib/odontocrm/.pm2 \
  pm2 start infra/fedora/ecosystem.config.cjs   # arranca los procesos definidos
sudo -u odontocrm env HOME=/var/lib/odontocrm PM2_HOME=/var/lib/odontocrm/.pm2 \
  pm2 save                                      # fija la lista para el reinicio
pm2 ls
pm2 logs odontocrm-clinical --lines 50
pm2 restart odontocrm-gateway
sudo pm2 startup systemd -u odontocrm --hp /var/lib/odontocrm   # arranque automático
systemctl status pm2-odontocrm --no-pager
```

**Permisos:** PM2 corre como `odontocrm` (no como root), así que para leer los `.env` con
`--env-file-if-exists` necesita que sean legibles por su grupo:

```bash
# Solo si el supervisor es PM2 (con systemd se mantiene 0600 root:root, §7.2)
sudo chown root:odontocrm /etc/odontocrm/*.env && sudo chmod 0640 /etc/odontocrm/*.env
```

No hace falta duplicar secretos en `/var/lib/odontocrm/env/`: es **el mismo par de
archivos** que lee systemd, con el permiso relajado al grupo (intercambio consciente,
§7.2). Si eliges PM2, **no** habilites las unidades `odontocrm@*.service` ni
`odontocrm-gateway.service`: **un solo supervisor** (§10.1).

> PENDIENTE FASE 10: (P-10) confirmar en el Fedora real que `pm2 start
> infra/fedora/ecosystem.config.cjs` levanta los servicios con los dos
> `--env-file-if-exists` (y sin `EADDRINUSE`), que `pm2 startup` + `pm2 save` los
> devuelve tras reiniciar, y que `pm2 logs` no filtra secretos. Hoy el archivo solo
> declara `gateway` e `identity` (los únicos servicios compilados); los demás se añaden
> al cerrar su fase.

Para deshacer el arranque automático de PM2:

```bash
pm2 unstartup systemd        # o: sudo systemctl disable --now pm2-odontocrm
```

### 10.5 Prueba de reinicio (criterio de aceptación de la Fase 10)

```bash
sudo systemctl reboot
# Al volver:
systemctl --no-pager --type=service 'odontocrm*' | cat     # todos «running»
curl -fsS http://127.0.0.1:8090/health                     # gateway OK
npm run estado                                             # tablero: los 9 en verde
```

> PENDIENTE FASE 10: (P-16) ejecutar esta prueba y anotar fecha y resultado en §20.
> Es un criterio de aceptación explícito («tras reiniciar la máquina los 9 servicios
> vuelven solos», plan §13 Fase 10).

### 10.6 Observabilidad: tablero, alertas y rotación de logs

Tres piezas, ninguna nueva que instalar:

**1. El tablero de estado** (`npm run estado`, Fase 10). Una foto de todo lo que
puede caerse en silencio: los 9 servicios con su `/health` y su `/ready` (con el
detalle del chequeo que falla), las 9 bases con su tamaño y conexiones, la cola de
eventos por cola (pendientes, fallidos, completados), el outbox de cada servicio
(eventos sin publicar y con reintentos) y los envíos atascados de notificaciones.

```bash
cd /opt/odontocrm
npm run estado                      # una foto
npm run estado -- --sin-servicios   # sin preguntar por HTTP (pila parada)
npm run estado -- --json            # para una máquina
```

En producción lee los entornos de `/etc/odontocrm` (con `ODONTOCRM_ENV_DIR`, que la
unidad de alertas ya pone) y **no necesita `PG_ADMIN_URL`**: cada rol de servicio
informa del tamaño de su propia base. Por eso puede correr sin superusuario de base
de datos.

**2. Las alertas** (`odontocrm-alertas.timer`): el mismo tablero en modo
`--alertas`, cada cinco minutos. No imprime nada y sale con 0 cuando todo está bien;
si algo falla, sale con 1 y el servicio queda en estado `failed`:

```bash
sudo install -m 0644 -o root -g root \
  infra/fedora/systemd/odontocrm-alertas.service \
  infra/fedora/systemd/odontocrm-alertas.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now odontocrm-alertas.timer

systemctl list-timers odontocrm-alertas.timer      # cuándo toca la próxima
systemctl status odontocrm-alertas.service         # cómo fue la última
journalctl -u odontocrm-alertas -n 50 --no-pager   # el detalle del problema
systemctl --failed                                 # aquí aparece si algo va mal
```

Qué vigila, con sus umbrales (ajustables por entorno en la unidad):
`ESTADO_OUTBOX_MINUTOS` (5) eventos sin publicar, `ESTADO_COLA_MINUTOS` (10) cola
con pendientes viejos, `ESTADO_ENVIO_MINUTOS` (15) envíos atascados y
`ESTADO_DISCO_LIBRE` (10 %) de disco libre.

> Si quieres que además avise por fuera (correo, Telegram del administrador), añade
> `OnFailure=` a la unidad apuntando a tu notificador. No se incluye uno propio a
> propósito: el sistema no debe depender de un servicio de mensajería para avisar
> de que está caído.

**3. La rotación de los logs.** Con `systemd` los servicios escriben al **journal**,
que ya rota solo; los archivos de `/var/log/odontocrm` (`backup.log`, `restore.log`
y, si eliges PM2, sus logs) los rota `logrotate` con la configuración del repositorio
—diario, 30 días, comprimido— que `install.sh --apply` deja en
`/etc/logrotate.d/odontocrm`:

```bash
sudo install -m 0644 -o root -g root infra/fedora/logrotate/odontocrm /etc/logrotate.d/odontocrm
sudo logrotate --debug /etc/logrotate.d/odontocrm      # comprobar sin rotar
sudo journalctl --disk-usage                           # el journal, por su lado
```

> PENDIENTE FASE 10: (P-27) validar en el Fedora real que las alertas saltan de
> verdad (parar un servicio y ver el `failed`), que el tablero funciona con los
> entornos de `/etc/odontocrm` y que `logrotate --debug` no se queja.

---

## 11. Red: firewalld

Solo se abre **el puerto del reverse proxy** (443) a la LAN. Nada más: ni 8090, ni
4001-4008, ni 5432.

```bash
sudo systemctl enable --now firewalld
sudo firewall-cmd --get-default-zone                 # normalmente «public»
sudo firewall-cmd --list-all

# Abrir 443/tcp SOLO a la red de la clínica (ajusta el CIDR a tu LAN)
sudo firewall-cmd --permanent --add-rich-rule=\
'rule family="ipv4" source address="192.168.1.0/24" port port="443" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all                          # verificación
```

Comprobaciones (deben fallar desde otro equipo de la LAN):

```bash
# En el servidor: confirmar que los servicios solo escuchan en loopback
ss -lntp | grep -E ':(4001|4002|4003|4004|4005|4006|4007|4008|8090|5432)\b'

# Desde un equipo de la LAN (debe dar «connection refused» o agotar el tiempo):
curl -m 5 http://<IP_DEL_SERVIDOR>:8090/health
curl -m 5 http://<IP_DEL_SERVIDOR>:5432
```

> PENDIENTE FASE 10: (P-20) ejecutar las dos comprobaciones desde un equipo de la LAN y
> registrar la evidencia en §20.

---

## 12. SELinux

**SELinux no se desactiva** en producción. Si algo falla, se diagnostica y se etiqueta.

```bash
getenforce                 # debe decir Enforcing
sudo dnf install -y policycoreutils-python-utils setools-console setroubleshoot-server audit
```

### 12.1 Contextos necesarios

| Ruta | Tipo SELinux | Por qué |
| :--- | :--- | :--- |
| `/opt/odontocrm/apps/web/dist` | `httpd_sys_content_t` | El reverse proxy (dominio `httpd_t`) sirve la SPA: sin esta etiqueta no puede leerla desde `/opt` (tipo `usr_t`). |
| `/var/lib/odontocrm/storage` | `httpd_sys_content_t` **solo si** el proxy sirve archivos directamente | El plan §11 sirve los adjuntos por endpoint autorizado, así que **por defecto no se etiqueta**. |
| `/etc/odontocrm/keys` | `etc_t` (por defecto) | Lo lee el servicio `identity` (proceso sin confinar). |
| `/var/lib/odontocrm`, `/var/log/odontocrm` | `var_lib_t` / `var_log_t` (por defecto) | Los servicios corren sin confinar y respetan los permisos DAC. |

```bash
# SPA legible por el proxy
sudo semanage fcontext -a -t httpd_sys_content_t '/opt/odontocrm/apps/web/dist(/.*)?'
sudo restorecon -Rv /opt/odontocrm/apps/web/dist

# Solo si el proxy sirve archivos de storage directamente (no es el diseño actual):
# sudo semanage fcontext -a -t httpd_sys_content_t '/var/lib/odontocrm/storage(/.*)?'
# sudo restorecon -Rv /var/lib/odontocrm/storage

sudo semanage fcontext -l | grep odontocrm      # verificación
```

### 12.2 Booleanos necesarios

```bash
# El proxy debe poder conectarse a 127.0.0.1:8090
sudo setsebool -P httpd_can_network_connect on
getsebool httpd_can_network_connect             # httpd_can_network_connect --> on
```

- `httpd_can_network_connect_db` **no** hace falta: el proxy no habla con PostgreSQL.
- Si en el futuro los servicios Node se ejecutan bajo una política SELinux que los
  confine (no es el caso hoy: corren como `unconfined_service_t`), habrá que añadir
  permisos para escribir en `/var/lib/odontocrm/storage`.

### 12.3 Diagnóstico

```bash
sudo ausearch -m avc -ts recent | audit2why
sudo sealert -a /var/log/audit/audit.log | head -50
```

Último recurso (documentar el motivo y volver a `enforcing` cuanto antes):

```bash
sudo semanage permissive -a <dominio>      # p. ej. httpd_t — deja de bloquear, no desactiva SELinux
```

> PENDIENTE FASE 10: (P-11) y (P-22) confirmar los contextos y booleanos exactos con el
> proxy realmente elegido (nginx o Caddy) y con PM2 si se usa ese supervisor; verificar
> que Chromium funciona con SELinux en `Enforcing`.

---

## 13. TLS interno y reverse proxy

### 13.1 Por qué es obligatorio

El plan §11 usa **cookies `Secure`** (`COOKIE_SECURE=true`) para el refresh token; los
navegadores solo las aceptan por HTTPS. Por eso, aunque todo esté en la LAN, el acceso
va por HTTPS con un certificado propio.

### 13.2 Certificado interno

**Opción A — Caddy (`tls internal`)**, la más simple: Caddy crea su propia CA y emite
el certificado del sitio.

**Opción B — nginx + `mkcert` o certificado propio**:

```bash
sudo dnf install -y mkcert nss-tools
sudo mkcert -install                                   # crea la CA local del servidor
sudo mkcert -key-file /etc/pki/tls/private/odontocrm.key \
            -cert-file /etc/pki/tls/certs/odontocrm.crt \
            odontocrm.local <IP_DEL_SERVIDOR> localhost
sudo chmod 0600 /etc/pki/tls/private/odontocrm.key
sudo chown root:root /etc/pki/tls/private/odontocrm.key
```

El certificado debe incluir **el nombre Y la IP** que teclean los equipos, o los
navegadores mostrarán aviso.

> PENDIENTE FASE 10: (P-12) confirmar `mkcert`/`openssl` en el Fedora usado, la ruta
> final del par de claves y el procedimiento para instalar la CA raíz en cada PC,
> tablet y TV. Algunos navegadores de Smart TV no permiten importar una CA: si es el
> caso, la alternativa es un dominio real con certificado Let's Encrypt vía DNS-01
> (documentar aparte).

### 13.3 nginx

El archivo está **versionado** en el repositorio:
[`infra/fedora/nginx/odontocrm.conf`](nginx/odontocrm.conf). Se instala tal cual y solo
se sustituye `__HOST__` por el nombre **y la IP** del servidor (el certificado cubre
los dos). Así la guía y lo que corre en la clínica no se separan.

```bash
# Un solo comando: desactiva la página de prueba de Fedora, instala el proxy con
# el nombre y la IP de esta máquina, comprueba la sintaxis y arranca nginx.
sudo bash /opt/odontocrm/infra/fedora/nginx/instalar.sh
# (o con el nombre que teclean los equipos:)
sudo bash /opt/odontocrm/infra/fedora/nginx/instalar.sh --host="odontocrm.local 192.168.1.50"
```

> **Ojo con el puerto 80 (medido en la Fase 10).** Fedora no pone su página de prueba
> en `conf.d/default.conf` sino **dentro de `/etc/nginx/nginx.conf`**, con
> `listen 80 default_server`. Mientras esté ahí, quien escriba `http://` ve el cartel
> «Test Page for the HTTP Server on Fedora» y el redirect a HTTPS nunca ocurre (el
> `curl` final devuelve **200** en vez de 301). El instalador comenta esas dos líneas
> `listen` —el bloque queda inerte y el cambio se revierte a la vista— y guarda el
> original en `/etc/nginx/nginx.conf.odontocrm-orig`.

Lo que hace (y por qué), tal como quedó validado en la Fase 10:

```nginx
server {
    listen 443 ssl;
    server_name odontocrm.local;

    ssl_certificate     /etc/pki/tls/certs/odontocrm.crt;
    ssl_certificate_key /etc/pki/tls/private/odontocrm.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    # SPA compilada (ver §9.4 y la etiqueta SELinux de §12.1)
    root  /opt/odontocrm/apps/web/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API a través del gateway
    location /api/ {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # SSE de las pantallas (sala de espera / consultorio): sin búfer
    location /api/v1/screens/ {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   Connection "";
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
        add_header         X-Accel-Buffering no;
    }
}
```

```bash
sudo nginx -t && sudo systemctl enable --now nginx
```

> **P-11 (resuelto en la Fase 10):** la ruta del SSE es
> `/api/v1/screens/<pantalla>/stream` (`services/screens/src/routes/screen-routes.ts` y
> `apps/web/src/lib/kiosko.ts`). La `location` correcta es esa; si algún día cambia,
> se ajusta en el archivo versionado.

### 13.3-bis Quitar el aviso de certificado en los demás equipos

El navegador de la tablet, el móvil o el televisor avisa «conexión no privada» porque
el certificado lo firma la **CA interna** del servidor (`mkcert`), que solo está
instalada en el propio servidor. Se quita instalando esa CA en cada equipo, **una sola
vez**:

```bash
sudo odontocrm certificado                 # estado del certificado y de la CA
sudo odontocrm certificado --exportar /tmp/ca   # deja los archivos para copiar
```

El atajo que hace esto cómodo: el proxy **sirve la CA en `http://<servidor>/ca.crt`**
(también por HTTP, a propósito: un equipo que todavía no confía en el certificado no
puede descargarla por HTTPS sin pelearse antes con el aviso). Desde el propio equipo:

1. Abrir `http://192.168.1.50/ca.crt` (la IP del servidor) y aceptar la descarga.
2. Instalarla como **autoridad de certificación**:
   - **Android**: Ajustes → Seguridad → Cifrado y credenciales → Instalar certificado → CA.
   - **iPhone/iPad**: descargar → Ajustes → General → VPN y gestión de dispositivos →
     instalar el perfil → **y activar la confianza** en Ajustes → General → Información →
     Ajustes de confianza de certificados.
   - **Windows**: doble clic al `.crt` → Instalar → Equipo local → Entidades de
     certificación raíz de confianza.
   - **Mac**: abrir el `.pem` en el Llavero «Sistema» → Confiar siempre.
3. Cerrar y volver a abrir el navegador: el candado sale normal y la pantalla deja de
   preguntar.

**Si un televisor no permite instalar una CA** (pasa en muchos Smart TV), hay dos
salidas honestas: ponerle un mini-PC o una tablet a la pantalla, o usar un dominio real
con certificado de Let's Encrypt por DNS-01 (§13.2). Lo que **no** se hace nunca es
desactivar la validación del servidor «para que funcione»: eso quita la protección justo
donde circulan los datos clínicos, y en una red compartida cualquiera podría suplantar al
servidor.

> **Guarda la CA en el respaldo.** `install.sh` la copia a
> `/etc/odontocrm/keys/odontocrm-ca.crt`, que entra en el respaldo de configuración
> (`--include-config`). Si se pierde, hay que emitir certificados nuevos **y volver a
> instalar la CA en todos los equipos**.

### 13.4 Caddy (ejemplo)

```caddyfile
# /etc/caddy/Caddyfile
odontocrm.local {
    tls internal

    root * /opt/odontocrm/apps/web/dist
    encode gzip

    @api path /api/*
    reverse_proxy @api 127.0.0.1:8090 {
        flush_interval -1              # imprescindible para SSE
        header_up X-Real-IP {remote_host}
    }

    try_files {path} /index.html
    file_server
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
# CA raíz interna de Caddy (para copiarla a los dispositivos):
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

### 13.5 Verificación del TLS

```bash
# Certificado servido y cadena
openssl s_client -connect odontocrm.local:443 -servername odontocrm.local </dev/null 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName

# Respuesta por HTTPS y redirección a la SPA
curl -sS -o /dev/null -w '%{http_code}\n' https://odontocrm.local/
curl -sS -o /dev/null -w '%{http_code}\n' https://odontocrm.local/api/v1/health

# La cookie de refresh debe salir con Secure (tras iniciar sesión)
curl -sS -D - -o /dev/null https://odontocrm.local/api/v1/auth/login | grep -i 'set-cookie'
```

> PENDIENTE FASE 10: (P-11) validar que el SSE atraviesa el proxy sin acumular retardo
> (pantalla de sala actualizándose en vivo) y que las cookies `Secure` funcionan en los
> navegadores de la clínica.

---

## 14. Tailscale (acceso remoto futuro)

El sistema **nunca** se expone a internet (plan §1.21): el acceso remoto será por una
VPN mesh, y Tailscale es la opción prevista.

```bash
# Alta del repositorio oficial de Tailscale
sudo dnf config-manager addrepo --from-repofile=https://pkgs.tailscale.com/stable/fedora/tailscale.repo
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled

# Unir el servidor al tailnet (autenticación interactiva por navegador)
sudo tailscale up
tailscale status
tailscale ip -4
```

Reglas de seguridad:

- **No** metas `tailscale0` en la zona `trusted` sin pensar: eso daría acceso a
  *todos* los puertos locales (8090, 4001-4008, 5432) a cualquier dispositivo del
  tailnet. Lo correcto es permitir **solo 443** desde el rango del tailnet
  (`100.64.0.0/10`) y afinar con las ACL del tailnet.
- Desactiva la caducidad de la clave del servidor en la consola de Tailscale (si no,
  el servidor se desconecta solo cada ~180 días).
- Como alternativa al certificado interno, `tailscale cert odontocrm.<tailnet>.ts.net`
  emite un certificado válido públicamente (requiere HTTPS activado en el tailnet).

```bash
# Solo el proxy accesible desde el tailnet
sudo firewall-cmd --permanent --add-rich-rule=\
'rule family="ipv4" source address="100.64.0.0/10" port port="443" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

> PENDIENTE FASE 10: (P-23) Tailscale es opcional y no bloquea la puesta en marcha
> local. Confirmar el nombre del repositorio para el Fedora usado, el diseño de ACL y
> si se usará `tailscale cert` en lugar de la CA interna.

---

## 15. Respaldos

Plan §11: **`pg_dump` diario por base, retención de 30 días y restauración probada.**

### 15.1 Qué se respalda

| Contenido | Cómo | Dónde |
| :--- | :--- | :--- |
| Las 8 bases | `pg_dump --format=custom` por base | `/var/backups/odontocrm/AAAA-MM-DD/<base>_<fecha>.dump` |
| Integridad | `pg_restore --list` + `sha256sum` | `SHA256SUMS` y `manifest.txt` en el mismo directorio |
| `/etc/odontocrm` (incluye **secretos**) | `--include-config` → `tar.gz` | `etc-odontocrm_<fecha>.tar.gz` (0600) |
| `/var/lib/odontocrm/storage` (radiografías y PDFs) | `--include-storage` → `tar.gz` | `storage_<fecha>.tar.gz` |
| Registro | log a archivo y a stdout | `/var/log/odontocrm/backup.log` |

### 15.2 Rol de respaldo

**Un solo comando** (hace todo lo de abajo y comprueba que el rol lea de verdad las
ocho bases; la contraseña la genera él y **no la imprime**):

```bash
sudo bash /opt/odontocrm/infra/fedora/backup/crear-rol-respaldo.sh
#   --rotar        cambia la contraseña
#   --password=…   si prefieres elegirla tú
#   --bypassrls    solo si algún día se activa Row Level Security
```

Lo que deja hecho (equivalente a mano, por si hay que revisarlo):

```sql
-- Como superusuario: sudo -u postgres psql
-- OJO: SIN `NOINHERIT` (ver el aviso de abajo).
CREATE ROLE odonto_backup LOGIN PASSWORD 'CAMBIAR_password_larga_y_aleatoria'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT pg_read_all_data TO odonto_backup WITH INHERIT TRUE;   -- leer todo

-- Por cada base (repite las 8), y dentro de cada base, por cada esquema:
GRANT CONNECT ON DATABASE odonto_identity TO odonto_backup;
GRANT USAGE ON SCHEMA public, drizzle, pgboss TO odonto_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle, pgboss TO odonto_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle, pgboss TO odonto_backup;
```

> **`NOINHERIT` rompe el respaldo (medido en la Fase 10).** Con
> `CREATE ROLE … NOINHERIT`, PostgreSQL 16+ registra la pertenencia a
> `pg_read_all_data` con `inherit_option = false`, así que el rol **no recibe** esos
> permisos y `pg_dump` muere con «permiso denegado a la tabla `__drizzle_migrations`».
> Además, `pg_read_all_data` **no** da `USAGE` en los esquemas que no son `public`:
> hay que concederlo (y la lectura de tablas y secuencias) esquema por esquema, como
> arriba. El script `crear-rol-respaldo.sh` ya lo hace así y **comprueba** leyendo
> `drizzle.__drizzle_migrations` y `pgboss.job`, que son justo las dos tablas que
> `pg_dump` bloquea al empezar. Si el respaldo falla con «permiso denegado al esquema»
> o «a la tabla», es esto.

> **P-18 (resuelto en la Fase 10):** el esquema **no usa Row Level Security** —ninguna
> migración crea políticas—, así que `BYPASSRLS` **no hace falta** y el respaldo trae
> todas las filas con `pg_read_all_data`. Si algún día se activa RLS, hay que añadirlo
> (`--bypassrls`) **y volver a hacer la prueba de restauración** (§16).

> **P-14 (resuelto en la Fase 10):** el respaldo escribe un `.dump` por base con
> `SHA256SUMS` y un `manifest.json`; la copia a un medio externo se hace con `rsync`
> (§15.5) y **el archivo se custodia fuera del servidor**. Lo que **no** está resuelto
> todavía es el cifrado (`age`/`gpg`): hasta que se decida, el medio externo tiene que
> ir cifrado por el sistema de archivos (por ejemplo, un disco con LUKS).

Ajusta `/etc/odontocrm/backup.env` y `/etc/odontocrm/.pgpass`:

```conf
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=odonto_backup
PGPASSFILE=/etc/odontocrm/.pgpass
BACKUP_DIR=/var/backups/odontocrm
RETENTION_DAYS=30
DATABASES="odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting"
```

```bash
sudo chmod 0600 /etc/odontocrm/backup.env /etc/odontocrm/.pgpass
sudo chown root:root /etc/odontocrm/backup.env /etc/odontocrm/.pgpass
```

**Opción alternativa (peer por socket):** ejecutar el respaldo con `sudo -u postgres`
y `PG_HOST=/var/run/postgresql`; requiere que el directorio de respaldos sea escribible
por `postgres` y mapear el usuario del sistema en `pg_ident.conf`. Es más frágil: usa
la opción recomendada.

### 15.3 Ejecución manual

```bash
# Simulación: no escribe nada
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --dry-run

# Respaldo real (bases + configuración con secretos)
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --include-config

# Respaldo completo, incluido el almacenamiento de radiografías
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --include-config --include-storage

# Una sola base, con otra retención
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --db odonto_identity --retention 60
```

Códigos de salida: `0` correcto · `1` configuración · `2` falló un volcado ·
`3` falló la verificación · `4` falló una copia opcional · `5` falló la retención.

### 15.4 Automatización diaria (temporizador `systemd`)

Un respaldo que nadie ejecuta no es un respaldo: las unidades vienen **en el
repositorio** (`infra/fedora/systemd/odontocrm-backup.service` y `.timer`) y
`install.sh --apply` las instala junto al resto. Hacen el respaldo **cada día a las
03:30** hora local, con `Persistent=true` (si el servidor estaba apagado a esa hora,
lo hace al arrancar: un corte de luz no se lleva el respaldo del día).

```bash
sudo systemctl enable --now odontocrm-backup.timer
systemctl list-timers odontocrm-backup.timer
sudo systemctl start odontocrm-backup.service      # forzar una corrida ahora
sudo journalctl -u odontocrm-backup -n 40 --no-pager
```

```bash
sudo chmod +x /opt/odontocrm/infra/fedora/backup/odontocrm-*.sh
sudo systemctl daemon-reload
sudo systemctl enable --now odontocrm-backup.timer
systemctl list-timers odontocrm-backup.timer
sudo systemctl start odontocrm-backup.service      # forzar una corrida ahora
journalctl -u odontocrm-backup -n 40 --no-pager
tail -20 /var/log/odontocrm/backup.log
```

Alternativa con cron (una línea en `/etc/cron.d/odontocrm-backup`):

```cron
30 3 * * * root /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --include-config >> /var/log/odontocrm/backup-cron.log 2>&1
```

### 15.5 Rotación de logs y journal

Crea `/etc/logrotate.d/odontocrm`:

```
/var/log/odontocrm/*.log {
    weekly
    rotate 12
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

```bash
sudo logrotate --debug /etc/logrotate.d/odontocrm
# Journal persistente entre reinicios (útil para auditar incidentes):
sudo sed -i 's/^#\?Storage=.*/Storage=persistent/' /etc/systemd/journald.conf
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=1G/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

### 15.6 Copia externa y protección

Los respaldos contienen **datos clínicos** y (con `--include-config`) **secretos**:

```bash
# Copia a otro equipo de la LAN o del tailnet (ajusta destino y usuario)
sudo rsync -a --delete /var/backups/odontocrm/ usuario@otro-equipo:/respaldos/odontocrm/
```

> PENDIENTE FASE 10: (P-14) decidir el cifrado en reposo (por ejemplo `age` o `gpg`)
> para la copia externa y automatizarla; hoy el script **no** cifra. Registrar también
> el RTO/RPO esperado tras medir un respaldo y una restauración reales.

---

## 16. Restauración y prueba de restauración

Herramienta: [`backup/odontocrm-restore.sh`](backup/odontocrm-restore.sh). Por cada
base: valida el volcado, lo restaura **primero en una base temporal**
(`<base>__verif`) y solo si eso funciona toca la base definitiva.

### 16.1 Uso

```bash
# Ver qué respaldos hay (y si su cabecera es válida)
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh --list

# Simulación: explica exactamente qué haría
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
     --from /var/backups/odontocrm/2026-10-02 --all --dry-run

# PRUEBA no destructiva: deja la base temporal como evidencia
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
     --from /var/backups/odontocrm/2026-10-02 --db odonto_identity \
     --keep-verify-db --yes

# Restauración REAL de una base, conservando la anterior
sudo systemctl stop odontocrm@identity.service
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
     --from /var/backups/odontocrm/2026-10-02 --db odonto_identity --keep-old --yes
sudo systemctl start odontocrm@identity.service
```

Sin `--yes` el script **no toca nada** (termina con código `10` y te muestra el plan).
Códigos de salida: `0` correcto · `1` configuración · `2` respaldo inválido ·
`3` falló la verificación (la base real no se tocó) · `4` falló la restauración ·
`5` falló la comprobación posterior · `10` falta `--yes`.

> **Importante:** detén los servicios de la base que vas a restaurar. Si hay conexiones
> abiertas, PostgreSQL no permite renombrar la base y el script lo advertirá.

### 16.2 Prueba de restauración documentada (criterio de aceptación de la Fase 10)

Secuencia exacta a ejecutar y registrar:

```bash
# 0-a) Credenciales: el respaldo lee, pero RESTAURAR necesita además un rol con
#      permiso para DROP/CREATE DATABASE. El script deja las dos cosas en el .pgpass.
sudo bash /opt/odontocrm/infra/fedora/backup/crear-rol-respaldo.sh --admin-role="$USER"

# 0-b) Respaldar AHORA (para tener un respaldo fresco y verificable)
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --include-config
FECHA=$(date +%Y-%m-%d)

# 1) Datos de referencia en la base real (para poder comparar)
sudo -u postgres psql -d odonto_identity -tAc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema');"

# 2) Restauración de prueba en la base temporal (no toca la real)
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
     --from /var/backups/odontocrm/$FECHA --db odonto_identity \
     --keep-verify-db --yes

# 3) Comprobar la base temporal (mismo número de tablas y datos legibles)
sudo -u postgres psql -d odonto_identity__verif -c '\dt'
sudo -u postgres psql -d odonto_identity__verif -tAc 'SELECT count(*) FROM usuarios;'

# 4) Evidencia y limpieza
ls -l /var/log/odontocrm/restore_*.log
sudo -u postgres psql -c 'DROP DATABASE "odonto_identity__verif" WITH (FORCE);'
```

Qué se considera **aprobado**: la restauración de prueba termina con código `0`, el
número de tablas coincide con el origen, las tablas pertenecen al rol del servicio
(`owned == tables`) y una consulta de datos devuelve filas coherentes.

Registra el resultado en §20 (y, si algo falla, la causa y la corrección).

> **Nota medida en la Fase 10: ninguna herramienta de este despliegue pregunta
> contraseñas.** `psql`, `pg_dump` y `pg_restore` corren siempre con `-w` /
> `--no-password`: si falta una credencial, **fallan en el acto** diciendo cuál falta.
> Antes no era así y el restablecimiento se quedó mudo un minuto y medio esperando que
> alguien tecleara la contraseña del rol `postgres` (que en Fedora entra por *peer* y no
> tiene contraseña útil por TCP). Si alguna vez ves un `Password for user postgres:` en
> la clínica, es que se está ejecutando una copia vieja: comprueba con
> `git -C /opt/odontocrm log --oneline -1`. El paso 0-a deja la credencial de
> administración en el `.pgpass` y evita el problema de raíz.
>
> **P-15 (resuelto en la Fase 10):** la prueba se corre con las **8 bases** de una vez
> (`--all --keep-verify-db`), se comparan las filas de cada tabla entre la base real y
> la restaurada, y las `__verif` **se conservan** como evidencia hasta completar el
> registro de §20.2 (para retirarlas después: `--limpiar-verif --yes`).

### 16.3 Restaurar la configuración y el almacenamiento

```bash
# Configuración y secretos (¡contiene credenciales!)
sudo tar -tzf /var/backups/odontocrm/$FECHA/etc-odontocrm_*.tar.gz | head
sudo cp -a /etc/odontocrm /etc/odontocrm.antes_de_restaurar
sudo tar -xzf /var/backups/odontocrm/$FECHA/etc-odontocrm_*.tar.gz -C /etc
sudo chown -R root:odontocrm /etc/odontocrm && sudo chmod 0750 /etc/odontocrm
sudo chmod 0600 /etc/odontocrm/*.env && sudo chown root:root /etc/odontocrm/*.env

# Almacenamiento (radiografías y PDFs)
sudo tar -xzf /var/backups/odontocrm/$FECHA/storage_*.tar.gz -C /var/lib/odontocrm/storage
sudo chown -R odontocrm:odontocrm /var/lib/odontocrm/storage
```

### 16.4 Después de restaurar

1. Si el respaldo es de un esquema **anterior** al código desplegado, aplica las
   migraciones (§9.3) — el script de restauración no las ejecuta.
2. Reinicia los servicios afectados y verifica `/health` (§17).
3. Si usaste `--keep-old`, elimina `<base>__antes_de_restaurar_<fecha>` cuando todo
   esté validado:

```sql
DROP DATABASE "odonto_identity__antes_de_restaurar_2026-10-02_033000" WITH (FORCE);
```

---

## 17. Verificación final y lista de comprobación

### 17.1 Comprobación de los 9 servicios con `curl`

```bash
cat >/tmp/verificar-odontocrm.sh <<'EOF'
#!/usr/bin/env bash
set -u
declare -A PORTS=(
  [identity]=4001 [patients]=4002 [scheduling]=4003 [notifications]=4004
  [clinical]=4005 [odontogram]=4006 [screens]=4007 [reporting]=4008
  [gateway]=8090
)
fallos=0
for svc in identity patients scheduling notifications clinical odontogram screens reporting gateway; do
  p="${PORTS[$svc]}"
  # Un /health 200 no basta: hay que comprobar que quien escucha es la UNIDAD de
  # systemd y no otro proceso (una pila de desarrollo en los mismos puertos contesta
  # 200 y los servicios quedan en failed por EADDRINUSE: pasó en el banco de pruebas).
  unidad="odontocrm@${svc}"; [[ "$svc" == "gateway" ]] && unidad="odontocrm-gateway"
  activa="$(systemctl is-active "${unidad}.service" 2>/dev/null || true)"
  pid_unidad="$(systemctl show -p MainPID --value "${unidad}.service" 2>/dev/null || echo 0)"
  pid_puerto="$(ss -lntpH "sport = :${p}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)"
  if [[ "$activa" != "active" ]]; then
    printf '  FALLA %-14s :%-5s unidad %s\n' "$svc" "$p" "$activa"
    (( fallos++ ))
  elif [[ "$pid_puerto" != "$pid_unidad" ]]; then
    printf '  FALLA %-14s :%-5s lo sirve el PID %s, no %s (PID %s)\n' "$svc" "$p" "${pid_puerto:-nadie}" "$unidad" "$pid_unidad"
    (( fallos++ ))
  fi
  for ruta in health ready; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${p}/${ruta}" || echo 000)"
    if [[ "$code" == "200" ]]; then
      printf '  OK   %-14s :%-5s /%s\n' "$svc" "$p" "$ruta"
    else
      printf '  FALLA %-14s :%-5s /%s  (código %s)\n' "$svc" "$p" "$ruta" "$code"
      (( fallos++ ))
    fi
  done
done
printf '\nFallos: %d\n' "$fallos"
exit $(( fallos > 0 ))
EOF
sudo install -m 0755 -o root -g root /tmp/verificar-odontocrm.sh /usr/local/bin/verificar-odontocrm
/usr/local/bin/verificar-odontocrm
```

> Desde la Fase 10 esto también está en el comando del servidor:
> `sudo odontocrm verificar` (lo instala `install.sh` en `/usr/local/bin/odontocrm`,
> junto con `estado`, `alertas`, `respaldar`, `restaurar`, `servicios`, `logs`,
> `actualizar` y `modo-test`). El script de aquí abajo queda como referencia de lo que
> hace por dentro.
>
> El verificador comprueba **tres** cosas por servicio: que la unidad esté `active`, que
> el puerto lo sirva **su** proceso (`MainPID`) y que `/health` y `/ready` respondan 200.
> La primera versión solo miraba el `curl` y daba verde con la pila equivocada escuchando
> (banco de pruebas, Fase 10). `sudo npm run estado` hace estas mismas
> comprobaciones cada cinco minutos en producción (`odontocrm-alertas.timer`), y
> **necesita `sudo`**: los entornos son `0600 root:root`, así que sin él la cola, el
> outbox y los envíos quedan «no comprobables» (el tablero lo avisa en vez de
> inventarse problemas).

### 17.2 Comprobaciones de infraestructura

```bash
# PostgreSQL
pg_isready -h 127.0.0.1 -p 5432
sudo -u postgres psql -tAc 'SELECT version();'
sudo -u postgres psql -tAc '\l' | grep odonto_

# Puertos: los servicios SOLO en loopback
ss -lntp | grep -E ':(4001|4002|4003|4004|4005|4006|4007|4008|8090|5432)\b'

# Servicios y timers
systemctl --no-pager --type=service 'odontocrm*' | cat
systemctl list-timers odontocrm-backup.timer odontocrm-alertas.timer

# Tablero de estado (los 9 servicios, las bases, la cola y el outbox)
cd /opt/odontocrm
npm run estado

# Alertas: sin salida y con código 0 significa «todo bien»
npm run estado -- --alertas; echo "código: $?"
systemctl --failed

# Reverse proxy y TLS
curl -sS -o /dev/null -w 'SPA: %{http_code}\n' https://odontocrm.local/
curl -sS -o /dev/null -w 'API: %{http_code}\n' https://odontocrm.local/api/v1/health

# Modo test desactivado (el plan §12 lo exige en producción)
grep -H -E '^(TEST_MODE|ALLOW_TEST_MODE)' /etc/odontocrm/*.env

# Sin errores recientes
journalctl -p err --since '24 hours ago' --no-pager | tail -30

# Espacio en disco
df -h / /var/lib/odontocrm /var/backups/odontocrm
```

### 17.3 Lista de comprobación final

| # | Comprobación | Cómo | Hecho |
| :-: | :--- | :--- | :-: |
| 1 | Fedora 43+ actualizado | `cat /etc/fedora-release` · `dnf upgrade` | ☐ |
| 2 | Zona horaria y hora sincronizadas | `timedatectl` · `chronyc tracking` | ☐ |
| 3 | Paquetes instalados (P-01) | `dnf list installed \| grep -E 'postgresql18\|nodejs'` | ☐ |
| 4 | Node.js 26 y npm 11 | `node --version` · `npm --version` | ☐ |
| 5 | PostgreSQL 18 inicializado y activo | `postgresql-18-setup --initdb` · `systemctl status postgresql-18` | ☐ |
| 6 | PostgreSQL solo en `127.0.0.1` | `ss -lntp \| grep 5432` | ☐ |
| 7 | Las 8 bases y los 8 roles creados | `sudo -u postgres psql -c '\l'` · `'\du'` | ☐ |
| 8 | Usuario `odontocrm` sin login | `getent passwd odontocrm` | ☐ |
| 9 | Directorios y permisos según §7.2 | `ls -ld` / `find -printf` | ☐ |
| 10 | Los **dos** archivos de entorno existen: `/etc/odontocrm/odontocrm.env` (común) y `/etc/odontocrm/<servicio>.env` (propio), con `0600 root:root` — `0640 root:odontocrm` si el supervisor es PM2 — y sin marcadores `CAMBIAR_*` | `ls -l /etc/odontocrm/*.env` · `grep -c CAMBIAR /etc/odontocrm/*.env` | ☐ |
| 11 | Claves EdDSA generadas y con permisos `0640 root:odontocrm` | `ls -l /etc/odontocrm/keys` | ☐ |
| 12 | Código desplegado y compilado en `/opt/odontocrm` | `npm ci && npm run build` | ☐ |
| 13 | Migraciones aplicadas en las 8 bases | §9.3 | ☐ |
| 13-bis | **Observabilidad**: tablero en verde y alertas programadas | `npm run estado` · `systemctl list-timers odontocrm-alertas.timer` (§10.6) | ☐ |
| 13-ter | **Rotación de logs** instalada | `logrotate --debug /etc/logrotate.d/odontocrm` (§10.6) | ☐ |
| 14 | SPA compilada y servida por el proxy | `curl -I https://odontocrm.local/` | ☐ |
| 15 | Chromium de Playwright instalado y localizable | §9.5 | ☐ |
| 16 | Los 9 servicios activos y habilitados | `systemctl --type=service 'odontocrm*'` | ☐ |
| 17 | `/health` y `/ready` responden 200 en los 9 | §17.1 | ☐ |
| 18 | Reinicio del servidor probado: todo vuelve solo (P-16) | §10.5 | ☐ |
| 19 | firewalld: solo 443 abierto a la LAN (P-20) | `firewall-cmd --list-all` | ☐ |
| 20 | 8090/4001-4008/5432 NO accesibles desde la LAN (P-20) | `curl` desde otro equipo | ☐ |
| 21 | SELinux en `Enforcing`, sin denegaciones recientes | `getenforce` · `ausearch -m avc -ts recent` | ☐ |
| 22 | Contextos y booleanos aplicados (P-11) | `semanage fcontext -l \| grep odontocrm` | ☐ |
| 23 | TLS interno válido y cookie `Secure` (P-12) | §13.5 | ☐ |
| 24 | SSE de las pantallas funciona a través del proxy (P-11) | pantalla de sala en vivo | ☐ |
| 25 | Respaldo diario programado y ejecutado una vez | `systemctl list-timers` · `backup.log` | ☐ |
| 26 | Respaldo verificado (`pg_restore --list`, `SHA256SUMS`) | §15.3 | ☐ |
| 27 | **Prueba de restauración documentada** (P-15) | §16.2 | ☐ |
| 28 | Copia externa de respaldos (P-14) | `rsync` a otro equipo | ☐ |
| 29 | Rotación de logs configurada | §15.5 | ☐ |
| 30 | `TEST_MODE` y `ALLOW_TEST_MODE` en `false` en los 9 servicios | `grep -H -E '^(TEST_MODE\|ALLOW_TEST_MODE)'` | ☐ |
| 31 | Token del bot de Telegram cargado y poller único | `journalctl -u odontocrm@notifications` | ☐ |
| 32 | Tailscale (si se usa) probado (P-23) | `tailscale status` | ☐ |
| 33 | Rollback documentado y probado (§18) | restaurar la fase anterior | ☐ |
| 34 | **Secretos del bootstrap trasladados** a `/etc/odontocrm/<servicio>.env` (§8.6) | revisar §8.6 pasos 1-3 y comparar con `services/<servicio>/.env` | ☐ |
| 35 | **Ningún `.env` dentro de `/opt/odontocrm`** (ni real ni enlace; tampoco tras migrar, §9.3) | `sudo find /opt/odontocrm -type f -name '.env' -not -path '*/node_modules/*'` (debe salir vacío) | ☐ |
| 36 | Cada servicio recibe sus variables del supervisor elegido (dos archivos, en orden) | `systemctl show odontocrm@identity -p EnvironmentFiles` · o `pm2 env <id>` | ☐ |

---

## 18. Rollback y desinstalación segura

### 18.1 Revertir un despliegue de código (sin perder datos)

Las fases se cierran con etiquetas (`fase-0`…`fase-10`, plan §14), así que volver atrás
es cambiar de etiqueta y recompilar:

```bash
cd /opt/odontocrm
sudo git fetch --tags
sudo git tag --list 'fase-*'
sudo git checkout fase-8                 # tag anterior conocido-bueno
sudo npm ci && sudo npm run build
sudo systemctl restart odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service odontocrm-gateway.service
/usr/local/bin/verificar-odontocrm
```

Advertencias:

- Si la versión nueva aplicó **migraciones de esquema**, el código anterior puede no
  entender el esquema nuevo. En ese caso: restaurar el respaldo previo a la migración
  (§16) o revertir la migración con el script que la Fase correspondiente documente.
- Antes de cualquier rollback: **respaldo fresco verificado**.

### 18.2 Revertir configuración

```bash
# Copia de seguridad previa a cualquier edición de un .env
sudo cp -a /etc/odontocrm/clinical.env /etc/odontocrm/clinical.env.bak
sudo systemctl restart odontocrm@clinical.service
# Revertir:
sudo cp -a /etc/odontocrm/clinical.env.bak /etc/odontocrm/clinical.env

# Unidades systemd: usar drop-ins en vez de editar el archivo del repositorio
sudo systemctl edit odontocrm@clinical.service     # crea /etc/systemd/system/odontocrm@clinical.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart odontocrm@clinical.service
```

### 18.3 Desinstalación ordenada (conservando los datos)

```bash
# 1) Parar y deshabilitar los servicios
sudo systemctl disable --now odontocrm-gateway.service
sudo systemctl disable --now odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service
sudo systemctl disable --now odontocrm-backup.timer

# 2) Quitar las unidades
sudo rm -f /etc/systemd/system/odontocrm@.service /etc/systemd/system/odontocrm-gateway.service
sudo rm -f /etc/systemd/system/odontocrm-backup.service /etc/systemd/system/odontocrm-backup.timer
sudo systemctl daemon-reload && sudo systemctl reset-failed

# 3) Si usabas PM2
pm2 delete all
pm2 save
pm2 unstartup systemd
sudo systemctl disable --now pm2-odontocrm 2>/dev/null || true

# 4) Cortafuegos: retirar la regla del proxy (deja el resto del sistema intacto)
sudo firewall-cmd --permanent --remove-rich-rule=\
'rule family="ipv4" source address="192.168.1.0/24" port port="443" protocol="tcp" accept'
sudo firewall-cmd --reload

# 5) SELinux: retirar el contexto añadido
sudo semanage fcontext -d '/opt/odontocrm/apps/web/dist(/.*)?'
sudo restorecon -Rv /opt/odontocrm/apps/web/dist

# 6) Reverse proxy: desactivar el sitio
sudo rm -f /etc/nginx/conf.d/odontocrm.conf && sudo nginx -t && sudo systemctl reload nginx
# (o: sudo rm -f /etc/caddy/Caddyfile && sudo systemctl disable --now caddy)
```

**Antes de borrar cualquier cosa, asegúrate de que existe un respaldo verificado y una
copia externa.** Nunca ejecutes `rm -rf` sobre `/var/backups/odontocrm` sin haber
comprobado la copia.

### 18.4 Eliminar los datos (irreversible)

Solo si el sistema se retira definitivamente:

```sql
-- Con respaldo verificado y copia externa ya hecha
DROP DATABASE "odonto_identity" WITH (FORCE);
DROP ROLE "odonto_identity";
-- ... repetir para las 8 bases y roles
DROP ROLE "odonto_backup";
```

```bash
# Archivar (no borrar) la configuración con secretos, en un medio cifrado
sudo tar -czf /root/odontocrm-etc-final-$(date +%F).tar.gz -C /etc odontocrm
sudo chmod 0600 /root/odontocrm-etc-final-*.tar.gz

# El código y el almacenamiento se archivan igual; el usuario de sistema se elimina al final
sudo userdel --remove odontocrm 2>/dev/null || sudo userdel odontocrm
```

**Qué NO desinstalar a la ligera:** PostgreSQL (puede compartirse con otros sistemas),
`/var/backups/odontocrm` (contiene el historial clínico) y `/var/lib/odontocrm/storage`
(radiografías y PDFs).

---

## 19. Solución de problemas

| Síntoma | Causa probable | Solución |
| :--- | :--- | :--- |
| `service failed: status=203/EXEC` | Ruta de `dist/` distinta a la esperada | Compilar; ajustar `ExecStart` (P-04) |
| `EADDRINUSE` en los logs | Dos supervisores (PM2 y `systemd`) o dos instancias | Elegir uno (§10.1) y `pm2 delete all` o `systemctl disable --now` |
| El servicio no arranca y no hay traza | `EnvironmentFile` ausente o sin permisos | `install.sh --apply`, revisar `journalctl -u <unidad> -n 100` |
| `password authentication failed` hacia PostgreSQL | `DATABASE_URL` o `pg_hba.conf` | Revisar §6.3 y el `.env` del servicio |
| `permission denied for table …` en el respaldo | Rol de respaldo sin `pg_read_all_data` | §15.2 |
| `pg_dump: error: connection to server on socket … failed` | `PG_HOST` apunta a un socket que no existe | Ajustar `PG_HOST` a `127.0.0.1` (P-09) |
| `pg_restore: error: could not execute query … permission denied to create extension` | Restauración con un rol sin privilegios | Usar `--admin-user postgres`; extensiones *trusted* las crea el dueño de la base |
| La SPA carga pero `/api/**` da 502 | Gateway caído o SELinux bloquea la conexión del proxy | `systemctl status odontocrm-gateway` · `setsebool -P httpd_can_network_connect on` |
| Pantallas que no se actualizan | El proxy acumula el SSE en búfer | `proxy_buffering off` / `flush_interval -1` (§13.3, §13.4) |
| Cookie de sesión rechazada por el navegador | Sin TLS o certificado no confiable | §13.2 y §13.5 |
| El PDF del récipe falla | Chromium ausente, dependencias o rutas de escritura | §4.1 y §9.5; revisar `PLAYWRIGHT_BROWSERS_PATH` |
| SELinux: `Permission denied` en `/opt/odontocrm/apps/web/dist` | Contexto `usr_t` | `semanage fcontext` + `restorecon` (§12.1) |
| El respaldo no se ejecuta | Timer no habilitado o falló el arranque del servicio | `systemctl list-timers` · `journalctl -u odontocrm-backup` |
| Disco lleno | Respaldos o radiografías | `df -h`, retención (§15), `ncdu /var/lib/odontocrm/storage` |

---

## 20. Registro de verificación de la Fase 10

Completa esta tabla al probar la instalación en el Fedora real. Es la evidencia que
exige el plan (§13, Fase 10).

### 20.1 Puntos pendientes

| ID | Pendiente | Cómo se comprueba | Verificado | Evidencia |
| :--- | :--- | :--- | :--- | :--- |
| P-01 | Versiones exactas de paquetes | `dnf list installed \| grep -E 'postgresql18\|nodejs'` | ✅ | **PC de pruebas (Fedora 44):** `postgresql-server-18.6-1.fc44`, `nodejs-26.10.0-1nodesource`. Ojo: en Fedora 44 el motor viene de los repos de Fedora (`postgresql-server`), **no** de PGDG (`postgresql18-server`): las dos rutas son válidas y la guía explica las dos. |
| P-02 | Canal y versión de Node.js 26 | `node --version` tras instalar | ✅ | **PC de pruebas:** `setup_26.x` de NodeSource existe y entrega **v26.10.0** con npm 11.19.1; quitó el `nodejs22` de Fedora sin conflictos (nadie más lo usaba). |
| P-03 | Nombres de variables vs `.env.example` | `diff` contra el `.env.example` del repo | ✅ | **PC de pruebas:** `npm run env:check` → «los .env tienen todas las claves de su plantilla». |
| P-04 | Artefacto compilado (`dist/index.js`) | `ls /opt/odontocrm/services/*/dist/ /opt/odontocrm/apps/gateway/dist/` | ✅ | **PC de pruebas:** los 8 servicios y el gateway arrancan desde `/opt/odontocrm/**/dist/` con `systemd` (9/9 `active` sirviendo su puerto). |
| P-05 | Flujo de bootstrap y migraciones en producción | `npm run db:bootstrap` · `npm run db:migrate` (§6.4 y §9.3) | ✅ | **PC de pruebas:** bootstrap sobre el PostgreSQL del sistema por socket `peer` y las 8 migraciones corridas desde el código desplegado, con el entorno de `/etc/odontocrm` inyectado. |
| P-06 | Dependencias de Chromium / `install-deps` | `ldd … \| grep 'not found'` | ✅ | **PC de pruebas:** `npx playwright install-deps chromium` **no soporta Fedora 44** (mención, no instrucción: `fedora:check-ok`) (cae a `ubuntu24.04` y muere en `apt-get`); con la lista de `dnf` de §4.1 y `ldd` no falta ninguna biblioteca. El plan B de la guía es el camino real. |
| P-07 | Chromium bajo `systemd` endurecido | generar un PDF de prueba | ✅ | **PC de pruebas:** la exportación de un reporte por el proxy devuelve un PDF de **32 365 bytes** (`%PDF-`) generado por Chromium bajo la unidad endurecida (`Playwright` encontró el navegador en `/var/lib/odontocrm/ms-playwright`). Antes daba **503** porque `reporting.env` no definía `PLAYWRIGHT_BROWSERS_PATH` (§9.5-bis). |
| P-08 | Nombres reales de roles (`infra/db/bootstrap.mjs`) | `sudo -u postgres psql -c '\du'` | ☐ | |
| P-09 | Socket de PostgreSQL y `pg_hba.conf` | `ls /var/run/postgresql` · `pg_hba.conf` | ✅ | **PC de pruebas:** el socket está en `/var/run/postgresql` y `postgresql-setup --initdb` deja **`ident`** en las líneas `host` (no `scram-sha-256`): con eso **ningún servicio entra por TCP** aunque la contraseña sea correcta. Hay que cambiarlas a `scram-sha-256` (§6.3). El administrador entra por el socket con `peer` (`PG_ADMIN_URL=postgres:///postgres?host=/var/run/postgresql`). |
| P-10 | PM2 en producción: `infra/fedora/ecosystem.config.cjs` con los dos `--env-file-if-exists` y `.env` legibles por el grupo (`0640 root:odontocrm`) | §10.4 · `pm2 ls` · `pm2 logs odontocrm-identity` | ☐ | No validado en la PC de pruebas: el supervisor elegido y probado a fondo es **systemd** (§10.1). PM2 queda como alternativa documentada, sin ensayo. |
| P-11 | Proxy elegido + SSE + SELinux | pantalla en vivo + `ausearch` | ✅ | **PC de pruebas:** nginx con el SSE de `/api/v1/screens/<pantalla>/stream` sin búfer (`proxy_buffering off`), árbol de proxy con `httpd_can_network_connect` y **sin denegaciones de SELinux** (`ausearch -m avc -ts today`). |
| P-12 | Certificado interno y confianza en dispositivos | `openssl s_client` desde PC/tablet/TV | ◐ | **PC de pruebas:** certificado emitido con el nombre y la IP, nginx sirviéndolo y **la CA descargable en `http://<servidor>/ca.crt`** (§13.3-bis) con las instrucciones por dispositivo. Falta el paso manual en cada equipo (tablet, móvil, TV), que es lo que se registra aquí al hacerlo en la clínica. |
| P-13 | Recursos y cifrado de disco | `free -h` · `df -h` · LUKS | ◐ | **PC de pruebas:** 7,6 GiB de RAM con los 9 servicios, PostgreSQL, nginx y Chromium en marcha (4,3 GiB en uso, sin swap) y 88 GB libres en `/`. **El disco NO está cifrado** (`lsblk` sin LUKS): en la clínica hay que decidirlo antes de cargar datos reales. |
| P-14 | Cifrado y copia externa del respaldo | `rsync` + `age`/`gpg` | ◐ | **PC de pruebas:** el respaldo diario ya se programa solo (`odontocrm-backup.timer`, 03:30 con `Persistent=true`); queda decidir el cifrado del medio externo (§15.5). |
| P-15 | **Prueba de restauración documentada** | §16.2, con las 8 bases | ☐ | |
| P-16 | **Reinicio del servidor: los 9 vuelven solos** | §10.5 | ✅ | **PC de pruebas (2026-10-04):** tras `systemctl reboot` los **9 servicios y nginx** volvieron solos, sin intervención: `active`, con 4 minutos de vida y `/health` y `/ready` en **200** por HTTPS (`sudo npm run estado`), el gateway incluido. |
| P-17 | Cómo se sirve la SPA y su etiqueta SELinux | `curl -I` + `semanage fcontext -l` | ✅ | **PC de pruebas:** la SPA se sirve desde `/opt/odontocrm/apps/web/dist` por nginx (200 por https), con la etiqueta `httpd_sys_content_t` aplicada por `semanage fcontext` + `restorecon`. |
| P-18 | `BYPASSRLS` para el rol de respaldo (si hay RLS) | `\du+ odonto_backup` | ✅ | **PC de pruebas:** el esquema **no usa RLS** (ninguna migración crea políticas), así que no hace falta. Sí hizo falta `USAGE` explícito en los esquemas `drizzle` y `pgboss`, que `pg_read_all_data` no cubre (el respaldo moría con «permiso denegado al esquema drizzle»). |
| P-19 | Rotación del token del bot y de la clave JWT | §8.5 | ☐ | |
| P-20 | 8090/4001-4008/5432 inaccesibles desde la LAN | `curl` desde otro equipo | ◐ | **PC de pruebas:** verificado en la máquina — PostgreSQL y los 9 servicios escuchan **solo en 127.0.0.1** y firewalld únicamente publica 443 (y 80 para el redirect). Falta la comprobación desde **otro equipo** de la LAN (en la clínica: el móvil o la tablet). |
| P-21 | Alertas de servicio caído y cola atascada | entregable de observabilidad (Fase 10) | ✅ | **PC de pruebas:** `odontocrm-alertas.timer` cada 5 min con `npm run estado --alertas`; el tablero comprueba los 9 servicios, las 9 bases, la cola, el outbox, los envíos y el disco, y **detectó dos fallos reales** durante la validación (la cola sin `EVENTS_DATABASE_URL` y los puertos servidos por otra pila). |
| P-22 | SELinux con PM2/Chromium | `ausearch -m avc -ts today` | ☐ | |
| P-23 | Tailscale (opcional) | `tailscale status` + ACL | ☐ | |
| P-24 | **Secretos solo en `/etc/odontocrm`**: `services/<servicio>/.env` trasladados y borrados; ningún `.env` en `/opt/odontocrm` | §8.6 · `sudo find /opt/odontocrm -type f -name '.env'` | ✅ | **PC de pruebas:** `find /opt/odontocrm -type f -name '.env'` sale **vacío**; los 9 archivos de entorno viven en `/etc/odontocrm` con `0600 root:root` y los lee systemd como root. |
| P-25 | Los dos archivos de entorno por servicio se cargan en orden (común → propio) con el supervisor elegido | `systemctl show odontocrm@identity -p EnvironmentFiles` · `node --env-file-if-exists=…` | ✅ | **PC de pruebas:** `EnvironmentFiles=/etc/odontocrm/odontocrm.env` seguido de `/etc/odontocrm/identity.env`, en ese orden, en las nueve unidades. |
| P-26 | **Nombres reales de los paquetes de SELinux**: en Fedora son `setools-console` (+ `setroubleshoot-server` para `sealert`, `audit` para `ausearch`); el que esta guía pedía antes no existe (`fedora:check-ok`) | `dnf provides '*/sealert'` · instalarlos de nuevo sin error | ✅ | Banco de pruebas (Fase 10): el paquete que pedía la guía falló al instalar, `setools-console` se instaló; §4 y §12 corregidos |

### 20.1-bis Hallazgos de la Fase 10 (y su arreglo)

Cada uno se descubrió **corriendo el sistema**, no leyéndolo, y quedó corregido en el
mismo commit que lo documenta:

| ID | Hallazgo | Arreglo |
| :--- | :--- | :--- |
| P-27 | **`TELEGRAM_MODE=polling` no existe.** El esquema acepta `auto \| real \| simulado` (el long polling es el transporte, no un modo). La plantilla de `/etc/odontocrm/notifications.env` lo traía desde la Fase 4 y el servicio **no arrancaba** (`ConfigError`), con él la migración. | Plantilla corregida a `auto`; `install.sh` arregla el valor heredado en archivos existentes (§8.2). |
| P-28 | **El clúster de Fedora deja `ident` en TCP.** Ningún servicio entra por `127.0.0.1` aunque la contraseña esté bien. | §6.3 explica el síntoma y deja los comandos para pasar a `scram-sha-256`. |
| P-29 | **`node --watch` muere si falta un `--env-file-if-exists`.** El gateway no tenía `apps/gateway/.env` y la pila entera se caía al arrancar. | El bootstrap crea el archivo vacío con su explicación. |
| P-30 | **Buscar en la cola de `/flujo` dejaba la pantalla sin paciente en curso** (y sin las acciones de la barra): el filtro se aplicaba a la jornada antes de resolver la cita en curso. | La selección se resuelve sobre la jornada completa; dos pruebas puras lo fijan. |
| P-31 | **Los eventos publicados mientras otro servicio arrancaba se perdían**: la lista de colas es una foto y el publicador entregaba solo donde ya había cola (10 altas y 30 hallazgos sin proyectar). | El publicador declara las colas de los cinco consumidores conocidos antes de su primer envío; una prueba compara la lista con el código. |
| P-32 | **`seed:verify` dependía de la collation del clúster**: con `en_US.UTF-8`, `examenes_complementarios` va antes que `examen_extraoral`, y la huella cambiaba de máquina a máquina sin que ningún dato fuera distinto. | Las consultas de texto llevan `collate "C"` (orden por bytes), el mismo que usa el comparador. |
| P-33 | **El comando `install-deps` de Playwright no soporta Fedora** (probó `ubuntu24.04` y murió en `apt-get`). `fedora:check-ok` | §4.1 ya documenta la lista de `dnf` como plan B; el script de instalación la usa cuando el comando falla. |
| P-35 | **El guion de ensayo moría en silencio antes del «Resumen»**: quedaba una referencia a una variable que ya no existía y, con `set -u`, el guion abortaba justo después de la prueba de restauración. El síntoma era engañoso —«`--reiniciar` no reinicia»— y la prueba de reinicio no llegaba a ejecutarse nunca. | Un `trap ERR` avisa con la **línea exacta** donde se detuvo, y el reinicio comprueba `systemctl` antes de pedirlo. Probado simulando `systemctl` para no reiniciar la máquina en cada intento. |
| P-34 | **Intermitencia de las suites de integración**: con cuatro suites en paralelo falla una prueba distinta en cada corrida (esperas del camino outbox → cola → consumidor). Comprobado que **no** la introdujo la Fase 10 (con el cambio de colas revertido en un árbol aparte falla igual). | Tope único y ajustable (`TEST_WAIT_MS`, 30 s). Pendiente de endurecer: no es un fallo de producto. |

### 20.2 Registro de la prueba de restauración

| Fecha | Operador | Respaldo usado | Bases probadas | Código de salida | Tablas origen/destino | Observaciones |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-10-04 | gabox (PC Fedora de pruebas) | `/var/backups/odontocrm/2026-10-04` (2,6 MB, `--include-config`, 8 bases + `SHA256SUMS` + `manifest.txt`) | las **8** (`--all --keep-verify-db`) | **0** | 7/7, 5/5, 6/6, 7/7, 10/10, 5/5, 4/4, 12/12 | Restauración verificada en las bases temporales `<base>__verif`: **4953 filas en producción y 4953 en las restauradas**, base por base (identity 1551, patients 126, scheduling 746, notifications 82, clinical 578, odontogram 566, screens 80, reporting 1224). Las `__verif` se conservaron como evidencia. **Tres fallos por el camino, los tres corregidos y documentados:** el rol de respaldo no leía por `NOINHERIT` (§15.2), `pg_read_all_data` no cubre los esquemas `drizzle`/`pgboss`, y el restablecimiento se quedaba mudo esperando la contraseña del rol administrador (§16.2). |

### 20.3 Registro de la prueba de reinicio

| Fecha | `systemctl reboot` ejecutado | Servicios activos tras el reinicio | `/health` de los 9 | Observaciones |
| :--- | :--- | :--- | :--- | :--- |
| 2026-10-04 | Sí, al final del ensayo (`--reiniciar`) | **9 de 9** (más `nginx`, `postgresql` y el temporizador de alertas) | **200** en los 9, y `/ready` también | Los servicios volvieron **solos** y en el orden correcto (`After=`/`Wants=`), con `↑ 4 min` de vida al mirar. La primera prueba **no reinició** por un fallo del guion de ensayo (moría en silencio antes del «Resumen», hallazgo P-35), no del sistema. **Aviso para el operador:** `npm run estado` necesita `sudo` (los entornos son `0600 root:root`); sin él avisa de que no puede comprobar la cola y el outbox en vez de inventarse problemas. |

---

## 21. Anexos

### A. Comandos más usados

```bash
# Estado general
systemctl --no-pager --type=service 'odontocrm*' | cat
/usr/local/bin/verificar-odontocrm

# Logs
journalctl -u odontocrm@identity -f
journalctl -u 'odontocrm@*' --since '1 hour ago' --no-pager

# Reiniciar todo en orden
sudo systemctl restart postgresql-18
sudo systemctl restart odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service
sudo systemctl restart odontocrm-gateway.service

# Respaldo y restauración
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --dry-run
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh --list
```

### B. Tabla consolidada de rutas

| Ruta | Propietario:grupo | Modo | Función |
| :--- | :--- | :--- | :--- |
| `/opt/odontocrm` | `root:root` | `0755` | Código y unidades `systemd` del repo. **Sin ningún `.env`** (§8.6) |
| `/opt/odontocrm/apps/web/dist` | `root:root` | `0755` | SPA compilada (etiqueta `httpd_sys_content_t`) |
| `/opt/odontocrm/infra/fedora/ecosystem.config.cjs` | `root:root` | `0644` | Alternativa a `systemd`: procesos PM2 con rutas absolutas (§10.4) |
| `/etc/odontocrm` | `root:odontocrm` | `0750` | Configuración |
| `/etc/odontocrm/odontocrm.env` | `root:root` | `0600` | Variables **comunes** a los 9 servicios (§8.1) |
| `/etc/odontocrm/<svc>.env` | `root:root` | `0600` | Variables y secretos **propios** del servicio (`0640 root:odontocrm` con PM2) |
| `/etc/odontocrm/keys` | `root:odontocrm` | `0750` | Claves EdDSA |
| `/etc/odontocrm/backup.env`, `.pgpass` | `root:root` | `0600` | Configuración y credenciales del respaldo |
| `/var/lib/odontocrm` | `odontocrm:odontocrm` | `0750` | `HOME`, datos y cachés |
| `/var/lib/odontocrm/storage` | `odontocrm:odontocrm` | `0750` | Radiografías, adjuntos, PDFs |
| `/var/log/odontocrm` | `odontocrm:odontocrm` | `0750` | Logs en archivo |
| `/var/backups/odontocrm` | `root:root` | `0700` | Respaldos |
| `/var/lib/pgsql/data` | `postgres:postgres` | `0700` | Clúster de PostgreSQL 18 |

### C. Referencias

- Plan maestro: [`docs/PLAN_MAESTRO_FASES.md`](../../docs/PLAN_MAESTRO_FASES.md) — §1 decisiones, §2 arquitectura, §3 estructura, §11 seguridad, §13 Fase 10, §15 qué hay que instalar, §16 riesgos.
- Política de secretos: `docs/SEGURIDAD_SECRETOS.md` (Fase 0).
- Bootstrap de bases y roles: `infra/db/bootstrap.mjs` + `npm run db:bootstrap` (Fase 0).
- Instalación en Windows (desarrollo): `infra/windows/install.md` (Fase 0).

---

*Borrador 0.1.0 — se completa y prueba en la Fase 10. Cualquier cambio de alcance se
refleja antes en `docs/PLAN_MAESTRO_FASES.md`, no aquí.*
