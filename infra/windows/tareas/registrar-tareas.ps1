# =============================================================================
# OdontoCRM · tareas programadas de Windows (ADR 0050)
#
#   .\registrar-tareas.ps1 [--dry-run] [--quitar]
#
# Windows no tiene «timers» de systemd; el equivalente es el **Programador de tareas**.
# Se registran tres, las mismas que en Fedora:
#
#   1. OdontoCRM · respaldo diario    03:30 (hora local)  → odontocrm-backup.ps1 --include-config
#   2. OdontoCRM · alertas            cada 5 minutos      → node tools/estado.mjs --alertas
#   3. OdontoCRM · red                cada 5 minutos      → odontocrm red --arreglar --si-cambio
#
# Las tres corren como **SYSTEM** (es lo que Windows usa por defecto para una tarea que
# tiene que funcionar aunque nadie haya iniciado sesión). Por eso la preparación concede a
# SYSTEM permisos sobre las carpetas: sin eso, el respaldo de madrugada no podría escribir.
#
# Son idempotentes: si la tarea ya existe, se reemplaza por la definición de aquí.
#
# Espejo de `infra/fedora/systemd/odontocrm-{backup,alertas,red}.{service,timer}`.
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$DryRun = Test-Bandera $args 'dry-run'
$Quitar = Test-Bandera $args 'quitar'
if (-not $DryRun) { Afirmar-Administrador }

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$respaldo = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-backup.ps1'
$estado = Join-Path $OdontoRepo 'tools\estado.mjs'
$cli = Join-Path $OdontoRepo 'infra\windows\odontocrm.ps1'

Write-Host ''
Write-Host 'OdontoCRM · tareas programadas (Windows)' -ForegroundColor White

# ── --quitar: retirar las tres y salir ───────────────────────────────────────
$nombres = @('OdontoCRM · respaldo diario', 'OdontoCRM · alertas', 'OdontoCRM · red')
if ($Quitar) {
  foreach ($n in $nombres) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($t) {
      Invocar "quitar la tarea «$n»" { Unregister-ScheduledTask -TaskName $n -Confirm:$false }
      Escribir-Ok "tarea retirada: $n"
    }
    else { Escribir-Ok "no existía: $n" }
  }
  exit 0
}

# ── El motor: registrar (o reemplazar) una tarea idempotente ─────────────────
function Registrar-Tarea {
  param(
    [string]$Nombre,
    [string]$Descripcion,
    [string]$Programa,
    [string]$Argumentos,
    $Disparador
  )
  if ($DryRun) {
    Escribir-Detalle "[dry-run] registraría «$Nombre»"
    Escribir-Detalle "            $Programa $Argumentos"
    return
  }
  if (-not (Test-Path $Programa)) { Escribir-Aviso "no encuentro ${Programa}: no registro «$Nombre»"; return }

  $accion = New-ScheduledTaskAction -Execute $Programa -Argument $Argumentos -WorkingDirectory $OdontoCode
  # SYSTEM: funciona sin sesión iniciada; el respaldo de madrugada es el caso claro.
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)

  # Idempotente: si ya está, se reemplaza por la definición de aquí.
  if (Get-ScheduledTask -TaskName $Nombre -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $Nombre -Confirm:$false
  }
  Register-ScheduledTask -TaskName $Nombre -Description $Descripcion -Action $accion `
    -Trigger $Disparador -Principal $principal -Settings $ajustes | Out-Null
  Escribir-Ok "tarea registrada: $Nombre"
}

# ── Las tres tareas ──────────────────────────────────────────────────────────
# 1. Respaldo diario a las 03:30 (la clínica está cerrada y hay margen si tarda).
$disparadorRespaldo = New-ScheduledTaskTrigger -Daily -At '03:30'
Registrar-Tarea -Nombre 'OdontoCRM · respaldo diario' `
  -Descripcion 'Respaldo de las bases y de la configuración (CONTINENE SECRETOS).' `
  -Programa $powershell `
  -Argumentos "-NoProfile -ExecutionPolicy Bypass -File `"$respaldo`" --include-config" `
  -Disparador $disparadorRespaldo

# 2. Alertas cada 5 minutos: si algo no responde, el outbox se atasca o la cola tiene
#    fallidos, el tablero sale con código 1 y lo deja en el historial de la tarea.
#    Se invoca `node` directamente (no el CLI) para no depender de la comprobación de
#    Administrador dentro de una tarea, que es lo que hace frágil la alternativa.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  $disparadorAlertas = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(3) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  $env:ODONTOCRM_ENV_DIR = $OdontoEnv
  # El entorno se pasa por el archivo de configuración del CLI; aquí basta con la variable
  # de máquina, que SYSTEM hereda.
  if (-not $DryRun) {
    $actual = [Environment]::GetEnvironmentVariable('ODONTOCRM_ENV_DIR', 'Machine')
    if ($actual -ne $OdontoEnv) {
      [Environment]::SetEnvironmentVariable('ODONTOCRM_ENV_DIR', $OdontoEnv, 'Machine')
      Escribir-Ok "ODONTOCRM_ENV_DIR=$OdontoEnv fijado a nivel de máquina"
    }
  }
  Registrar-Tarea -Nombre 'OdontoCRM · alertas' `
    -Descripcion 'Comprueba el estado del sistema cada 5 minutos; falla si hay algún problema.' `
    -Programa $node `
    -Argumentos "`"$estado`" --alertas" `
    -Disparador $disparadorAlertas
}
else { Escribir-Aviso 'no encuentro node: no registro la tarea de alertas' }

# 3. La red, sola: cada 5 minutos reajusta firewall, certificado, CORS y proxy si la IP
#    cambió. Con `--si-cambio` no hace nada mientras la red no cambie.
$disparadorRed = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
Registrar-Tarea -Nombre 'OdontoCRM · red' `
  -Descripcion 'Adapta firewall, certificado, CORS y proxy cuando cambia la IP de la LAN.' `
  -Programa $powershell `
  -Argumentos "-NoProfile -ExecutionPolicy Bypass -File `"$cli`" red --arreglar --si-cambio" `
  -Disparador $disparadorRed

Write-Host ''
if ($DryRun) { Escribir-Ok 'dry-run terminado: nada se ha registrado'; exit 0 }
Get-ScheduledTask -TaskName 'OdontoCRM*' -ErrorAction SilentlyContinue |
  Format-Table TaskName, State -AutoSize
Escribir-Ok 'las tres tareas quedan registradas (míralas en taskschd.msc)'
