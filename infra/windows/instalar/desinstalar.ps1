# =============================================================================
# OdontoCRM · desinstalar el servidor de Windows (banco de pruebas)
#
#   .\desinstalar.ps1 --dry-run          # enseña lo que borraría; NO toca nada
#   .\desinstalar.ps1 --si               # lo hace
#   .\desinstalar.ps1 --si --conservar-datos   # no borra adjuntos, registros ni respaldos
#
# Quita el servicio de PM2, el de Caddy, las tareas programadas, el código, las reglas de
# firewall, los directorios de datos y las bases y los roles —y antes **guarda** los secretos
# y un `pg_dump` de cada base—.
#
# **Node.js, PostgreSQL y sus datos de instalación NO se tocan**, a propósito.
#
# Espejo de `infra/fedora/instalar/desinstalar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · desinstalar (Windows)

USO
  .\desinstalar.ps1 [--dry-run] [--si] [--conservar-datos]

OPCIONES
  --dry-run          Enseña lo que borraría; no toca nada.
  --si               Confirma la desinstalación (sin esto no se ejecuta).
  --conservar-datos  No borra adjuntos, registros ni respaldos (sí el código y los servicios).
'@

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }

$DryRun = Test-Bandera $args 'dry-run'
$AsumirSi = Test-Bandera $args 'si'
$ConservarDatos = Test-Bandera $args 'conservar-datos'
if (-not $DryRun) { Afirmar-Administrador }

if (-not $DryRun -and -not $AsumirSi) {
  Write-Host ''
  Escribir-Aviso 'esto BORRA el servicio, el proxy, las tareas, el código Y las bases de datos.'
  Escribir-Detalle 'antes guarda los secretos y un pg_dump de cada base.'
  Write-Host '  Si estás seguro:  .\desinstalar.ps1 --si'
  exit 10
}

$info = Get-Info
$sello = (Get-Date).ToString('yyyyMMdd-HHmmss')
$guardado = "C:\OdontoCRM-antes-de-desinstalar-$sello"

Write-Host ''
Write-Host 'OdontoCRM · desinstalar (Windows)' -ForegroundColor White
if ($DryRun) { Escribir-Aviso '--dry-run: no se borra nada' }

# ── 1. Guardar los secretos y las bases ──────────────────────────────────────
Escribir-Paso '1/7 · Guardar antes de borrar'
if ($DryRun) {
  Escribir-Detalle "[dry-run] guardaría $OdontoEnv y $OdontoTls en $guardado"
  Escribir-Detalle "[dry-run] y un pg_dump de cada base"
}
else {
  New-Item -ItemType Directory -Force -Path $guardado | Out-Null
  if (Test-Path $OdontoEnv) { Copy-Item -Recurse -Force $OdontoEnv (Join-Path $guardado 'env') }
  if (Test-Path $OdontoTls) { Copy-Item -Recurse -Force $OdontoTls (Join-Path $guardado 'tls') }
  Escribir-Ok "secretos guardados en $guardado"

  # Un volcado por base, por si alguien desinstala una instalación con pacientes dentro.
  # `$volcadoHecho` es la promesa del paso 5: si aquí no se pudo volcar NADA (falta pg_dump o
  # .pgpass), ninguna base se borrará después. Lo que falló base a base queda marcado en
  # `<base>.dump.error` y esa base concreta se conserva.
  $volcadoHecho = $false
  $pgDump = Join-Path (Get-PgBin) 'pg_dump.exe'
  $pgPass = Join-Path $OdontoEnv '.pgpass'
  if ((Test-Path $pgDump) -and (Test-Path $pgPass)) {
    $volcadoHecho = $true
    $anterior = $env:PGPASSFILE
    $env:PGPASSFILE = $pgPass
    $env:PGHOST = '127.0.0.1'; $env:PGPORT = '5432'; $env:PGUSER = 'odonto_backup'
    try {
      foreach ($base in $info.bases) {
        $destino = Join-Path $guardado "$base.dump"
        & $pgDump --format=custom --no-owner --no-privileges --file=$destino $base 2>$null
        if ($LASTEXITCODE -eq 0) { Escribir-Ok "guardado $base" }
        else {
          Escribir-Aviso "${base}: NO se pudo guardar (se deja sin borrar esa base)"
          # La copia es la única red: si falla, esa base no se borra.
          Set-Content -Path "$destino.error" -Value 'el pg_dump falló; la base NO se borró' -Encoding UTF8
        }
      }
    }
    finally {
      if ($null -eq $anterior) { Remove-Item Env:\PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $anterior }
      Remove-Item Env:\PGHOST, Env:\PGPORT, Env:\PGUSER -ErrorAction SilentlyContinue
    }
  }
  else { Escribir-Aviso 'no pude volcar las bases (faltan pg_dump o .pgpass); NO se borrarán' }
}

