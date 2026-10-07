# =============================================================================
# OdontoCRM · Respaldo de las bases + copias opcionales (Windows)
#
#   .\odontocrm-backup.ps1 [--dry-run]
#   .\odontocrm-backup.ps1 --include-config --retention 30
#   .\odontocrm-backup.ps1 --db odonto_identity        # una sola base
#
# QUÉ HACE
#   1. Toma un candado para no solaparse con otra ejecución.
#   2. `pg_dump --format=custom` (-Fc) por CADA base, en un directorio con la fecha:
#        <destino>\AAAA-MM-DD\
#   3. Verifica la integridad de cada archivo:
#        · primeros 5 bytes == "PGDMP"
#        · `pg_restore --list` recorre el catálogo sin errores
#        · suma SHA-256 registrada en SHA256SUMS
#   4. Opcional: respalda la configuración (--include-config, CONTINENE SECRETOS) y el
#      almacenamiento (--include-storage).
#   5. Escribe manifest.txt (metadatos) y backup.log (registro).
#   6. Aplica la retención: borra los directorios con fecha de más de N días.
#
# NO HACE
#   · No toca ni modifica datos: solo lee. No restaura nada (usa odontocrm-restore.ps1).
#   · No cifra los respaldos: CONTIENEN DATOS CLÍNICOS y, con --include-config, secretos.
#
# CÓDIGOS DE SALIDA (los mismos que el guion de Fedora)
#   0 = correcto · 1 = configuración · 2 = falló un volcado · 3 = falló la verificación
#   4 = falló una copia opcional · 5 = falló la retención
#
# Espejo de `infra/fedora/backup/odontocrm-backup.sh`.
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · respaldo (Windows)

USO
  .\odontocrm-backup.ps1 [opciones]

OPCIONES
  --dest DIR            Directorio destino (por defecto: C:\OdontoCRM\backups).
  --retention N         Días de retención (por defecto: 30; 0 = no borrar nada).
  --db NAME             Respalda solo esa base (se puede repetir).
  --all                 Todas las bases (predeterminado).
  --include-config      Incluye C:\ProgramData\OdontoCRM (CONTINENE SECRETOS).
  --include-storage     Incluye los adjuntos (radiografías y PDFs).
  --no-verify           Omite `pg_restore --list` (solo para diagnóstico).
  --dry-run             Muestra lo que haría: no toma respaldos ni toca datos.
  --ayuda               Esta ayuda.
'@

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }

# ── Valores por defecto (los sobrescribe backup.env y los flags) ─────────────
$BackupDir = $OdontoBackups
$RetentionDias = 30
$LogFile = Join-Path $OdontoLogs 'backup.log'
$PgHost = '127.0.0.1'
$PgPort = 5432
$PgUser = 'odonto_backup'
$PgPassFile = Join-Path $OdontoEnv '.pgpass'
$StorageDir = $OdontoStorage
$ConfigDir = $OdontoEnv
$PgBinDir = ''
$DryRun = Test-Bandera $args 'dry-run'
$IncludeConfig = Test-Bandera $args 'include-config'
$IncludeStorage = Test-Bandera $args 'include-storage'
$NoVerify = Test-Bandera $args 'no-verify'
$DbList = @()
foreach ($arg in $args) { if ($arg -like '--db=*') { $DbList += $arg.Substring(5) } }
$dest = Get-Argumento $args 'dest'; if ($dest) { $BackupDir = $dest }
$ret = Get-Argumento $args 'retention'; if ($ret) { $RetentionDias = [int]$ret }
$cfg = Get-Argumento $args 'config'
$pgbinArg = Get-Argumento $args 'pgbin'; if ($pgbinArg) { $PgBinDir = $pgbinArg }

