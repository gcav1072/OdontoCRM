# =============================================================================
# OdontoCRM · Restauración de una base o de todas, desde un respaldo (Windows)
#
# QUÉ HACE (por cada base)
#   1. Localiza el volcado (--from acepta un directorio de respaldo o un .dump concreto)
#      y valida la cabecera PGDMP y el catálogo.
#   2. Comprueba la suma SHA-256 si el respaldo incluye SHA256SUMS.
#   3. RESTAURA A UNA BASE TEMPORAL  <base>__verif  para comprobar que el respaldo sirve,
#      SIN tocar la base real.
#   4. Solo si la verificación pasa, restaura sobre la base definitiva:
#        · cierra las conexiones abiertas,
#        · con --keep-old RENOMBRA la base actual a <base>__antes_de_restaurar_<fecha>,
#        · la recrea con el rol del servicio como propietario,
#        · restaura con --no-owner,
#        · ejecuta ANALYZE.
#   5. Informa qué se hizo y con qué código termina.
#
# USO
#   .\odontocrm-restore.ps1 --list
#   .\odontocrm-restore.ps1 --from C:\OdontoCRM\backups\2026-10-02 --all --dry-run
#   .\odontocrm-restore.ps1 --from …\2026-10-02 --db odonto_identity --keep-verify-db --yes
#   .\odontocrm-restore.ps1 --from …\2026-10-02 --db odonto_identity --keep-old --yes
#
# CÓDIGOS DE SALIDA
#   0 correcto · 1 configuración · 2 respaldo no encontrado/corrupto
#   3 falló la verificación (NO se tocó la base real) · 4 falló la restauración
#   5 la restauración terminó pero la comprobación posterior no pasó · 10 falta --yes
#
# Espejo de `infra/fedora/backup/odontocrm-restore.sh`.
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · restaurar (Windows)

USO
  .\odontocrm-restore.ps1 --list
  .\odontocrm-restore.ps1 --from <dir|dump> (--db NOMBRE | --all) [--dry-run] [--yes]
                           [--keep-old] [--keep-verify-db]

OPCIONES
  --list            Enseña los respaldos disponibles y sale.
  --from            Directorio de respaldo o archivo .dump concreto.
  --db NOMBRE       Restaura esa base (se puede repetir).  --all  todas.
  --keep-old        Conserva la base actual como <base>__antes_de_restaurar_<fecha>.
  --keep-verify-db  No borra la base temporal de verificación.
  --dry-run         Simula: dice exactamente qué haría, sin tocar nada.
  --yes             Confirma la restauración real (sin esto no se ejecuta).
'@

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }

$BackupDir = $OdontoBackups
$PgHost = '127.0.0.1'; $PgPort = 5432
$PgPassFile = Join-Path $OdontoEnv '.pgpass'
$PgAdminUser = 'postgres'   # usuario con permiso para DROP/CREATE DATABASE
$VerifySuffix = '__verif'
$OldSuffix = '__antes_de_restaurar'

$configFile = Join-Path $OdontoEnv 'backup.env'
if (Test-Path $configFile) {
  $v = Get-ValorEnv -Archivo $configFile -Clave 'BACKUP_DIR'; if ($v) { $BackupDir = $v }
  $v = Get-ValorEnv -Archivo $configFile -Clave 'PG_HOST'; if ($v) { $PgHost = $v }
  $v = Get-ValorEnv -Archivo $configFile -Clave 'PG_PORT'; if ($v) { $PgPort = [int]$v }
  $v = Get-ValorEnv -Archivo $configFile -Clave 'PGPASSFILE'; if ($v) { $PgPassFile = $v }
  $v = Get-ValorEnv -Archivo $configFile -Clave 'PG_ADMIN_USER'; if ($v) { $PgAdminUser = $v }
}