# ── 2. Tareas programadas ────────────────────────────────────────────────────
# Las CUATRO que registra tareas\registrar-tareas.ps1. Ojo con la trampa del 2026-10-14:
# aquí solo se borraban tres y «OdontoCRM · verificar respaldo» sobrevivía a la
# desinstalación (con su aviso semanal por el bot de administración).
Escribir-Paso '2/7 · Tareas programadas'
foreach ($n in @('OdontoCRM · respaldo diario', 'OdontoCRM · alertas', 'OdontoCRM · red', 'OdontoCRM · verificar respaldo')) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if ($t) {
    Invocar "retirar la tarea «$n»" { Unregister-ScheduledTask -TaskName $n -Confirm:$false }
    Escribir-Ok "tarea retirada: $n"
  }
  else { Escribir-Detalle "no existía: $n" }
}

# ── 3. Servicios (PM2 y Caddy) ───────────────────────────────────────────────
Escribir-Paso '3/7 · Servicios'
$svcPm2 = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svcPm2) {
  Invocar "detener y quitar el servicio de PM2 ($($svcPm2.Name))" {
    Stop-Service -Name $svcPm2.Name -Force -ErrorAction SilentlyContinue
    & sc.exe delete $svcPm2.Name | Out-Null
  }
  Escribir-Ok 'servicio de PM2 retirado'
}
else { Escribir-Detalle 'no hay servicio de PM2' }

# Los procesos de PM2 que quedaran vivos (con el `pm2` de la máquina, no el del usuario).
if (-not $DryRun) { & (Get-Pm2Cmd) kill *> $null 2>&1 }

# Los RESTOS de node-windows: `C:\ProgramData\pm2` (el wrapper `daemon\pm2.exe` + `pm2.xml`).
# Sin esto, la próxima instalación queda rota: node-windows decide «Already installed»
# mirando esos ARCHIVOS (no el servicio) y no crea ningún servicio —«Could not find "pm2.exe"
# service after 10 attempts»— (trampa real del 2026-10-15: el desinstalar dejaba los archivos
# y el reinstalar no creaba el servicio). También se retiran las variables de máquina que
# dejó `setup-service.ps1`.
$restosPm2 = 'C:\ProgramData\pm2'
if (Test-Path $restosPm2) {
  if ($DryRun) { Escribir-Detalle "[dry-run] borraría los restos de PM2: $restosPm2" }
  else {
    try {
      Remove-Item -Recurse -Force $restosPm2 -ErrorAction Stop
      Escribir-Ok "restos de PM2 retirados: $restosPm2"
    }
    catch {
      Escribir-Aviso "no pude borrar ${restosPm2}: $($_.Exception.Message)"
      Escribir-Detalle 'si quedan archivos, la próxima instalación los detecta y los retira sola'
    }
  }
}
if (-not $DryRun) {
  foreach ($v in @('PM2_HOME', 'PM2_INSTALL_DIRECTORY', 'PM2_SERVICE_DIRECTORY')) {
    if ([Environment]::GetEnvironmentVariable($v, 'Machine')) {
      [Environment]::SetEnvironmentVariable($v, $null, 'Machine')
      Escribir-Ok "variable de máquina retirada: $v"
    }
  }
}

$svcCaddy = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
if ($svcCaddy) {
  Invocar 'detener y quitar el servicio de Caddy' {
    Stop-Service -Name 'caddy' -Force -ErrorAction SilentlyContinue
    & sc.exe delete caddy | Out-Null
  }
  Escribir-Ok 'servicio de Caddy retirado'
}
else { Escribir-Detalle 'no hay servicio de Caddy' }

# ── 4. Firewall ──────────────────────────────────────────────────────────────
Escribir-Paso '4/7 · Firewall'
foreach ($regla in @('OdontoCRM Web (HTTP)', 'OdontoCRM Web (HTTPS)')) {
  if (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue) {
    Invocar "quitar la regla «$regla»" { Remove-NetFirewallRule -DisplayName $regla }
    Escribir-Ok "regla retirada: $regla"
  }
  else { Escribir-Detalle "no existía: $regla" }
}