# backup.env: lo escribió 30-desplegar.ps1. Se lee SIN interpretarlo como código.
$configFile = if ($cfg) { $cfg } else { Join-Path $OdontoEnv 'backup.env' }
if ($configFile -and (Test-Path $configFile)) {
  foreach ($clave in @('BACKUP_DIR', 'RETENTION_DAYS', 'LOG_FILE', 'PG_HOST', 'PG_PORT', 'PG_USER', 'PGPASSFILE', 'STORAGE_DIR', 'PGBIN_DIR', 'DATABASES')) {
    $valor = Get-ValorEnv -Archivo $configFile -Clave $clave
    if ($valor) {
      switch ($clave) {
        'BACKUP_DIR' { if (-not $dest) { $BackupDir = $valor } }
        'RETENTION_DAYS' { if (-not $ret) { $RetentionDias = [int]$valor } }
        'LOG_FILE' { $LogFile = $valor }
        'PG_HOST' { $PgHost = $valor }
        'PG_PORT' { $PgPort = [int]$valor }
        'PG_USER' { $PgUser = $valor }
        'PGPASSFILE' { $PgPassFile = $valor }
        'STORAGE_DIR' { $StorageDir = $valor }
        'PGBIN_DIR' { if (-not $pgbinArg) { $PgBinDir = $valor } }
        'DATABASES' { if ($DbList.Count -eq 0) { $DbList = $valor -split '\s+' | Where-Object { $_ } } }
        default { }
      }
    }
  }
}

# Si no hay lista (no existe backup.env o no la trae), se DERIVA del repositorio. Estaba
# escrita a mano y con `billing` el respaldo se quedó sin las facturas **diciendo «sin
# errores»**; la lista sale de tools/servicios.mjs, que es la única fuente.
if ($DbList.Count -eq 0) {
  $info = Get-Info
  $DbList = @($info.bases)
}

# ── Utilidades ───────────────────────────────────────────────────────────────
$CodigoSalida = 0
function Registrar { param([string]$Nivel, [string]$Mensaje)
  $marca = (Get-Date).ToString('yyyy-MM-dd HH:mm:sszzz')
  $linea = "$marca [$Nivel] $Mensaje"
  switch ($Nivel) {
    'ERROR' { Write-Host $linea -ForegroundColor Red }
    'WARN' { Write-Host $linea -ForegroundColor Yellow }
    'OK' { Write-Host $linea -ForegroundColor Green }
    default { Write-Host $linea }
  }
  try {
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value $linea -ErrorAction SilentlyContinue
  }
  catch { }
}
function Info { param([string]$m) Registrar 'INFO' $m }
function Ok { param([string]$m) Registrar 'OK' $m }
function Aviso { param([string]$m) Registrar 'WARN' $m }
function Fallo { param([string]$m) Registrar 'ERROR' $m }

