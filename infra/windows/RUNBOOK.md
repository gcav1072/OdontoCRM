# OdontoCRM — RUNBOOK del servidor Windows

Operación del día a día del servidor de la consulta. Para instalarlo, mira
[`INSTALL.md`](INSTALL.md). Todos los comandos, en una consola de **Administrador**.

## 1. Cómo está corriendo todo

| Pieza | Cómo se llama | Se mira con |
| :--- | :--- | :--- |
| Los 11 procesos Node | aplicaciones PM2 `odontocrm-*` | `pm2 status` · `odontocrm servicios` |
| El supervisor | servicio de Windows `pm2` (una sola vez) | `Get-Service pm2*` |
| El proxy | servicio de Windows `caddy` | `Get-Service caddy` |
| La base | servicio `postgresql-x64-18` | `Get-Service postgresql*` |
| Tareas | Programador de tareas | `Get-ScheduledTask -TaskName 'OdontoCRM*'` |

## 2. Lo primero cuando algo va mal

```powershell
odontocrm alertas      # solo lo que está mal; sale con 1 si hay algo
odontocrm verificar    # los procesos, HTTPS, la CA y el firewall
odontocrm estado       # el tablero completo
```

El orden importa: `alertas` dice **si** hay un problema; `verificar` dice **dónde**.

## 3. Reiniciar sin perder nada

```powershell
odontocrm reiniciar    # todos los servicios (aplica configuración y arranca lo que falte)
```

`reiniciar` también sirve si antes se paró todo con `odontocrm parar --todo`: levanta
PostgreSQL y Caddy y luego reinicia los servicios.

## 4. Actualizar a la versión nueva

```powershell
odontocrm actualizar            # trae la rama del despliegue y vuelve a desplegar
odontocrm actualizar --rama=main
```

`actualizar` trae el código, compila, aplica migraciones, reinstala el servicio y pone al día
certificado y proxy. **No toca las credenciales** (ADR 0043): para rotarlas está
`20-aprovisionar.ps1 --rotate`, a propósito.

## 5. Usuarios

La instalación crea solo `admin`. El resto del personal se da de alta desde **/usuarios**.
Para sembrar cuentas a mano:

```powershell
$env:SEED_PASSWORD_ADMIN='LA_CLAVE'
odontocrm con-entorno identity -- node services/identity/dist/seed.js --usuarios=admin,recepcion
```

El seed **omite los que ya existen** (sin `--reset`). El sistema pide cambiar la contraseña
en el primer acceso. **Sin `--usuarios=`, el seed siembra el juego completo** (admin +
`recepcion` + los odontólogos de `CLINIC.dentists`): en el servidor se llama **con
`--usuarios=admin`**.

Si una instalación vieja dejó sembradas las **cuentas de prueba**, se retiran con:

```powershell
odontocrm purgar-prueba             # enseña qué haría (no toca nada)
odontocrm purgar-prueba --si        # las DESACTIVA (por defecto)
odontocrm purgar-prueba --si --borrar   # las elimina
```

## 6. El bot de Telegram y WhatsApp

Se editan en `C:\ProgramData\OdontoCRM\env\notifications.env` y se reinicia el servicio:

```powershell
notepad C:\ProgramData\OdontoCRM\env\notifications.env
pm2 restart odontocrm-notifications
```

Sin token, `TELEGRAM_MODE=auto` usa el bot simulado: los avisos quedan como pendientes
manuales y la clínica sigue funcionando.

**WhatsApp por Baileys** no usa token: se enciende en **Configuración → Canales** y se vincula
con un QR o un código desde el teléfono del consultorio. La sesión Signal se cifra en
`odonto_notifications` con `STORAGE_ENCRYPTION_KEY`. Para operarlo:

```powershell
odontocrm whatsapp estado
odontocrm whatsapp vincular
odontocrm whatsapp reconectar
odontocrm whatsapp cerrar
```

Si la sesión se cierra (el teléfono la desvinculó), vuelve a vincular. Si aparece **reemplazada**,
hay otra instancia usando el mismo número: nunca compartas el número entre desarrollo y producción.
Cloud API sigue disponible como proveedor alternativo en el panel; solo entonces se usan sus
cuatro variables y el webhook.

