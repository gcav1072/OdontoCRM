# Runbook — operación del servidor de la clínica

> **Para quién es.** Para quien administra el servidor Fedora del consultorio: la
> doctora o la persona de sistemas que entra por SSH o se sienta frente a la máquina.
> No hace falta saber programar: cada tarea dice **qué se hace, cómo se comprueba y
> qué significa lo que se ve**.
>
> **Una sola puerta: `sudo odontocrm`.** Todas las tareas de este runbook están ahí,
> sin rutas ni variables que recordar:
>
> ```bash
> sudo odontocrm            # la ayuda
> sudo odontocrm estado     # el tablero completo
> sudo odontocrm alertas    # solo los problemas (código 1 si hay)
> sudo odontocrm respaldar  # un respaldo ahora
> sudo odontocrm verificar  # los 9 servicios, uno por uno
> sudo odontocrm logs clinical
> ```
>
> **Antes de tocar nada**: `sudo odontocrm estado` (lee `/etc/odontocrm`; `npm run estado`
> a secas busca los `.env` del repositorio, que en producción se borran). Ese comando
> dice, en una pantalla, si los nueve servicios están vivos, si la cola de eventos
> avanza, si el respaldo corrió y cuánto disco queda. Casi todo lo de este documento
> empieza y termina ahí.
>
> **Con `sudo`, siempre.** Los archivos de entorno son `0600 root:root` (los lee
> systemd como root): sin `sudo`, el tablero *no puede* mirar la cola, el outbox ni los
> envíos, y lo dice con un aviso en vez de inventarse problemas. Si alguna vez ves
> nueve cruces rojas de «sin DATABASE_URL», es que se ejecutó sin `sudo`.

- Instalación desde cero: [`INSTALL.md`](INSTALL.md)
- Comandos del servidor en producción (referencia rápida): [`../../docs/COMANDOS_PRODUCCION.md`](../../docs/COMANDOS_PRODUCCION.md)
- Comandos del día a día: [`docs/COMANDOS.md`](../../docs/COMANDOS.md)
- Qué ve el personal en la aplicación: [`docs/OPERACION_CLINICA.md`](../../docs/OPERACION_CLINICA.md)

Índice:

1. [Los cinco minutos de la mañana](#1-los-cinco-minutos-de-la-mañana)
2. [Arrancar, parar y reiniciar](#2-arrancar-parar-y-reiniciar)
3. [Respaldos](#3-respaldos)
4. [Restaurar](#4-restaurar)
5. [Usuarios y contraseñas](#5-usuarios-y-contraseñas)
6. [El bot de Telegram](#6-el-bot-de-telegram)
7. [Cuando algo va mal](#7-cuando-algo-va-mal)
8. [Actualizar el sistema](#8-actualizar-el-sistema)
9. [Registro y contactos](#9-registro-y-contactos)

---


## 1. Los cinco minutos de la mañana

```bash
cd /opt/odontocrm
sudo odontocrm estado
```

Lo que tiene que decir:

- **Servicios**: los nueve con `✔`, `health 200` y `ready 200`.
- **Cola de eventos**: `0 pendiente(s), 0 fallido(s)` y el número de completados subiendo.
- **Outbox**: «todo publicado» en los ocho servicios.
- **Notificaciones**: lo que haya en cola son los avisos de las citas del día.
- **Alertas**: «nada que reportar».

Si algo aparece en rojo, ve a [§7](#7-cuando-algo-va-mal). Si el tablero dice que el
**modo test está activo**, para: significa que el sistema está con datos ficticios y
no debe usarse con pacientes (avisa a quien corresponda antes de seguir).

```bash
# El respaldo de la madrugada, ¿corrió?
sudo tail -n 20 /var/log/odontocrm/backup.log
sudo ls -lh /var/backups/odontocrm | tail -5
```

---

## 2. Arrancar, parar y reiniciar

> **El ciclo completo (parar → recompilar → arrancar)**, con la tabla que traduce los
> comandos de desarrollo a los del servidor, está en
> [`../../docs/COMANDOS_PRODUCCION.md`](../../docs/COMANDOS_PRODUCCION.md) §2-bis.
> Aquí queda el resumen de una línea por comando.

### Con systemd (recomendado)

```bash
sudo odontocrm red             # ¿en qué IP está y qué apunta a la red anterior?
sudo odontocrm red --arreglar  # adaptarlo (firewall, certificado y CORS) a la red actual
sudo odontocrm parar           # detener los 9 (nginx y PostgreSQL se quedan)
sudo odontocrm parar --todo    # …y también nginx y PostgreSQL (sistema parado del todo)
sudo odontocrm arrancar        # arrancarlos en orden y verificar
sudo odontocrm reiniciar       # aplicar cambios de configuración
```

Los tres **funcionan en cualquier estado**: si el sistema estaba parado del todo,
`arrancar` y `reiniciar` levantan también PostgreSQL y nginx. No hay que «arrancar en el
orden correcto» a mano: lo hace el comando y después **comprueba** que los nueve
escuchen.


```bash
# Estado de todo
systemctl --no-pager --type=service 'odontocrm*' | cat
systemctl list-timers odontocrm-alertas.timer odontocrm-backup.timer

# Arrancar (en orden: base, servicios, puerta)
sudo systemctl start postgresql-18
sudo systemctl start odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service
sudo systemctl start odontocrm-gateway.service

# Parar (al revés) — para un mantenimiento con la clínica cerrada
sudo systemctl stop odontocrm-gateway.service
sudo systemctl stop odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service
# PostgreSQL se deja corriendo: no molesta y evita arranques en frío.

# Reiniciar uno solo (lo normal tras cambiar su .env)
sudo systemctl restart odontocrm@clinical.service
journalctl -u odontocrm@clinical -n 50 --no-pager
```

### Con PM2 (alternativa)

```bash
sudo -u odontocrm env HOME=/var/lib/odontocrm PM2_HOME=/var/lib/odontocrm/.pm2 pm2 ls
sudo -u odontocrm env HOME=/var/lib/odontocrm PM2_HOME=/var/lib/odontocrm/.pm2 pm2 restart odontocrm-clinical
sudo -u odontocrm env HOME=/var/lib/odontocrm PM2_HOME=/var/lib/odontocrm/.pm2 pm2 logs odontocrm-clinical --lines 50
```

> **Nunca los dos supervisores a la vez**: si PM2 y systemd arrancan los mismos
> servicios, el segundo no puede escuchar el puerto (`EADDRINUSE`) y la pila queda a
> medias. Mira quién manda antes de arrancar: `npm run stack:status`.

### Parada de emergencia

```bash
sudo systemctl stop odontocrm-gateway.service     # la clínica deja de entrar
sudo systemctl stop 'odontocrm@*'                 # los servicios internos
```

Los datos **no se corrompen** al apagar así: los servicios cierran ordenadamente
(`KillSignal=SIGTERM` y `TimeoutStopSec=30`) y PostgreSQL confirma cada transacción.
Lo que sí puede quedar a medias es un envío del bot: se reintenta al volver.

---

## 3. Respaldos

El respaldo diario lo programa `install.sh` (temporizador de systemd, de madrugada).
Lo hace [`backup/odontocrm-backup.sh`](backup/odontocrm-backup.sh): `pg_dump -Fc` de
las **nueve bases**, verificación de integridad, copia opcional de `storage/` y de la
configuración, y rotación por días de retención.

```bash
# ¿Cuándo toca y cómo fue la última?
systemctl list-timers odontocrm-backup.timer
sudo tail -n 30 /var/log/odontocrm/backup.log

# ¿Qué hay guardado?
sudo ls -lh /var/backups/odontocrm | tail -10

# Un respaldo a mano (antes de una actualización, por ejemplo)
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --include-config --include-storage
```

Qué tiene que salir en el registro: una línea por base con `OK`, el tamaño, y al final
`Respaldo completado`. Si aparece `FALLO` o el archivo pesa **cero**, el respaldo de
ese día no sirve: mira el error, arréglalo y lanza uno a mano.

> **Regla de oro**: mientras el respaldo del día no esté verificado, no se hacen
> cambios grandes (actualizar, restaurar, tocar la base).

---

## 4. Restaurar

Primero se **ensaya** (el script restaura en una base temporal y comprueba que los
datos entran), y solo después se restaura de verdad:

Los respaldos son **un archivo por base y por día** (`<BACKUP_DIR>/AAAA-MM-DD/<base>_<marca>.dump`),
no un `.tar.gz`. Las banderas reales del guion son `--from`, `--db`, `--keep-verify-db`,
`--keep-old` y `--yes` (comprueba con `--help` antes de improvisar):

```bash
# 1) Ensayo en seco: dice qué haría, sin tocar nada
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
  --from /var/backups/odontocrm/2026-10-04 --dry-run

# 2) Ensayo real de UNA base: restaura en odonto_patients__verif y compara filas.
#    Así se ve que el respaldo sirve sin arriesgar la base buena.
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
  --from /var/backups/odontocrm/2026-10-04 --db odonto_patients --keep-verify-db --yes

# 3) Restauración de verdad (la clínica debe estar parada).
#    `--keep-old` guarda la base actual como «__antes_de_restaurar»: sin él, se ELIMINA.
sudo systemctl stop odontocrm-gateway.service 'odontocrm@*'
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh \
  --from /var/backups/odontocrm/2026-10-04 --db odonto_patients --keep-old --yes
sudo systemctl start 'odontocrm@*' odontocrm-gateway.service

# 4) Comprobar
sudo odontocrm estado
sudo odontocrm verificar
```

> `--yes` es obligatorio a propósito (sin él el guion sale con código 10 y **no hace nada**):
> restaurar es destructivo. Y antes de restaurar en producción, un **respaldo reciente
> verificado** ([[INSTALL.md §15]]).

La prueba de restauración completa (base limpia, contar filas y anotarlo) está en
[`INSTALL.md` §16](INSTALL.md) y es un **criterio de aceptación de la Fase 10**: sin
ella, el sistema no se usa con pacientes reales.

---

## 5. Usuarios y contraseñas

Las cuentas se crean desde la aplicación (`/usuarios`, permiso `users:manage`, solo
el administrador) o con el seed, que es lo que se usa en la puesta en marcha:

```bash
# Crea lo que falte (no toca lo que ya existe). En producción el seed EXIGE la contraseña
# en el entorno (`SEED_PASSWORD_<USUARIO>`), así que se pasa en la misma línea que el
# comando; `con-entorno` la reenvía al proceso.
cd /opt/odontocrm
sudo SEED_PASSWORD_ADMIN='la-que-quieras-poner' \
  odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset

# ¿Qué usuarios hay y quiénes tienen contraseña temporal?
sudo odontocrm con-entorno identity -- node services/identity/dist/seed.js --print
```

> La contraseña nueva nace **temporal**: el sistema obliga a cambiarla al entrar. Para
> reponer la del administrador cuando se ha olvidado, el comando de arriba es el camino
> (en producción el seed **no** acepta las claves de desarrollo).

- Toda contraseña nueva nace **temporal**: el sistema obliga a cambiarla en el primer
  acceso.
- **5 intentos fallidos bloquean la cuenta 15 minutos.** Se desbloquea sola; si hay
  prisa: `npm run seed:users -- --reset` (deja la contraseña sembrada y limpia
  bloqueos e intentos).
- **El personal no comparte usuarios**: cada quien entra con el suyo, porque todo lo
  clínico queda auditado con nombre y apellido.
- Para **dar de baja** a alguien: `/usuarios` → desactivar (no se borra: sus actos
  clínicos siguen firmados por él).

---

## 6. El bot de Telegram

El token vive **solo** en `/etc/odontocrm/notifications.env` y nunca se comparte por
chat ni se pega en el repositorio.

```bash
# Comprobar que está vivo
sudo odontocrm con-entorno notifications -- node tools/telegram-menu.mjs   # menú del bot

# Rotar el token (BotFather → /revoke → token nuevo)
sudo nano /etc/odontocrm/notifications.env     # TELEGRAM_BOT_TOKEN=…
sudo systemctl restart odontocrm@notifications.service
journalctl -u odontocrm@notifications -n 30 --no-pager
```

Señales de que algo va mal con el bot: en `/notificaciones` la tarjeta dice «Modo
simulado» (no hay token o el servicio no lo ve) o «Sin conexión» (Telegram no
contesta); los avisos quedan en cola y se reintentan solos.

> **Un solo poller.** Si algún día se levanta una segunda copia del servicio de
> notificaciones, Telegram responde `409 Conflict` y ninguno de los dos funciona.

---

## 7. Cuando algo va mal

Empieza siempre por el tablero y los registros:

```bash
sudo odontocrm estado
journalctl -p err --since '1 hour ago' --no-pager | tail -40
sudo tail -n 50 /var/log/odontocrm/backup.log
```

| Síntoma | Qué mirar | Qué hacer |
| :--- | :--- | :--- |
| Un equipo nuevo avisa «conexión no privada» | Nada roto: ese equipo no conoce el certificado | En **ese** equipo, abrir `http://<IP-del-servidor>/ca.crt`, instalarlo como autoridad de certificación y reabrir el navegador ([paso a paso por sistema](../../docs/CERTIFICADO_EN_LOS_EQUIPOS.md)) |
| La clínica no entra (navegador) | `sudo odontocrm estado`, `systemctl status odontocrm-gateway`, `systemctl status nginx` (el proxy del proyecto es nginx) | Reiniciar el proxy y la puerta. Si el certificado venció, renovarlo ([INSTALL.md §13](INSTALL.md)) |
| Un servicio en rojo en el tablero | `systemctl status odontocrm@<servicio>`, `journalctl -u odontocrm@<servicio> -n 50` | Reiniciarlo. Si dice `ConfigError`, falta una variable en `/etc/odontocrm/<servicio>.env` |
| `/ready` en 503 pero `/health` en 200 | El detalle del chequeo que falla (lo dice el tablero) | Es una dependencia: PostgreSQL caído, cola inalcanzable o el bot sin token |
| «outbox de X sin publicar» | `systemctl status odontocrm@X`, disco | El publicador no corre (servicio caído) o el disco está lleno |
| «cola … trabajo(s) fallido(s)» | `journalctl -u odontocrm@reporting -n 100` (o el consumidor que sea) | Un evento con carga inválida: se corrige y se vuelve a publicar; los fallidos no se pierden |
| «cola de envíos atascada» | `/notificaciones` (bandeja), `journalctl -u odontocrm@notifications` | Los mensajes esperan al bot; revisa el token y la conexión |
| Poco disco | `df -h`, `du -sh /var/lib/odontocrm/storage /var/backups/odontocrm` | Vaciar respaldos viejos (`--retention N`, o `--clean`), mover radiografías, ampliar disco |
| Los PDF (récipe, reportes) fallan | `journalctl -u odontocrm@clinical -n 50`, `ldd` del navegador | Chromium sin dependencias o ruta mal puesta (`PLAYWRIGHT_BROWSERS_PATH`) |
| «el refresco del read model falló» | `journalctl -u odontocrm@reporting -n 50`, `POST /internal/v1/reporting/refresh` | Un refresco a mano lo arregla; si vuelve, mira el espacio en disco |
| Todo lento | `uptime`, `free -h`, `sudo -u postgres psql -c 'select * from pg_stat_activity'` | Reiniciar el servicio que consuma de más; revisar consultas lentas en el registro de PostgreSQL |

**Lo que no se hace nunca**: `db:reset`, `seed:test`, `drop database`, borrar
`/var/lib/odontocrm/storage` ni restaurar «para probar» sobre la base real. Este
servidor tiene datos de pacientes: cualquier cosa destructiva se ensaya antes en la
PC de pruebas.

---

### El restablecimiento (o el respaldo) se queda mudo

**Síntoma.** El comando no termina, no imprime nada nuevo y parece estar trabajando.
En el ensayo de la Fase 10 pasó con el restablecimiento: se quedó **un minuto y medio
esperando la contraseña** del rol administrador, que no estaba en
`/etc/odontocrm/.pgpass`. Peor aún: como la terminal seguía ocupada por ese proceso,
los comandos siguientes no hacían nada y todo parecía «no avanzar».

**Qué mirar, en este orden:**

```bash
pgrep -af '[o]dontocrm-restore|[o]dontocrm-backup|[e]nsayo-despliegue'   # ¿hay algo vivo?
psql -d "postgres:///postgres?host=/var/run/postgresql" \
  -c "select pid, state, wait_event, left(query,60) from pg_stat_activity where datname is not null"
tail -20 /var/log/odontocrm/backup.log        # o restore_<fecha>.log
```

- Si `pg_stat_activity` **no** muestra bloqueos y el proceso sigue ahí, casi siempre es
  una **pregunta sin responder** (contraseña) o un `psql` esperando entrada. La
  solución está en las credenciales: `crear-rol-respaldo.sh --admin-role=<rol>` deja la
  línea del administrador en `/etc/odontocrm/.pgpass`.
- Los scripts ya **no preguntan** (`psql -w`): si falta la credencial, fallan en el acto
  diciendo qué falta. Si ves un proceso mudo, es de una versión anterior: actualiza el
  código desplegado (`git -C /opt/odontocrm log --oneline -1`).

**Cómo salir:**

```bash
sudo pkill -f '[o]dontocrm-restore'      # el proceso atascado
sudo pkill -f '[f]ase10-ensayo-fedora'   # y el ensayo que lo espera
sudo bash /opt/odontocrm/infra/fedora/backup/odontocrm-restore.sh --limpiar-verif --yes
```

**Para que no vuelva a pasar:** el ensayo tiene **testigo** (no admite dos a la vez), los
respaldos y restablecimientos corren con **tope de tiempo** (`timeout`), y si el código
desplegado no coincide con el del repositorio el ensayo **se para** en vez de probar
código viejo.

## 8. Actualizar el sistema

Dos caminos, y conviene saber cuál toca:

```bash
sudo odontocrm actualizar                      # rutina: trae, aplica unidades y plantillas,
                                               # compila, migra, reinicia y verifica
sudo bash infra/fedora/ensayo-despliegue.sh --hasta=servicios   # lo mismo, paso a paso y
                                               # con los secretos re-sincronizados
```

El **ensayo** es el que se usó para validar la fase 10 y el que deja evidencia; el
`actualizar` es el atajo para el día a día. Cuando la actualización toca algo sensible
(antes de que la clínica abra, o si vienes de cambiar certificados o unidades), usa el
ensayo: cuenta cada paso y comprueba en vez de suponer.

Con la clínica cerrada (o en la pausa del mediodía), y **siempre** con un respaldo
verificado del día:

```bash
cd /opt/odontocrm
sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh     # 1. respaldo
sudo git fetch --all --tags
sudo git checkout fase-N                                        # 2. la versión nueva
sudo npm ci                                                     # 3. dependencias
sudo npm run build                                              # 4. compilar
sudo odontocrm actualizar      # 5. trae el código, compila y aplica el esquema (idempotente)
sudo systemctl restart 'odontocrm@*' odontocrm-gateway.service # 6. reiniciar
sudo odontocrm verificar                                       # 7. comprobar
```

Si algo sale mal: `sudo git checkout fase-(N-1)`, `sudo npm ci && sudo npm run build`,
reiniciar. Las migraciones son hacia adelante; volver atrás en el código con la base
migrada funciona mientras la migración nueva no borre nada (ninguna lo hace: el
proyecto prohíbe las migraciones destructivas).

---

## 9. Registro y contactos

Anota aquí lo que pase, con fecha: cambios de versión, incidencias, restauraciones,
rotaciones de token.

| Fecha | Qué pasó | Qué se hizo | Quién |
| :--- | :--- | :--- | :--- |
| | | | |

- **Soporte técnico**: _(pendiente: nombre y teléfono)_
- **Odontóloga responsable**: _(pendiente)_
- **Proveedor de internet / red**: _(pendiente)_
