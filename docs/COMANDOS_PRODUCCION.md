# Comandos de OdontoCRM en producción

> **Para quién es.** Para quien administra el servidor Fedora del consultorio (la
> doctora o la persona de sistemas). No hace falta saber programar: cada comando dice
> **qué hace**, **cómo se comprueba** y **qué significa lo que se ve**.
>
> Este documento es el hermano de [`COMANDOS.md`](COMANDOS.md), que es para **desarrollo**
> (levantar la pila, pruebas, seeds). Aquí solo hay lo que se usa en el servidor **con
> el sistema en marcha**. La operación del día a día está en
> [`../infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md) y la instalación desde cero
> en [`../infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md).

**Lo primero: casi todo se hace con un solo comando**, `odonocrm` vive en
`/usr/local/bin/odontocrm` (lo instala `install.sh`) y siempre se ejecuta con `sudo`:

```bash
sudo odontocrm            # la ayuda, con todas las órdenes
```

**Por qué `sudo`:** los archivos de entorno (`/etc/odontocrm/*.env`) son
`0600 root:root` —los lee systemd como root— y los servicios son unidades de sistema.
Sin `sudo`, el tablero **no puede** mirar la cola ni el outbox, y lo dice en vez de
inventarse problemas.

---

## Índice

1. [Los cinco minutos de la mañana](#1-los-cinco-minutos-de-la-mañana)
2. [Los servicios](#2-los-servicios)
2-bis. [Parar, recompilar y volver a arrancar](#2-bis-parar-recompilar-y-volver-a-arrancar)
3. [Actualizar el sistema](#3-actualizar-el-sistema)
4. [Respaldos y restauración](#4-respaldos-y-restauración)
5. [Usuarios y contraseñas](#5-usuarios-y-contraseñas)
6. [Equipos nuevos y el certificado](#6-equipos-nuevos-y-el-certificado)
7. [La base de datos](#7-la-base-de-datos)
8. [El bot de Telegram](#8-el-bot-de-telegram)
9. [Modo test](#9-modo-test)
10. [Diagnóstico rápido](#10-diagnóstico-rápido)
11. [Lo que NO se hace en producción](#11-lo-que-no-se-hace-en-producción)

---

## 1. Los cinco minutos de la mañana

```bash
sudo odontocrm estado
```

Una pantalla con: los 9 servicios (`/health` y `/ready`), las 9 unidades de systemd
(activas y sirviendo **su** puerto), las 9 bases con su tamaño, la cola de eventos, los
eventos sin publicar, los envíos y los reportes. Al final, **«nada que reportar»** es lo
que quieres ver.

```bash
sudo odontocrm alertas      # solo los problemas; sale con 1 si hay alguno
```

Esto último es lo que ejecuta el temporizador `odontocrm-alertas.timer` **cada 5
minutos**; si algo va mal, queda en `journalctl -u odontocrm-alertas`.

---

## 2. Los servicios

```bash
sudo odontocrm servicios                       # estado de las 10 unidades
sudo odontocrm verificar                       # unidad + puerto + /health y /ready de los 9
sudo odontocrm logs clinical                   # últimos 50 registros de un servicio
sudo odontocrm logs gateway 200                # 200 líneas del gateway
```

Con `systemctl` directamente (lo mismo, sin el atajo):

```bash
sudo systemctl status odontocrm@clinical --no-pager
sudo systemctl restart odontocrm@clinical      # reiniciar uno
sudo systemctl restart 'odontocrm@*'           # reiniciar los 8 servicios de datos
sudo systemctl restart odontocrm-gateway nginx # la puerta y el proxy
sudo journalctl -u odontocrm@clinical -f       # registros en vivo (Ctrl-C para salir)
sudo journalctl -u 'odontocrm@*' --since today --no-pager | tail -40
```

> **La regla de oro: un solo supervisor y una sola pila.** Si además levantas la pila de
> desarrollo (`npm run dev` en el repositorio), los dos conjuntos de procesos se pelean
> por los mismos puertos: los servicios de systemd caen en bucle y **`/health` responde
> igual** (lo contesta el otro). El tablero lo detecta y avisa.

---

## 2-bis. Parar, recompilar y volver a arrancar

En desarrollo esto es un comando (`npm run dev`), pero en el servidor hay **tres pasos
con orden y con `sudo`**: si se para a medias o se arranca en desorden, la clínica ve
errores que no lo son.

```bash
# 1) PARAR  (el gateway primero: es la puerta de entrada)
sudo odontocrm parar

# 2) COMPILAR  (TypeScript → dist/ y la SPA; no toca la base ni los servicios)
sudo odontocrm compilar
#    ¿hay además código nuevo en el repositorio? Entonces:  sudo odontocrm actualizar
#    (trae, compila, MIGRA y reinicia en un paso)

# 3) ARRANCAR  (en orden, y comprueba los 9)
sudo odontocrm arrancar
```

**Qué hace cada paso y por qué en ese orden**

| Paso | Comando | Qué pasa por dentro |
| :--- | :--- | :--- |
| Parar | `odontocrm parar` | `systemctl stop` del gateway y de los 8 servicios. **nginx y PostgreSQL se quedan** (el proxy dará 502 mientras tanto, que es lo correcto: algo tiene que contestar). Para pararlo **todo**: `sudo odontocrm parar --todo` |
| Compilar | `odontocrm compilar` | `npm ci` + `npm run build` dentro de `/opt/odontocrm`. Los servicios **siguen con el código viejo en memoria** hasta que se reinicien: por eso este paso va entre parar y arrancar |
| Arrancar | `odontocrm arrancar` | `systemctl start` de PostgreSQL y nginx si hicieran falta, luego los 8 servicios, y el gateway al final. Termina comprobando los 9 con `verificar` |

**Atajos que existen para no repetir:**

```bash
# Sirve con el sistema corriendo O parado (también tras `parar --todo`): levanta
# PostgreSQL y nginx si faltan, reinicia los 8 servicios, el gateway al final y verifica.
sudo odontocrm reiniciar     # aplicar cambios de configuración
sudo odontocrm recompilar    # compilar + reiniciar (código ya en /opt, sin migraciones)
sudo odontocrm actualizar    # traer del repositorio + compilar + migrar + reiniciar
```

**Bloque de parada y arranque de emergencia** (si el comando no estuviera instalado):

```bash
# Parar
sudo systemctl stop odontocrm-gateway
sudo systemctl stop 'odontocrm@identity' 'odontocrm@patients' 'odontocrm@scheduling' \
  'odontocrm@notifications' 'odontocrm@clinical' 'odontocrm@odontogram' \
  'odontocrm@screens' 'odontocrm@reporting'

# Arrancar
sudo systemctl start 'odontocrm@identity' 'odontocrm@patients' 'odontocrm@scheduling' \
  'odontocrm@notifications' 'odontocrm@clinical' 'odontocrm@odontogram' \
  'odontocrm@screens' 'odontocrm@reporting'
sudo systemctl start odontocrm-gateway
```

### Traducción: lo que hacías en desarrollo → lo que se hace en el servidor

| En desarrollo (`~/devp/OdontoCRM`) | En producción (`/opt/odontocrm`) |
| :--- | :--- |
| `npm run dev` | `sudo odontocrm arrancar` (unidades `systemd`, ya habilitadas) |
| `npm run stack:down` | `sudo odontocrm parar` |
| `npm run build` | `sudo odontocrm compilar` |
| `npm run stack:fijo` (PM2) | **No se usa**: el supervisor es systemd |
| `npm run db:migrate` | `sudo odontocrm con-entorno <servicio> -- node services/<servicio>/dist/db/migrate.js` (o `odontocrm actualizar`, que las corre todas) |
| `npm run seed:users` | `sudo odontocrm con-entorno identity -- node services/identity/dist/seed.js` |
| `npm run estado` | `sudo odontocrm estado` |
| `npm run e2e:clinica` | **No se ejecuta** contra la clínica: es una prueba de desarrollo |
| `npm run db:reset` | **Nunca.** Borra las 9 bases (§11) |
| `.env` de la raíz y de cada servicio | `/etc/odontocrm/*.env` (`0600 root:root`), y se reinicia el servicio |
| `http://127.0.0.1:5173` (Vite) | `https://odontocrm.local` o `https://<IP>` (nginx) |

> **Regla de oro:** nunca los dos a la vez. La pila de desarrollo y las unidades de
> `systemd` pelean por los mismos puertos: los servicios caen en bucle y `/health`
> responde igual (lo contesta el otro). El tablero lo detecta y lo dice.

---

## 3. Actualizar el sistema

```bash
sudo odontocrm actualizar
```

Hace los seis pasos en orden y termina verificando: trae el código nuevo, compila,
aplica las migraciones de los 8 servicios, reinicia y comprueba los 9.

**Si el código ya está en `/opt/odontocrm`** (por ejemplo lo copiaste o lo editaste ahí)
y solo hace falta que los servicios lo usen, esto compila y reinicia **sin tocar el
repositorio ni la base**:

```bash
sudo odontocrm recompilar
```

No aplica migraciones a propósito: si el cambio toca el esquema, usa `actualizar`.

**¿`actualizar` o el ensayo?** Los dos son válidos; hacen cosas distintas:

| Cuándo | Qué usar | Qué hace |
| :--- | :--- | :--- |
| **Actualización de rutina** (un arreglo, una mejora) | `sudo odontocrm actualizar` | Trae el código, pone al día **unidades, plantillas y temporizadores** (`install.sh`), compila, migra, reinicia y **verifica esperando** a que los 9 escuchen |
| **Quieres verlo paso a paso** | `sudo bash infra/fedora/ensayo-despliegue.sh --hasta=servicios` | Lo mismo **contando cada paso**, re-sincronizando los secretos desde el repositorio de trabajo y con el detalle de cada comprobación |
| **Cambios de despliegue** (TLS, firewall, SELinux, respaldos) | `… --hasta=respaldos` o `--hasta=tls` | Además: certificado, `nginx`, `firewalld`, SELinux, respaldo y **prueba de restauración comparada fila a fila** |

El ensayo es el que se usó para validar la fase 10 y es el que **deja evidencia**; por eso
el RUNBOOK lo prefiere cuando hay algo sensible de por medio (una actualización antes de
que la clínica abra, por ejemplo).

Equivalente a mano (por si hay que mirar el paso que falla):

```bash
cd /opt/odontocrm
sudo git config --global --add safe.directory /opt/odontocrm   # una sola vez
sudo git fetch --prune origin && sudo git checkout -B <rama> origin/<rama>
sudo git log --oneline -1                  # ¿qué versión va a quedar?
sudo npm ci && sudo npm run build
# Migraciones con el entorno de producción:
for s in identity patients scheduling notifications clinical odontogram screens reporting; do
  sudo odontocrm con-entorno "$s" -- node "services/$s/dist/db/migrate.js"
done
sudo systemctl restart 'odontocrm@*' odontocrm-gateway
sudo odontocrm verificar
```

### ¿Cómo se actualiza el propio comando del servidor?

`sudo odontocrm` es un **guion de bash** que vive en `/usr/local/bin/odontocrm` (una copia
del repositorio). `actualizar` lo reemplaza a mitad de camino, así que conviene saber qué
pasa con un guion que se actualiza **mientras se está ejecutando**:

| Caso | Qué ocurre |
| :--- | :--- |
| **Reemplazar el archivo** (lo que hacen `install`, `git checkout` o `sed -i`: crean un archivo nuevo y renombran) | bash conserva abierto el archivo original, así que **el proceso que corre termina sano con la versión vieja**. Nada se corrompe |
| **Reescribir en sitio** (`algo > guion.sh`) con el guion en ejecución | bash sigue leyendo del mismo archivo y el guion **se corta a media ejecución, en silencio** (medido: 720 de 2000 líneas, sin ningún error). Por eso los scripts del proyecto **nunca** se editan así |
| **Re-ejecutarse** (`exec "$0" …`) después de actualizar | el proceso se reemplaza y **los pasos que quedan ya usan la versión nueva** |

`actualizar` usa la tercera: trae el código, deja al día unidades y plantillas con
`install.sh` (que reemplaza el comando de forma segura) y luego **se re-ejecuta** con una
variable de guarda (`ODONTOCRM_REEXEC=1`, para no repetirlo). Así un arreglo en el propio
guion —por ejemplo en las migraciones o en `verificar`— **se aplica en esa misma
actualización**, no en la siguiente.

> No se puede «mantener el guion en RAM»: bash lo lee por bloques del archivo. La forma
> limpia de cambiar de versión a mitad de camino es reemplazar el archivo y re-ejecutarse,
> que es justo lo que hace.

### ¿Qué rama se despliega?

**La que ya tiene el despliegue, nunca otra por su cuenta.** `odontocrm actualizar`
mira en qué rama está `/opt/odontocrm` y la actualiza desde el origen: así una
actualización **no salta de rama sola** (nada de sorpresas del tipo «el servidor se
puso a correr una rama de trabajo»).

Para saber cuál es, y para cambiarla a propósito:

```bash
git -C /opt/odontocrm branch --show-current      # ¿qué rama corre el servidor?
sudo odontocrm actualizar                        # la actualiza (la misma)
sudo odontocrm actualizar --rama=main            # cambia a main y se queda en ella
```

El cambio de rama se usa al cerrar una fase (pasar de `fase/10-…` a `main`) o al
preparar algo en una rama aparte. Lo dice en pantalla cuando cambia.

En el **ensayo de despliegue** (`tmp/fase10-ensayo-fedora.sh`) el criterio es otro, y
también explícito: por defecto despliega **la rama que tengas activa en el repositorio
de trabajo** —la que estás mirando— y se puede forzar con `--rama=<nombre>`.

> **Antes de actualizar**: respaldo al día (`sudo odontocrm respaldar`) y avisar a la
> clínica de que se corta unos segundos. **Después**: `sudo odontocrm estado` y probar
> un acceso real (entrar y abrir la agenda).

---

## 4. Respaldos y restauración

```bash
sudo odontocrm respaldar                  # ahora mismo: 8 bases + /etc/odontocrm
ls -lh /var/backups/odontocrm/$(date +%Y-%m-%d)/
cat /var/backups/odontocrm/$(date +%Y-%m-%d)/manifest.txt
```

El respaldo diario de las **03:30** lo hace `odontocrm-backup.timer` (con
`Persistent=true`: si el servidor estaba apagado, lo hace al arrancar).

```bash
systemctl list-timers odontocrm-backup.timer      # ¿cuándo toca?
sudo journalctl -u odontocrm-backup -n 40 --no-pager
```

**Restaurar** (esto sí se hace con calma y leyendo el runbook):

```bash
sudo odontocrm restaurar --list                    # qué respaldos hay
sudo odontocrm restaurar --from /var/backups/odontocrm/2026-10-04 --all --yes --dry-run
sudo odontocrm restaurar --from /var/backups/odontocrm/2026-10-04 --all --yes --keep-verify-db
```

El restablecimiento **restaura primero a bases temporales `<base>__verif`** y solo
continúa si la verificación pasa; `--keep-old` conserva la base actual renombrada en
lugar de borrarla. Para retirar las temporales cuando ya no hagan falta:

```bash
sudo odontocrm restaurar --limpiar-verif --yes
```

> **El respaldo contiene secretos** (`--include-config` copia `/etc/odontocrm`): el
> medio externo tiene que ir cifrado o en un lugar protegido. La copia fuera del
> servidor es manual (`rsync` a un disco o a otro equipo); ver INSTALL §15.5.

---

## 5. Usuarios y contraseñas

```bash
# Restaurar las contraseñas temporales sembradas (admin, recepcion, egomez)
sudo odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset

# Ver quién existe y con qué rol (no imprime contraseñas)
sudo odontocrm con-entorno identity -- node -e "
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.query('select username, roles, must_change_password from users order by username'))
   .then((r) => { console.table(r.rows); return c.end(); });
"
```

En el día a día **no hace falta tocar esto**: las contraseñas se cambian desde la
aplicación (cada usuario, en su perfil) y el sistema obliga a cambiarlas en el primer
acceso. Lo de arriba es para el caso «nadie recuerda la del administrador».

> `con-entorno` carga `/etc/odontocrm/odontocrm.env` y el del servicio **dentro del
> proceso**: los secretos no aparecen en la línea de comandos (en `ps` los vería
> cualquiera de la máquina).

---

## 6. Equipos nuevos y el certificado

```bash
sudo odontocrm certificado                  # estado + archivos para copiar
sudo odontocrm certificado --exportar /tmp/ca
```

Y en el equipo nuevo (tablet, móvil, TV) se abre esta página **en ese equipo**:

```
http://<IP-del-servidor>/ca.crt
```

Por ejemplo `http://192.168.1.50/ca.crt` (la IP la imprime `sudo odontocrm certificado`).
Descarga un archivo pequeño que hay que **instalar como «autoridad de certificación»**;
después se cierra el navegador, se vuelve a abrir `https://odontocrm.local` (o la IP) y el
candado sale normal. Va por HTTP **a propósito**: hay que poder descargarlo antes de que
el equipo confíe en el certificado.

Los pasos por sistema operativo —**Android, iPhone/iPad, Windows, macOS, Linux (Arch,
Fedora, Ubuntu/Debian) y televisores**— están en
[`CERTIFICADO_EN_LOS_EQUIPOS.md`](CERTIFICADO_EN_LOS_EQUIPOS.md), y el comando los
resume en pantalla.

**Si esa página da «403 Forbidden» en texto plano**, la configuración es la vieja y
apunta a `/etc/odontocrm`: nginx corre como usuario `nginx` y ese directorio es
`0750 root:odontocrm`, así que **no puede ni atravesarlo**. La CA se publica en
`/var/www/odontocrm/ca/` (es un certificado público: no hay nada que proteger), y lo
deja el instalador del proxy. Se arregla igual:

```bash
# 1) Asegúrate de que /opt tiene el código nuevo (y de que el comando instalado no es
#    una copia vieja: `actualizar` ya se refresca a sí mismo).
sudo odontocrm actualizar

# 2) Regenera la configuración del proxy y publica la CA donde nginx puede leerla.
sudo bash /opt/odontocrm/infra/fedora/nginx/instalar.sh
curl -sI http://127.0.0.1/ca.crt | head -1     # 200 OK
```

**Si esa página dice «no encontrada»**, es que la configuración instalada de nginx es
anterior a que existiera `/ca.crt` (pasa tras actualizar el código: el archivo del
repositorio ya la trae, pero nginx sigue usando la copia vieja). Se arregla regenerándola
—es idempotente y no corta el servicio—:

```bash
sudo bash /opt/odontocrm/infra/fedora/nginx/instalar.sh
curl -sI http://127.0.0.1/ca.crt | head -1     # tiene que decir 200 OK
sudo odontocrm certificado                     # deja la CA y avisa si el proxy no la sirve
```

---

## 7. La base de datos

```bash
# Cuánto ocupa cada base y cuántas conexiones hay
sudo odontocrm estado | sed -n '/Bases de datos/,/Cola de eventos/p'

# Entrar a mirar (por el socket, como superusuario del sistema)
sudo -u postgres psql -d odonto_identity -c '\dt'
sudo -u postgres psql -d odonto_patients -c 'select count(*) from patients;'

# Migraciones de un servicio concreto (lo mismo que hace `actualizar`)
sudo odontocrm con-entorno clinical -- node services/clinical/dist/db/migrate.js

# Tamaño de cada tabla de una base
sudo -u postgres psql -d odonto_clinical -c "
  select relname, pg_size_pretty(pg_total_relation_size(oid)) as tamaño
  from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
  order by pg_total_relation_size(oid) desc limit 10;"
```

> **Nunca** se borra ni se renombra una base a mano con el sistema en marcha, y **nunca**
> se ejecuta `db:reset` ni un `drop database` en el servidor de la clínica. Para empezar
> de cero hay un procedimiento aparte (§11).

---

## 8. El bot de Telegram

```bash
sudo grep -c TELEGRAM_BOT_TOKEN /etc/odontocrm/notifications.env   # ¿está puesto? (no lo imprime)
sudo systemctl restart odontocrm@notifications
sudo odontocrm logs notifications 100
```

Para **rotar** el token (si se filtró): editar `TELEGRAM_BOT_TOKEN` en
`/etc/odontocrm/notifications.env` y reiniciar el servicio. Debe haber **un solo**
*poller*: si hay dos procesos con el mismo token, Telegram responde `409 Conflict`.

---

## 9. Modo test

```bash
sudo odontocrm modo-test estado
sudo odontocrm modo-test off        # lo normal en la clínica
```

En producción **tiene que estar en `off`**: el modo test existe para el banco de pruebas
(banner en la interfaz, datos ficticios y envíos simulados, ADR 0020). Con
`NODE_ENV=production` el sistema lo bloquea igualmente, y el comando lo avisa.

---

## 10. Diagnóstico rápido

| Síntoma | Qué mirar | Qué hacer |
| :--- | :--- | :--- |
| La clínica no entra | `sudo odontocrm verificar`, `systemctl status nginx` | Reiniciar proxy y puerta; si el certificado venció, reemitirlo (§6) |
| Una pantalla se quedó congelada | `sudo odontocrm verificar` (servicio `screens`), `sudo odontocrm logs screens` | Reiniciar `odontocrm@screens`; si se repite, mirar el SSE en el log de nginx |
| No llegan los avisos al bot | `sudo odontocrm logs notifications 100` | Ver que el token esté puesto y que no haya dos *pollers* (§8) |
| Los reportes no cuadran | `sudo odontocrm estado` → sección Reportes | Si el último refresco falló: `sudo odontocrm con-entorno reporting -- node -e "…"` o reiniciar el servicio |
| El servidor se reinició solo | `sudo odontocrm verificar` | Los servicios vuelven solos; si alguno no, `sudo systemctl restart 'odontocrm@*'` y revisar `journalctl -u <unidad> -n 50` |
| Algo va raro y no sé qué | `sudo odontocrm estado` (una pantalla) | Si sale «nada que reportar», el problema está en el equipo del usuario, no en el servidor |

---

## 11. Lo que NO se hace en producción

| No hagas esto | Por qué | Qué se hace en su lugar |
| :--- | :--- | :--- |
| `npm run dev` en el servidor | Se pelea por los puertos con systemd: los 9 servicios caen en bucle y `/health` miente | `sudo odontocrm estado` / `systemctl restart` |
| `npm run db:reset` | Borra las 9 bases (historia clínica incluida) | Restaurar un respaldo (§4) o el procedimiento de puesta a cero, con respaldo previo y autorización |
| `npm run seed:test` / `seed:demo` | Mete pacientes y citas ficticias en la base real | Nada: en producción no se siembran datos de ejemplo |
| `sudo odontocrm modo-test on` | Muestra datos ficticios y simula los envíos | `modo-test off` |
| Editar `services/*/.env` dentro de `/opt/odontocrm` | Los secretos viven en `/etc/odontocrm` (0600 root:root) | Editar `/etc/odontocrm/<servicio>.env` y reiniciar el servicio |
| Copiar `/etc/odontocrm` por chat o correo | Son las credenciales de la base, el JWT y el bot | El respaldo cifrado (§4) o `con-entorno` para usarlas sin verlas |
| Desactivar la validación del certificado | Quita la protección donde circulan los datos clínicos | Instalar la CA en el equipo (§6) |
| `npm audit fix --force` o actualizar dependencias | Puede cambiar el comportamiento sin pruebas | Actualización planificada + `npm run verify` en el repositorio de trabajo |

---

## Ver también

- [`../infra/fedora/RUNBOOK.md`](../infra/fedora/RUNBOOK.md) — la operación del día a día, con el porqué.
- [`../infra/fedora/INSTALL.md`](../infra/fedora/INSTALL.md) — instalación, verificación y registro de la Fase 10.
- [`COMANDOS.md`](COMANDOS.md) — los comandos de desarrollo (pila local, pruebas, seeds).
- [`OPERACION_CLINICA.md`](OPERACION_CLINICA.md) — la guía para el personal del consultorio (sin terminal).
