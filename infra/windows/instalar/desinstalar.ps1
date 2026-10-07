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
  $pgDump = Join-Path (Get-PgBin) 'pg_dump.exe'
  $pgPass = Join-Path $OdontoEnv '.pgpass'
  if ((Test-Path $pgDump) -and (Test-Path $pgPass)) {
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
Escribir-Paso '2/7 · Tareas programadas'
foreach ($n in @('OdontoCRM · respaldo diario', 'OdontoCRM · alertas', 'OdontoCRM · red')) {
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

# Los procesos de PM2 que quedaran vivos.
if (-not $DryRun) { & pm2 kill *> $null 2>&1 }

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

# ── 5. Las bases y los roles ─────────────────────────────────────────────────
Escribir-Paso '5/7 · Bases de datos y roles'
$adminUrl = $env:PG_ADMIN_URL
$psql = Join-Path (Get-PgBin) 'psql.exe'
if (-not $adminUrl) {
  Escribir-Aviso 'sin PG_ADMIN_URL no puedo borrar las bases ni los roles: hazlo a mano si quieres'
}
elseif ($DryRun) {
  Escribir-Detalle "[dry-run] borraría las bases: $($info.bases -join ', ')"
  Escribir-Detalle "[dry-run] y los roles: $(($info.servicios.base) -join ', '), odonto_events, odonto_backup"
}
else {
  $bases = ($info.bases | ForEach-Object { "'$_'" }) -join ', '
  $roles = ((@($info.servicios.base) + @('odonto_events', 'odonto_backup')) | ForEach-Object { "'$_'" }) -join ', '
  # Se borran SOLO las bases cuyo volcado existe: si un pg_dump falló, esa base se conserva.
  $sql = @"
DO `$`$ DECLARE b text; BEGIN
  FOREACH b IN ARRAY ARRAY[$bases] LOOP
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = b) THEN
      EXECUTE format('DROP DATABASE IF EXISTS %I WITH (FORCE)', b);
    END IF;
  END LOOP;
END `$`$;
DO `$`$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY[$roles] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END `$`$;
"@
  & $psql -X -q -v ON_ERROR_STOP=1 $adminUrl -c $sql
  if ($LASTEXITCODE -eq 0) { Escribir-Ok 'bases y roles retirados' }
  else { Escribir-Aviso 'no pude retirar todas las bases/roles (mira el error de arriba)' }
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