# ── 5. Las bases y los roles ────────────────────────────────────────
Escribir-Paso '5/7 · Bases de datos y roles'
$psql = Join-Path (Get-PgBin) 'psql.exe'
# Si el administrador no vino por entorno, se PIDE la contraseña (oculta). Sin ella no se puede
# borrar ninguna base, y quedarse a medias es peor que preguntar.
$adminUrl = Resolver-AdminUrlPostgres -SinPreguntar:$DryRun `
  -Pregunta 'Para borrar las bases y los roles hace falta el administrador de PostgreSQL.'
if (-not $adminUrl) {
  Escribir-Aviso 'sin administrador de PostgreSQL no puedo borrar las bases ni los roles: hazlo a mano si quieres'
}
elseif ($DryRun) {
  Escribir-Detalle "[dry-run] borraría las bases: $($info.bases -join ', ')"
  Escribir-Detalle "[dry-run] y los roles: $(($info.servicios.base) -join ', '), odonto_events, odonto_backup"
}
else {
  # Como en Fedora (`desinstalar.sh` 5/6): UNA sentencia por objeto, con la salida del error a
  # la vista. Cuidado con la tentación del bloque `DO $$…$$`: corre como una transacción y
  # PostgreSQL responde «DROP DATABASE cannot run inside a transaction block» (25001) — así fue
  # como los pacientes de instalaciones anteriores sobrevivieron a una desinstalación
  # (2026-10-15), diera igual que hubieran entrado por el servidor o por `npm run dev`: las dos
  # pilas comparten las mismas bases `odonto_*`.
  $fallos = 0
  if (-not $volcadoHecho) {
    Escribir-Aviso 'no se pudo volcar NINGUNA base (faltaba pg_dump o .pgpass): NO se borra ninguna'
    $fallos++
  }
  else {
    foreach ($base in $info.bases) {
      if (Test-Path (Join-Path $guardado "$base.dump.error")) {
        Escribir-Aviso "no borro la base ${base}: su copia de seguridad falló (mira $guardado)"
        $fallos++
        continue
      }
      $salida = & $psql -X -q -w -v ON_ERROR_STOP=1 $adminUrl `
        -c "DROP DATABASE IF EXISTS `"$base`" WITH (FORCE);" 2>&1
      if ($LASTEXITCODE -eq 0) { Escribir-Ok "base $base borrada" }
      else {
        Escribir-Aviso "no pude borrar la base ${base}:"
        $salida | Select-Object -First 3 | ForEach-Object { Escribir-Detalle "  $_" }
        $fallos++
      }
    }
    # El rol solo se puede borrar cuando ya no es dueño de nada: por eso va DESPUÉS de sus bases.
    foreach ($rol in (@($info.servicios.base) + @('odonto_events', 'odonto_backup'))) {
      $salida = & $psql -X -q -w -v ON_ERROR_STOP=1 $adminUrl -c "DROP ROLE IF EXISTS `"$rol`";" 2>&1
      if ($LASTEXITCODE -eq 0) { Escribir-Detalle "rol $rol retirado" }
      else {
        Escribir-Aviso "no pude borrar el rol ${rol}:"
        $salida | Select-Object -First 3 | ForEach-Object { Escribir-Detalle "  $_" }
        $fallos++
      }
    }
  }
  if ($fallos -eq 0) { Escribir-Ok 'bases y roles retirados' }
  else { Escribir-Aviso "$fallos cosa(s) quedaron sin borrar (el motivo está arriba)" }
}

# ── 6. El comando del PATH ───────────────────────────────────────────────────
Escribir-Paso '6/7 · Comando del servidor'
$actual = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($actual -and (($actual -split ';') -contains $OdontoCmd)) {
  Invocar 'quitar la carpeta del comando del PATH de la máquina' {
    $nuevo = (($actual -split ';') | Where-Object { $_ -and $_ -ne $OdontoCmd }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $nuevo, 'Machine')
  }
  Escribir-Ok "retirado del PATH: $OdontoCmd"
}
else { Escribir-Detalle 'no estaba en el PATH' }

# ── 7. Los directorios ───────────────────────────────────────────────────────
Escribir-Paso '7/7 · Directorios'
$borrar = @()
if ($ConservarDatos) {
  Escribir-Aviso '--conservar-datos: se conservan data, logs y backups'
  $borrar += $OdontoCode      # el código sí se va (se puede volver a clonar)
  # Pero no data/logs/backups: se quitan de la lista antes de borrar.
}
else {
  $borrar += $OdontoCode
}
$borrar += $OdontoEtc

# Nunca borrar el directorio donde está parada la consola (en Windows se puede, pero deja
# cosas raras): se avisa.
foreach ($ruta in $borrar) {
  if (-not (Test-Path $ruta)) { Escribir-Detalle "no existe: $ruta"; continue }
  if ((Get-Location).Path -like "$ruta*") {
    Escribir-Aviso "tu consola está DENTRO de ${ruta}: cambia de carpeta y repite"
    Escribir-Detalle "    cd C:\  y vuelve a ejecutar"
    continue
  }
  if ($ConservarDatos -and $ruta -eq $OdontoCode) {
    # Se conserva lo que son datos del consultorio, pero se retira el código.
    Invocar "retirar el código de $OdontoCode (conservando data\logs\backups)" {
      Get-ChildItem -Path $OdontoCode -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin @('data', 'logs', 'backups') } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    Escribir-Ok "código retirado (data, logs y backups conservados en $OdontoCode)"
    continue
  }
  Invocar "borrar $ruta" { Remove-Item -Recurse -Force $ruta }
  Escribir-Ok "borrado: $ruta"
}

Write-Host ''
if ($DryRun) { Escribir-Ok 'simulación terminada: nada se ha borrado'; exit 0 }
Escribir-Ok "desinstalación terminada. Antes de borrar se guardó todo en $guardado"
Escribir-Detalle 'Node.js, PostgreSQL y sus datos de instalación NO se han tocado.'