## 7. Respaldos

```powershell
odontocrm respaldar                                   # ahora, con la configuración
.\infra\windows\backup\odontocrm-restore.ps1 --list   # qué hay
```

La tarea **OdontoCRM · respaldo diario** corre a las 03:30 como SYSTEM. Los respaldos viven en
`C:\OdontoCRM\backups\<AAAA-MM-DD>\` con `SHA256SUMS` y `manifest.txt`.

**Los respaldos contienen datos clínicos y secretos**: cópialos a un medio protegido.

### Probar una restauración (no destructiva)

```powershell
.\infra\windows\backup\odontocrm-restore.ps1 --from C:\OdontoCRM\backups\2026-10-06 `
     --db odonto_identity --keep-verify-db --dry-run
```

Sin `--dry-run` y **sin** `--yes`, restaura a una base temporal de verificación y **no toca la
base real**: es la forma de comprobar que un respaldo sirve.

### Recuperación completa: servidor nuevo o fallo físico

> La guía única (los tres casos, qué trae el respaldo y qué no) está en
> [`docs/RECUPERACION.md`](../../docs/RECUPERACION.md). Aquí va el comando y el paso a paso de
> este servidor.

El respaldo diario trae **tres cosas**, y hay que reponer las tres:

| Archivo | Qué lleva |
| :--- | :--- |
| `odonto_<base>.dump` | Una base cada una (el esquema y los datos) |
| `storage.zip` | El **almacén**: radiografías y PDFs |
| `config.zip` | La configuración (y los **secretos**) |

> **Base y almacén van juntos.** Si el almacén está cifrado y lo restauras sin la
> configuración (sin el `STORAGE_ENCRYPTION_KEY`), los archivos quedan **ilegibles**. Y un
> respaldo hecho antes de que el almacén entrara en la copia diaria **no lo trae**: compruébalo
> antes de dar el desastre por resuelto.

**En un comando** (para los servicios → restaura las bases → repone el almacén → arranca):

```powershell
# En una máquina nueva, primero el instalador (crea roles, bases vacías y servicios):
powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1

# Recuperación completa desde el pendrive o la carpeta del respaldo:
odontocrm recuperar --from C:\OdontoCRM\backups\2026-10-12 --yes
```

`recuperar` **no toca la configuración** a propósito: los `.env` del respaldo son de la máquina
**anterior** y pisarían las contraseñas que el instalador acaba de crear (los servicios no
conectarían). Si lo necesitas, añade `--con-config`. Sin `--yes` solo dice qué haría; con
`--dry-run` no toca nada.

