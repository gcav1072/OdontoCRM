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
en el primer acceso.

## 6. El bot de Telegram y WhatsApp

Se editan en `C:\ProgramData\OdontoCRM\env\notifications.env` y se reinicia el servicio:

```powershell
notepad C:\ProgramData\OdontoCRM\env\notifications.env
pm2 restart odontocrm-notifications
```

Sin token, `TELEGRAM_MODE=auto` usa el bot simulado: los avisos quedan como pendientes
manuales y la clínica sigue funcionando.

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
| Los PDF fallan | Falta Chromium: `.\40-verificar.ps1` lo señala; repite `30-desplegar.ps1` |
| El respaldo dice «no existe en este servidor» | Falta `.pgpass`/`backup.env`: `crear-rol-respaldo.ps1 --admin-url=…` |
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