$From = Get-Argumento $args 'from'
$DbList = @(); foreach ($arg in $args) { if ($arg -like '--db=*') { $DbList += $arg.Substring(5) } }
$All = Test-Bandera $args 'all'
$DryRun = Test-Bandera $args 'dry-run'
$AsumirSi = Test-Bandera $args 'yes'
$ListOnly = Test-Bandera $args 'list'
$KeepVerify = Test-Bandera $args 'keep-verify-db'
$KeepOld = Test-Bandera $args 'keep-old'

$pgBin = Get-PgBin
function PgTool { param([string]$n) if ($pgBin) { return (Join-Path $pgBin "$n.exe") } return $n }
$psql = PgTool 'psql'; $pgRestore = PgTool 'pg_restore'

# Restaurar toca datos: hace falta Administrador (salvo para mirar o simular).
if (-not $DryRun -and -not $ListOnly) { Afirmar-Administrador }

# ── --list ───────────────────────────────────────────────────────────────────
if ($ListOnly) {
  Write-Host ''
  Write-Host "Respaldos en $BackupDir" -ForegroundColor White
  if (-not (Test-Path $BackupDir)) { Escribir-Aviso 'todavía no hay respaldos'; exit 0 }
  foreach ($d in @(Get-ChildItem -Path $BackupDir -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object Name -Descending)) {
    $dumps = @(Get-ChildItem -Path $d.FullName -Filter '*.dump' -File -ErrorAction SilentlyContinue)
    $mb = [math]::Round((($dumps | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Write-Host ("  {0}  {1} base(s)  {2} MB" -f $d.Name, $dumps.Count, $mb)
  }
  Write-Host ''
  exit 0
}

if (-not $All -and $DbList.Count -eq 0) { Morir 'indica qué restaurar: --all o --db <nombre> (mira --list)' }
if (-not $From) { Morir 'falta --from <directorio|dump>' }
if (-not (Test-Path $From)) { Morir "no encuentro $From" }

if ($All) {
  $DbList = @((Get-Info).bases)
}

# Entorno de conexión: la contraseña viaja por PGPASSWORD (desde .pgpass), nunca como
# argumento. Para restaurar hace falta el usuario ADMINISTRADOR (DROP/CREATE DATABASE).
function Env-PgAdmin {
  $entorno = @{ PGHOST = $PgHost; PGPORT = [string]$PgPort; PGUSER = $PgAdminUser; PGCONNECT_TIMEOUT = '15' }
  if (Test-Path $PgPassFile) { $entorno['PGPASSFILE'] = $PgPassFile }
  return $entorno
}
function ConEntorno {
  param([hashtable]$Entorno, [scriptblock]$Accion)
  $anterior = @{}
  foreach ($k in $Entorno.Keys) { $anterior[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item -Path "Env:\$k" -Value $Entorno[$k] }
  try { & $Accion } finally {
    foreach ($k in $Entorno.Keys) {
      if ($null -eq $anterior[$k]) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue } else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
}

function Ejecutar-Sql { param([string]$Sql)
  ConEntorno (Env-PgAdmin) { & $psql -X -q -v ON_ERROR_STOP=1 -d postgres -c $Sql } | Out-Null
}

function Test-VolcadoRapido {
  param([string]$Archivo, [string]$Etiqueta)
  if (-not (Test-Path $Archivo)) { Escribir-Error "${Etiqueta}: no existe"; return $false }
  $b = [IO.File]::ReadAllBytes($Archivo)
  if ($b.Length -lt 5) { Escribir-Error "${Etiqueta}: archivo vacío"; return $false }
  if ((-join ($b[0..4] | ForEach-Object { [char]$_ })) -ne 'PGDMP') { Escribir-Error "${Etiqueta}: cabecera no PGDMP"; return $false }
  & $pgRestore --list $Archivo *> $null
  if ($LASTEXITCODE -ne 0) { Escribir-Error "${Etiqueta}: catálogo ilegible"; return $false }
  Escribir-Ok "${Etiqueta}: volcado válido"
  return $true
}

$fallos = 0
foreach ($base in $DbList) {
  Write-Host ''
  Write-Host "== $base ==" -ForegroundColor Cyan

  # Localizar el volcado.
  $dump = $From
  if ((Get-Item $From).PSIsContainer) { $dump = Join-Path $From "$base.dump" }
  if (-not (Test-Path $dump)) { Escribir-Error "${base}: no encuentro el volcado ($dump)"; $fallos++; continue }

  # Comprobar la suma si hay SHA256SUMS junto al volcado.
  $sums = Join-Path (Split-Path $dump -Parent) 'SHA256SUMS'
  if (Test-Path $sums) {
    $nombre = Split-Path $dump -Leaf
    $esperada = (Select-String -Path $sums -Pattern ([regex]::Escape($nombre)) | Select-Object -First 1)
    if ($esperada) {
      $hash = ($esperada.Line -split '\s+')[0]
      $real = (Get-FileHash -Path $dump -Algorithm SHA256).Hash.ToLower()
      if ($real -ne $hash) { Escribir-Error "${base}: la suma SHA-256 NO coincide (respaldo corrupto)"; $fallos++; continue }
      Escribir-Ok "${base}: suma SHA-256 correcta"
    }
  }

  if (-not (Test-VolcadoRapido -Archivo $dump -Etiqueta $base)) { $fallos++; continue }

  $temp = "$base$VerifySuffix"
  $anteriorNombre = "$base$($OldSuffix)_$((Get-Date).ToString('yyyyMMddHHmmss'))"

  if ($DryRun) {
    Escribir-Detalle "[dry-run] restauraría a $temp para verificar, y luego sobre $base"
    if ($KeepOld) { Escribir-Detalle "[dry-run] con --keep-old renombraría $base → $anteriorNombre" }
    continue
  }

  # ── 1. Verificación en una base temporal (no toca la real) ─────────────────
  Escribir-Detalle "verificando en $temp (la base real no se toca)…"
  Ejecutar-Sql "DROP DATABASE IF EXISTS $temp"
  Ejecutar-Sql "CREATE DATABASE $temp"
  ConEntorno (Env-PgAdmin) { & $pgRestore --no-owner --dbname=$temp $dump *> $null }
  if ($LASTEXITCODE -ne 0) {
    Escribir-Error "${base}: la restauración de prueba falló: NO se tocó la base real"
    $fallos++; continue
  }
  Escribir-Ok "${base}: el respaldo se restaura correctamente (prueba en $temp)"

  # ── 2. Restauración definitiva ─────────────────────────────────────────────
  if (-not $AsumirSi) {
    Escribir-Aviso "${base}: falta --yes para restaurar sobre la base real (la prueba pasó)"
    $fallos++; continue
  }

  Escribir-Detalle 'cerrando conexiones y sustituyendo la base…'
  Ejecutar-Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$base' AND pid <> pg_backend_pid()"
  if ($KeepOld) {
    Ejecutar-Sql "ALTER DATABASE $base RENAME TO $anteriorNombre"
    Escribir-Ok "${base}: la base anterior quedó como $anteriorNombre"
  }
  else {
    Ejecutar-Sql "DROP DATABASE IF EXISTS $base WITH (FORCE)"
  }
  Ejecutar-Sql "CREATE DATABASE $base"
  ConEntorno (Env-PgAdmin) { & $pgRestore --no-owner --dbname=$base $dump *> $null }
  if ($LASTEXITCODE -ne 0) { Escribir-Error "${base}: falló la restauración sobre la base real"; $fallos++; continue }
  Ejecutar-Sql "ANALYZE $base"
  Escribir-Ok "${base}: restaurada"

  if (-not $KeepVerify) { Ejecutar-Sql "DROP DATABASE IF EXISTS $temp" }
}

Write-Host ''
if ($DryRun) { Escribir-Ok 'simulación terminada: nada se ha tocado'; exit 0 }
if ($fallos -gt 0) { Escribir-Error "$fallos base(s) con problemas"; exit 4 }
Escribir-Ok 'restauración correcta. Reinicia los servicios:  odontocrm reiniciar'
exit 0