> **Si el respaldo que hay es la copia completa del bot** (la que deja `/respaldo` en
> `C:\OdontoCRM\data\respaldo-manual\<marca>\`), vale igual: tiene los tres bloques y los mismos
> nombres, así que `odontocrm recuperar --from <esa carpeta> --yes` la repone tal cual
> ([`docs/RECUPERACION.md` §3b](../../docs/RECUPERACION.md)).

> **Base y almacén van juntos.** Si el almacén está cifrado, el `STORAGE_ENCRYPTION_KEY` tiene
> que ser el MISMO con que se cifró: `recuperar` y `odontocrm restaurar --all` **reconcilian la clave
> solos** (copian solo esa línea del respaldo a los `.env`) y comprueban que un documento se
> descifra. Y un respaldo hecho antes de que el almacén entrara en la copia diaria **no lo trae**
> (`--include-storage`): compruébalo antes de dar el desastre por resuelto.

**Paso a paso** (si prefieres verlo, o si `recuperar` falló en algo):

```powershell
# 1) Verifica el respaldo ANTES de tocar nada (SHA-256 de TODO el respaldo)
node tools\verify-backup.mjs --from C:\OdontoCRM\backups\2026-10-12 --estado

# 2) Para la pila (PostgreSQL se queda arriba: la restauración necesita conectarse)
odontocrm parar

# 3) Bases (ensaya en base temporal; --keep-old conserva la anterior).
#    Con `--all` repone ADEMÁS el almacén, reconcilia su clave y reinicia los servicios.
odontocrm restaurar --from C:\OdontoCRM\backups\2026-10-12 --all --keep-old --yes

# 4) Almacén (radiografías y PDFs) → C:\OdontoCRM\data\storage
Expand-Archive -Path C:\OdontoCRM\backups\2026-10-12\storage.zip -DestinationPath C:\OdontoCRM\data\storage -Force

# 5) Configuración y secretos — el zip trae el CONTENIDO de la carpeta `env`, así que se
#    extrae EN `env` (no en el padre):
Expand-Archive -Path C:\OdontoCRM\backups\2026-10-12\config.zip -DestinationPath C:\ProgramData\OdontoCRM\env -Force
# los .env vueltos a poner pierden la ACL: vuelve a protegerlos (Administradores + LocalService)

# 6) Arranca y verifica
odontocrm arrancar
```

> **Si el respaldo es de un esquema anterior**, tras restaurar hay que aplicar las migraciones
> (`odontocrm actualizar`). Y si repusiste la configuración de otra máquina, revisa las **rutas**
> de los `.env` (el almacén y las claves JWT cambian de sitio entre servidores); los `.env`
> vueltos a poner hay que **volver a protegerlos** (ACL de Administradores + LocalService).

## 8. Ver logs

```powershell
odontocrm logs clinical 100     # un servicio
odontocrm logs gateway
odontocrm logs caddy
pm2 logs odontocrm-clinical
```

Los logs en archivo están en `C:\OdontoCRM\logs\`.

## 9. El certificado

```powershell
odontocrm certificado           # lo muestra y dice cómo instalarlo en cada aparato
odontocrm red --arreglar        # reemite el certificado con la IP de ahora (misma CA)
```

Si el servidor cambia de red, la tarea **OdontoCRM · red** lo arregla sola cada 5 minutos. Los
equipos que ya tengan la CA instalada **no tienen que hacer nada** (es la misma CA).

## 10. Parar y arrancar

```powershell
odontocrm parar             # los servicios (Caddy y PostgreSQL siguen)
odontocrm parar --todo      # también Caddy y PostgreSQL: sistema completamente parado
odontocrm arrancar          # lo que falte
```

## 11. Modo test

```powershell
odontocrm modo-test estado
odontocrm modo-test on      # con NODE_ENV=production sigue bloqueado (ADR 0020)
odontocrm modo-test off
```

## 12. Fallos típicos y su causa

| Qué se ve | Qué mirar |
| :--- | :--- |
| Un servicio no responde | `pm2 logs odontocrm-<servicio> --lines 80` y `/ready` (dice **qué** chequeo falla: base, cola, …) |
| `502` desde la LAN pero `https://127.0.0.1` va | `pm2 status` y `Get-NetFirewallRule -DisplayName 'OdontoCRM Web (HTTPS)'` |
| Un proceso en bucle por `EADDRINUSE` | Hay **otra pila** usando los puertos: `npm run stack:status`. Solo un dueño de los puertos (ADR 0037) |
| `/ready` con `database` en error | `Get-Service postgresql-x64-18` |
| Los PDF fallan | `.\40-verificar.ps1` lo señala («Los imprimibles»): falta Chromium (repite `30-desplegar.ps1`) o «EPERM … mkdtemp» — el `%TEMP%` heredado de la consola del administrador, que LocalService no puede escribir; la pieza 3 fija los temporales en `data\tmp` y basta repetirla |
| El respaldo dice «no existe en este servidor» | Falta `.pgpass`/`backup.env`: `crear-rol-respaldo.ps1` (pide la contraseña de `postgres`) |
| La cola crece y no baja | `odontocrm estado`: ¿el outbox se atasca? ¿la cola tiene fallidos? |
| Nadie entra desde fuera | La red de Windows debe estar en perfil **Privado** |

## 13. Un solo dueño de los puertos

En esta máquina **no** conviven la pila de desarrollo y la de producción: los dos quieren los
mismos puertos (ADR 0037). Si vas a desarrollar en el mismo equipo, para el servidor primero:

```powershell
odontocrm parar --todo
# … y luego, en el repositorio de trabajo:
npm run stack:fijo
```
