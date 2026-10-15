# =============================================================================
# OdontoCRM · crear el rol de respaldo y dejar lista la conexión (Windows)
#
#   .\crear-rol-respaldo.ps1 --admin-url="postgres://postgres:CLAVE@127.0.0.1:5432/postgres"
#   .\crear-rol-respaldo.ps1 --admin-url=… --rotar
#
# Deja el respaldo funcionando de una pasada: rol dedicado `odonto_backup` —sin
# superusuario— con permiso de LECTURA sobre todas las bases, `C:\ProgramData\OdontoCRM\env\.pgpass`
# y `backup.env` apuntando a esa conexión.
#
# **No imprime la contraseña**: se genera aquí, se escribe en los archivos que corresponden
# y no sale por la terminal.
#
# Espejo de `infra/fedora/backup/crear-rol-respaldo.sh`.
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Rol = 'odonto_backup'
$Rotar = Test-Bandera $args 'rotar'
$DryRun = Test-Bandera $args 'dry-run'
$AdminUrl = Get-Argumento $args 'admin-url'
if (-not $AdminUrl) { $AdminUrl = $env:PG_ADMIN_URL }
if (-not $DryRun) { Afirmar-Administrador }

if (-not $AdminUrl -and -not $DryRun) {
  # Si no vino por bandera ni por entorno, se PIDE (oculta, sin dejar rastro en el historial).
  $AdminUrl = Resolver-AdminUrlPostgres -Pregunta 'Para crear el rol de respaldo hace falta el administrador de PostgreSQL.'
  if (-not $AdminUrl) {
    Morir "sin administrador de PostgreSQL no puedo crear el rol de respaldo. Ejecútalo así:`n    .\crear-rol-respaldo.ps1            (pide la contraseña de postgres)`n    .\crear-rol-respaldo.ps1 --admin-url=`"postgres://postgres:TU_CLAVE@127.0.0.1:5432/postgres`""
  }
}

$psql = (Get-PgBin) ; if ($psql) { $psql = Join-Path $psql 'psql.exe' } else { $psql = 'psql' }$pgPass = Join-Path $OdontoEnv '.pgpass'
$backupEnv = Join-Path $OdontoEnv 'backup.env'
$info = Get-Info

Write-Host ''
Write-Host 'OdontoCRM · rol de respaldo (Windows)' -ForegroundColor White

# ── La contraseña: la que ya hubiera en .pgpass, o una nueva ─────────────────
$clave = $null
if ((Test-Path $pgPass) -and -not $Rotar) {
  $linea = Select-String -Path $pgPass -Pattern "^127\.0\.0\.1:5432:\*:${Rol}:" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($linea) {
    $clave = ($linea.Line -split ':')[4]
    Escribir-Aviso "el rol $Rol ya tiene contraseña en .pgpass: se reutiliza (usa --rotar para cambiarla)"
  }
}
if (-not $clave) {
  # Contraseña de 32 caracteres hexadecimales a partir de 16 bytes aleatorios (128 bits).
  # Ojo con la trampa que rompió la instalación del 2026-10-14: la base64 de 24 bytes da 32
  # caracteres PERO al quitar los símbolos (`+`, `/`, `=`) se queda a veces con MENOS de 32 y
  # `Substring(0, 32)` lanza «el índice y la longitud deben hacer referencia a una ubicación
  # en la cadena». El hex SIEMPRE tiene exactamente dos caracteres por byte: nunca falla.
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $clave = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

if ($DryRun) {
  Escribir-Detalle "[dry-run] crearía el rol $Rol y le daría LECTURA sobre: $($info.bases -join ', ')"
  Escribir-Detalle "[dry-run] escribiría $pgPass y $backupEnv"
  exit 0
}

# ── El SQL ───────────────────────────────────────────────────────────────────
$bases = ($info.bases | ForEach-Object { "'$_'" }) -join ', '
$sql = @"
-- Rol de respaldo: LOGIN, sin superusuario. Lee todas las bases.
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$Rol') THEN
    CREATE ROLE $Rol LOGIN;
  END IF;
END `$`$;
ALTER ROLE $Rol WITH PASSWORD '$clave';
-- pg_read_all_data (PG 14+): lectura de TODAS las tablas sin conceder una por una.
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_read_all_data') THEN
    GRANT pg_read_all_data TO $Rol;
  END IF;
END `$`$;
-- Y permiso de conexión a cada base del proyecto.
DO `$`$ DECLARE b text; BEGIN
  FOREACH b IN ARRAY ARRAY[$bases] LOOP
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = b) THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO $Rol', b);
    END IF;
  END LOOP;