# ── `pg_dump` y compañía ─────────────────────────────────────────────────────
function Get-PgTool {
  param([string]$Nombre)
  $exe = if ($env:OS -eq 'Windows_NT') { "$Nombre.exe" } else { $Nombre }
  if ($PgBinDir -and (Test-Path (Join-Path $PgBinDir $exe))) { return (Join-Path $PgBinDir $exe) }
  $auto = Get-PgBin
  if ($auto -and (Test-Path (Join-Path $auto $exe))) { return (Join-Path $auto $exe) }
  $cmd = Get-Command $exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# El entorno de conexión: la contraseña va por PGPASSWORD (llenada desde .pgpass), nunca
# en la línea de comandos (en la lista de procesos la vería cualquiera de la máquina).
function Entorno-Pg {
  $entorno = @{
    PGHOST           = $PgHost
    PGPORT           = [string]$PgPort
    PGUSER           = $PgUser
    PGCONNECT_TIMEOUT = '15'
  }
  if (Test-Path $PgPassFile) { $entorno['PGPASSFILE'] = $PgPassFile }
  return $entorno
}

# ¿Existe la base? (una consulta al catálogo, sin conectar a ella)
function Test-BaseExiste {
  param([string]$Base)
  $psql = Get-PgTool 'psql'
  if (-not $psql) { return $false }
  $entorno = Entorno-Pg
  $anterior = @{}
  foreach ($k in $entorno.Keys) { $anterior[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item -Path "Env:\$k" -Value $entorno[$k] }
  try {
    $salida = & $psql --no-password -d postgres -tAc "select 1 from pg_database where datname = '$Base'" 2>$null
    return ($salida -eq '1')
  }
  finally {
    foreach ($k in $entorno.Keys) {
      if ($null -eq $anterior[$k]) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
}

# La versión del CLIENTE tiene que poder leer al SERVIDOR: `pg_dump` de una mayor anterior
# falla con «server version mismatch» en todas las bases, y si eso pasa de noche nadie se
# entera hasta que hace falta el respaldo. Se comprueba antes de empezar.
function Test-VersionCliente {
  $pgDump = Get-PgTool 'pg_dump'
  $psql = Get-PgTool 'psql'
  if (-not $pgDump -or -not $psql) { Aviso 'no encuentro pg_dump/psql: no puedo comprobar la versión'; return $true }
  $cliente = (& $pgDump --version 2>$null) -replace '[^0-9.]', '' -split '\.' | Select-Object -First 1
  $entorno = Entorno-Pg
  $anterior = @{}
  foreach ($k in $entorno.Keys) { $anterior[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item -Path "Env:\$k" -Value $entorno[$k] }
  try {
    $servidor = (& $psql --no-password -d postgres -tAc "select current_setting('server_version_num')" 2>$null) -replace '[^0-9]', ''
  }
  finally {
    foreach ($k in $entorno.Keys) {
      if ($null -eq $anterior[$k]) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
  if (-not $servidor) { Aviso 'no pude preguntar la versión del servidor'; return $true }
  $mayorServidor = [int]([math]::Floor([int]$servidor / 10000))
  if ([int]$cliente -lt $mayorServidor) {
    Fallo "pg_dump es de la versión $cliente y el servidor es de la ${mayorServidor}: fallaría en TODAS las bases"
    Escribir-Detalle 'usa --pgbin con la carpeta de binarios de PostgreSQL correcta'
    return $false
  }
  return $true
}

# Verifica un volcado: cabecera PGDMP y catálogo legible.
function Test-Volcado {
  param([string]$Archivo, [string]$Etiqueta)
  if (-not (Test-Path $Archivo)) { Fallo "${Etiqueta}: no existe el archivo"; return $false }
  $bytes = [IO.File]::ReadAllBytes($Archivo)
  if ($bytes.Length -lt 5) { Fallo "${Etiqueta}: el archivo está vacío"; return $false }
  $magic = -join ($bytes[0..4] | ForEach-Object { [char]$_ })
  if ($magic -ne 'PGDMP') { Fallo "${Etiqueta}: la cabecera no es PGDMP (archivo corrupto o incompleto)"; return $false }
  if ($NoVerify) { Ok "${Etiqueta}: cabecera PGDMP correcta (catálogo omitido: --no-verify)"; return $true }
  $pgRestore = Get-PgTool 'pg_restore'
  if (-not $pgRestore) { Aviso "${Etiqueta}: no encuentro pg_restore; salto la comprobación del catálogo"; return $true }
  & $pgRestore --list $Archivo *> $null
  if ($LASTEXITCODE -ne 0) { Fallo "${Etiqueta}: pg_restore no pudo leer el catálogo"; return $false }
  Ok "${Etiqueta}: cabecera y catálogo correctos"
  return $true
}

# ── Cuerpo ───────────────────────────────────────────────────────────────────
if (-not $DryRun) { Afirmar-Administrador }
if ($DryRun) { Aviso '--dry-run: no se toman respaldos ni se toca dato alguno' }

if (-not (Test-VersionCliente)) { exit 1 }

$pgDump = Get-PgTool 'pg_dump'
if (-not $pgDump) {
  Fallo 'no encuentro pg_dump: pasa --pgbin con la carpeta de binarios de PostgreSQL'
  exit 1
}

$fecha = (Get-Date).ToString('yyyy-MM-dd')
$runDir = Join-Path $BackupDir $fecha
$lockFile = Join-Path $BackupDir '.odontocrm-backup.lock'
$stream = $null

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  # Candado: en Windows no hay `flock`. Un archivo abierto en modo exclusivo cumple lo mismo:
  # si otra ejecución lo tiene, esta se retira en vez de escribir encima.
  try {
    $stream = [IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
  }
  catch {
    Aviso 'ya había otro respaldo en curso: no se hace nada'
    exit 0
  }
}
else {
  Info "[dry-run] prepararía $runDir"
}

Info "destino: $runDir · bases: $($DbList.Count) · retención: $RetentionDias días"

# ── Los volcados ─────────────────────────────────────────────────────────────
$fallosDump = 0
$archivos = @()
foreach ($base in $DbList) {
  $destino = Join-Path $runDir "$base.dump"
  if ($DryRun) {
    # En simulación no se pregunta si la base existe: sin credenciales (una máquina recién
    # preparada no tiene .pgpass) esa consulta fallaría y la simulación diría «no existe»,
    # que es engañoso. Aquí se enseña lo que se HARÍA.
    Escribir-Detalle "[dry-run] pg_dump -Fc $base → $destino"
    continue
  }
  if (-not (Test-BaseExiste $base)) { Aviso "${base}: no existe en este servidor, se salta"; continue }
  $entorno = Entorno-Pg
  $anterior = @{}
  foreach ($k in $entorno.Keys) { $anterior[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item -Path "Env:\$k" -Value $entorno[$k] }
  $errFile = Join-Path $env:TEMP "odontocrm-dump-$base.err"
  try {
    & $pgDump --format=custom --compress=6 --no-owner --no-privileges --file=$destino $base 2> $errFile
    $rc = $LASTEXITCODE
  }
  finally {
    foreach ($k in $entorno.Keys) {
      if ($null -eq $anterior[$k]) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
  if ($rc -ne 0) {
    Fallo "${base}: falló el volcado"
    Get-Content $errFile -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Escribir-Detalle $_ }
    $fallosDump++
  }
  else {
    $tam = [math]::Round((Get-Item $destino).Length / 1MB, 1)
    Ok "${base}: volcado (${tam} MB)"
    $archivos += $destino
  }
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
}

# ── Copias opcionales ────────────────────────────────────────────────────────
$fallosCopia = 0
function Comprimir-Carpeta {
  param([string]$Origen, [string]$DestinoZip, [string]$Etiqueta)
  if ($DryRun) { Escribir-Detalle "[dry-run] comprimir $Origen → $DestinoZip"; return 0 }
  try {
    if (Test-Path $DestinoZip) { Remove-Item $DestinoZip -Force }
    Compress-Archive -Path (Join-Path $Origen '*') -DestinationPath $DestinoZip -Force
    Ok "${Etiqueta}: copiado a $DestinoZip"
    return 0
  }
  catch {
    Fallo "${Etiqueta}: no pude comprimir ($($_.Exception.Message))"
    return 1
  }
}

if (-not $DryRun) {
  if ($IncludeConfig) {
    # CONTINENE SECRETOS: el archivo resultante va a un medio protegido, nunca suelto.
    $fallosCopia += Comprimir-Carpeta -Origen $ConfigDir -DestinoZip (Join-Path $runDir 'config.zip') -Etiqueta 'configuración (CON SECRETOS)'
  }
  if ($IncludeStorage) {
    $fallosCopia += Comprimir-Carpeta -Origen $StorageDir -DestinoZip (Join-Path $runDir 'storage.zip') -Etiqueta 'almacenamiento'
  }

  # ── Verificación e integridad ──────────────────────────────────────────────
  $fallosVerif = 0
  foreach ($archivo in $archivos) {
    if (-not (Test-Volcado -Archivo $archivo -Etiqueta ([IO.Path]::GetFileName($archivo)))) { $fallosVerif++ }
  }

  # SHA256SUMS de todo lo que hay en el directorio del día.
  $pendientes = @(Get-ChildItem -Path $runDir -File | Where-Object { $_.Name -ne 'SHA256SUMS' })
  $lineasSuma = foreach ($f in $pendientes) {
    $h = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($f.Name)"
  }
  $lineasSuma | Set-Content -Path (Join-Path $runDir 'SHA256SUMS') -Encoding ASCII
  Info "sumas SHA-256 escritas en $runDir\SHA256SUMS"

  # ── Manifiesto ─────────────────────────────────────────────────────────────
  $manifest = @(
    "odontocrm_backup_version=1",
    "fecha=$fecha",
    "equipo=$env:COMPUTERNAME",
    "usuario=$env:USERNAME",
    "destino=$runDir",
    "bases=$($DbList -join ' ')",
    "retencion_dias=$RetentionDias",
    "include_config=$IncludeConfig",
    "include_storage=$IncludeStorage",
    "archivos=$($pendientes.Count)"
  ) -join "`n"
  Set-Content -Path (Join-Path $runDir 'manifest.txt') -Value $manifest -Encoding UTF8
  Info "manifiesto escrito en $runDir\manifest.txt"

  # Comprobación final: releer las sumas.
  Push-Location $runDir
  try {
    $comprobar = Get-Content 'SHA256SUMS' | ForEach-Object {
      $partes = $_ -split '\s+', 2
      if ($partes.Count -eq 2) {
        $real = (Get-FileHash -Path $partes[1] -Algorithm SHA256).Hash.ToLower()
        if ($real -eq $partes[0]) { $true } else { Fallo "la suma de $($partes[1]) NO coincide"; $false }
      }
    }
    if ($comprobar -contains $false) { $fallosVerif++ }
    else { Ok 'las sumas SHA-256 coinciden' }
  }
  finally { Pop-Location }
}

# ── Retención ────────────────────────────────────────────────────────────────
$falloRetencion = 0
if ($RetentionDias -gt 0) {
  $limite = (Get-Date).AddDays(-$RetentionDias)
  $borrados = 0; $conservados = 0
  foreach ($d in @(Get-ChildItem -Path $BackupDir -Directory -ErrorAction SilentlyContinue)) {
    if ($d.Name -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }
    $fechaDir = [datetime]::MinValue
    if (-not [datetime]::TryParse($d.Name, [ref]$fechaDir)) { continue }
    if ($fechaDir -lt $limite) {
      if ($DryRun) { Escribir-Detalle "[dry-run] borraría $($d.FullName)"; $borrados++ }
      else {
        try { Remove-Item -Recurse -Force $d.FullName; $borrados++ }
        catch { Fallo "no pude borrar $($d.FullName): $($_.Exception.Message)"; $falloRetencion = 1 }
      }
    }
    else { $conservados++ }
  }
  $accion = if ($DryRun) { 'a eliminar' } else { 'eliminado(s)' }
  Info "retención: $borrados directorio(s) $accion, $conservados conservado(s) (límite $RetentionDias días)"
}
else { Info 'retención desactivada (--retention 0)' }

# Liberar el candado.
if ($null -ne $stream) { $stream.Close(); $stream.Dispose() }

# ── Resultado ────────────────────────────────────────────────────────────────
if ($DryRun) { Ok 'dry-run terminado: nada se ha tocado'; exit 0 }
if ($fallosDump -gt 0) { Fallo "$fallosDump base(s) fallaron al volcar"; exit 2 }
if ($fallosVerif -gt 0) { Fallo "$fallosVerif archivo(s) no pasaron la verificación"; exit 3 }
if ($fallosCopia -gt 0) { Fallo "$fallosCopia copia(s) opcional(es) fallaron"; exit 4 }
if ($falloRetencion -ne 0) { Fallo 'la retención no pudo borrar algún respaldo antiguo'; exit 5 }
Ok "respaldo completado sin errores ($runDir)"
exit 0