END `$`$;
"@

# El SQL va por ARCHIVO (`psql -f`) y no por `-c`: PowerShell 5.1 entrega los argumentos de
# los comandos nativos en la codificación ANSI de la máquina, y un solo acento basta para que
# PostgreSQL responda «secuencia de bytes no válida para codificación "UTF8"» (fue la `ó` de
# «conexión» en un comentario, 2026-10-15: el rol de respaldo no se creó en una instalación
# limpia y el respaldo diario se quedaba sin rol). El archivo se escribe en UTF-8 y psql lo
# manda tal cual: los comentarios pueden seguir escribiéndose en español.
$sqlFile = Join-Path $env:TEMP "odontocrm-rol-respaldo-$PID.sql"
[IO.File]::WriteAllText($sqlFile, $sql, (New-Object System.Text.UTF8Encoding($false)))
try {
  & $psql -X -q -v ON_ERROR_STOP=1 $AdminUrl -f $sqlFile
  if ($LASTEXITCODE -ne 0) { Morir 'PostgreSQL rechazó la creación del rol (mira el error de arriba)' }
}
finally { Remove-Item -Path $sqlFile -Force -ErrorAction SilentlyContinue }
Escribir-Ok "rol $Rol creado/actualizado con permiso de lectura"

# ── .pgpass y backup.env ─────────────────────────────────────────────────────
# El formato de .pgpass: host:puerto:base:usuario:contraseña  (con `*` como comodín).
$lineaPgPass = "127.0.0.1:5432:*:${Rol}:$clave"
$otras = @()
if (Test-Path $pgPass) { $otras = @(Get-Content $pgPass | Where-Object { $_ -notlike "*:${Rol}:*" }) }
@($otras + $lineaPgPass) | Where-Object { $_ } | Set-Content -Path $pgPass -Encoding ASCII
Proteger-Archivo -Ruta $pgPass
Escribir-Ok "credencial escrita en $pgPass (solo Administradores)"

if (-not (Test-Path $backupEnv)) {
  $contenido = @(
    '# ─────────────────────────────────────────────────────────────────────────────',
    '# OdontoCRM · configuración de los respaldos (lo lee backup\odontocrm-backup.ps1)',
    '# ─────────────────────────────────────────────────────────────────────────────',
    "BACKUP_DIR=$OdontoBackups",
    'RETENTION_DAYS=30',
    "LOG_FILE=$(Join-Path $OdontoLogs 'backup.log')",
    "STORAGE_DIR=$OdontoStorage",
    "PGBIN_DIR=$(Get-PgBin)",
    'PG_HOST=127.0.0.1',
    'PG_PORT=5432',
    "PG_USER=$Rol",
    "PGPASSFILE=$pgPass",
    "DATABASES=`"$($info.bases -join ' ')`""
  ) -join "`n"
  Set-Content -Path $backupEnv -Value $contenido -Encoding UTF8
  Proteger-Archivo -Ruta $backupEnv
  Escribir-Ok "backup.env creado en $backupEnv"
}
else {
  Escribir-Ok 'backup.env ya existía: se conserva'
}

Escribir-Listo -Numero '' -Texto 'El respaldo queda funcionando.' -Siguiente 'odontocrm respaldar'
