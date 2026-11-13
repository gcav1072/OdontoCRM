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
#        · la recrea con el ROL DEL SERVICIO como propietario (ROLE_<base> en backup.env,
#          o el nombre de la base),
#        · restaura con --no-owner --role=<rol>, así las tablas quedan del servicio y sus
#          migraciones pueden aplicar (si quedan de postgres fallan con 42501),
#        · ejecuta ANALYZE dentro de la base y verifica la propiedad de las tablas.
#   5. Informa qué se hizo y con qué código termina.
#
# USO
#   .\odontocrm-restore.ps1 --list
#   .\odontocrm-restore.ps1 --from C:\OdontoCRM\backups\2026-10-02 --all --dry-run
#   .\odontocrm-restore.ps1 --from …\2026-10-02 --db odonto_identity --keep-verify-db --yes
#   .\odontocrm-restore.ps1 --from …\2026-10-02 --db odonto_identity --keep-old --yes
#
# CLAVE DE POSTGRES
#   Se pide **una sola vez** al empezar (si `postgres` no tiene entrada en `.pgpass`)
#   y se usa para todas las conexiones de la restauración. También vale definir
#   PGPASSWORD o añadir la entrada a `.pgpass`.
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
  .\odontocrm-restore.ps1 --solo-clave --from <dir>   (solo la clave del almacén)
                           [--keep-old] [--keep-verify-db]

OPCIONES
  --list            Enseña los respaldos disponibles y sale.
  --from            Directorio de respaldo o archivo .dump concreto.
  --db NOMBRE       Restaura esa base (se puede repetir).  --all  todas.
  --keep-old        Conserva la base actual como <base>__antes_de_restaurar_<fecha>.
  --keep-verify-db  No borra la base temporal de verificación.
  --solo-clave      Solo reconcilia la clave del almacén con la del respaldo, sin tocar
                    las bases. Para cuando WhatsApp no reconecta o el panel no lee los
                    canales tras restaurar sin la configuración.
  --dry-run         Simula: dice exactamente qué haría, sin tocar nada.
  --yes             Confirma la restauración real (sin esto no se ejecuta).

La clave del usuario postgres se pide UNA sola vez (o se toma de PGPASSWORD/.pgpass).
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
# `--db NOMBRE` (lo que dice la ayuda), `--db=NOMBRE` y con uno o dos guiones; repetible.
# Antes solo entendía `--db=…` y la ayuda mentía (2026-11-13).
$DbList = @()
for ($i = 0; $i -lt $args.Count; $i += 1) {
  $arg = [string]$args[$i]
  if ($arg -match '^-{1,2}db=(?<valor>.+)$') { $DbList += $Matches['valor'] }
  elseif ($arg -match '^-{1,2}db$' -and $i + 1 -lt $args.Count) {
    $DbList += [string]$args[$i + 1]
    $i += 1
  }
}
$All = Test-Bandera $args 'all'
$DryRun = Test-Bandera $args 'dry-run'
$AsumirSi = Test-Bandera $args 'yes'
$ListOnly = Test-Bandera $args 'list'
$KeepVerify = Test-Bandera $args 'keep-verify-db'
$KeepOld = Test-Bandera $args 'keep-old'
$SoloClave = (Test-Bandera $args 'solo-clave') -or (Test-Bandera $args 'reconciliar-clave')

$pgBin = Get-PgBin
function PgTool { param([string]$n) if ($pgBin) { return (Join-Path $pgBin "$n.exe") } return $n }
$psql = PgTool 'psql'; $pgRestore = PgTool 'pg_restore'

# ── Clave del almacén: la del respaldo, cuando la instalación es nueva ──────
# Los valores cifrados (sesión de WhatsApp en `whatsapp_auth` y credenciales de
# canales en identity) se restauran CON la base, pero están cifrados con la
# STORAGE_ENCRYPTION_KEY del servidor ANTERIOR. Si la instalación nueva generó otra,
# no se pueden descifrar: WhatsApp no reconecta y el panel no puede leer los canales
# (fallo real del 2026-11-13). La clave vieja viaja en `config.zip` o, en el respaldo
# del desinstalador, en la carpeta `env`.
function Leer-ClaveAlmacen {
  param([string]$Texto)
  $m = [regex]::Match($Texto, '(?m)^STORAGE_ENCRYPTION_KEY=(.*)$')
  if (-not $m.Success) { return $null }
  $clave = $m.Groups[1].Value.Trim().Trim([char]0x22).Trim([char]0x27)
  if ($clave -eq '') { return $null }
  return $clave
}

function ClaveDelRespaldo {
  param([string]$Carpeta, [string]$Servicio)
  $archivoEnv = Join-Path (Join-Path $Carpeta 'env') "$Servicio.env"
  if (Test-Path $archivoEnv) {
    $clave = Leer-ClaveAlmacen (Get-Content -Raw $archivoEnv)
    if ($clave) { return $clave }
  }
  $zip = Join-Path $Carpeta 'config.zip'
  if (Test-Path $zip) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $archivo = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $patron = '(^|/)' + [regex]::Escape($Servicio) + '\.env$'
      $entrada = $archivo.Entries | Where-Object { $_.FullName -match $patron } | Select-Object -First 1
      if ($entrada) {
        $lector = New-Object System.IO.StreamReader($entrada.Open(), [Text.Encoding]::UTF8)
        try { return (Leer-ClaveAlmacen $lector.ReadToEnd()) } finally { $lector.Dispose() }
      }
    } finally { $archivo.Dispose() }
  }
  return $null
}

function Reconciliar-ClaveAlmacen {
  param([string]$Carpeta, [bool]$Simular)
  $servicios = @('identity', 'notifications', 'clinical', 'billing', 'patients')
  $cambiadas = @()
  $sinOrigen = @()
  foreach ($servicio in $servicios) {
    $actualRuta = Join-Path $OdontoEnv "$servicio.env"
    if (-not (Test-Path $actualRuta)) { continue }
    $contenido = Get-Content -Raw $actualRuta
    $actualClave = Leer-ClaveAlmacen $contenido
    if (-not $actualClave) { continue }
    $vieja = ClaveDelRespaldo -Carpeta $Carpeta -Servicio $servicio
    if (-not $vieja) { $vieja = ClaveDelRespaldo -Carpeta $Carpeta -Servicio 'notifications' }
    if (-not $vieja) { $sinOrigen += $servicio; continue }
    if ($actualClave -eq $vieja) { continue }
    if ($Simular) {
      Escribir-Detalle "[dry-run] pondría la clave del respaldo en $servicio.env"
      $cambiadas += $servicio
      continue
    }
    $nuevo = [regex]::Replace($contenido, '(?m)^STORAGE_ENCRYPTION_KEY=.*$', 'STORAGE_ENCRYPTION_KEY=' + $vieja)
    [IO.File]::WriteAllText($actualRuta, $nuevo, (New-Object System.Text.UTF8Encoding($false)))
    if (Get-Command Proteger-Archivo -ErrorAction SilentlyContinue) {
      Proteger-Archivo -Ruta $actualRuta -LecturaServicio | Out-Null
    }
    $cambiadas += $servicio
  }
  if ($cambiadas.Count -gt 0) {
    if ($Simular) {
      Escribir-Aviso ('[dry-run] se pondría la clave del respaldo en: ' + ($cambiadas -join ', '))
    } else {
      Escribir-Ok ('clave del almacén reconciliada con la del respaldo en: ' + ($cambiadas -join ', '))
      Escribir-Detalle 'la sesión de WhatsApp y las credenciales de canales vuelven a poder descifrarse; reinicia los servicios para aplicarlo'
    }
  } elseif ($sinOrigen.Count -gt 0) {
    Escribir-Aviso 'el respaldo no trae la clave del almacén: la sesión de WhatsApp restaurada no se podrá leer (habrá que volver a vincularla)'
  } else { Escribir-Detalle 'la clave del almacén ya coincide con la del respaldo' }
  return ($cambiadas.Count -gt 0)
}

# ── --solo-clave: reconciliar la clave del almacén sin tocar las bases ──────
# Camino rápido para una restauración ya hecha sin la configuración: en vez de
# volver a restaurar las bases, ajusta solo STORAGE_ENCRYPTION_KEY en los .env.
if ($SoloClave) {
  if (-not $From) { Morir 'falta --from <carpeta-del-respaldo>' }
  if (-not (Test-Path $From)) { Morir "no encuentro $From" }
  if (-not $DryRun) { Afirmar-Administrador }
  $carpetaSolo = if ((Get-Item $From).PSIsContainer) { $From } else { Split-Path $From -Parent }
  [void](Reconciliar-ClaveAlmacen -Carpeta $carpetaSolo -Simular $DryRun)
  if ($DryRun) { Escribir-Ok 'simulación terminada: nada se ha tocado' }
  exit 0
}

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

if (-not $SoloClave -and -not $All -and $DbList.Count -eq 0) { Morir 'indica qué restaurar: --all o --db <nombre> (mira --list)' }
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
  # La clave que se pidió UNA vez al empezar; ConEntorno la pone y la quita en cada
  # llamada, así no queda en el entorno de la consola.
  if ($script:ClavePgAdmin) { $entorno['PGPASSWORD'] = $script:ClavePgAdmin }
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

# Ejecuta SQL como administrador. `-Base` elige la base (ANALYZE se ejecuta DENTRO de la
# base restaurada: `ANALYZE base` desde postgres busca una TABLA llamada así y fallaba).
# Un error aborta la restauración: antes se ignoraba y se seguía con la base a medias.
function Ejecutar-Sql {
  param([string]$Sql, [string]$Base = 'postgres')
  ConEntorno (Env-PgAdmin) { & $psql -X -q -v ON_ERROR_STOP=1 -d $Base -c $Sql } | Out-Null
  if ($LASTEXITCODE -ne 0) { Morir "falló una orden de la restauración en «$Base»: $Sql" }
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

# ── Rol propietario de cada base ──────────────────────────────────────────
# Espejo de Fedora: ROLE_<base> en backup.env, o el nombre de la base. Las bases y las
# tablas restauradas tienen que quedar a nombre del ROL DEL SERVICIO: si se restauran
# como `postgres`, las migraciones del servicio fallan con 42501 (permission denied)
# aunque el dueño de la base sea postgres (pasó en la restauración del 2026-11-13).
function RolDeBase {
  param([string]$Base)
  $rol = Get-ValorEnv -Archivo $configFile -Clave "ROLE_$Base"
  if ($rol) { return $rol.Trim() }
  return $Base
}

function Test-RolExiste {
  param([string]$Rol)
  $rolSql = $Rol -replace "'", "''"
  $r = ConEntorno (Env-PgAdmin) { & $psql -X -t -A -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '$rolSql'" }
  return (([string]($r | Select-Object -First 1)).Trim() -eq '1')
}

# ── Clave del administrador de PostgreSQL: una sola vez ───────────────────
# Restaurar abre VARIAS conexiones por base (verificar en temporal, renombrar,
# crear, restaurar, ANALYZE). Si `postgres` no tiene entrada en `.pgpass`, psql
# pedía la clave en cada una: ~9 veces por base y ~90 en una restauración
# completa (2026-11-13). Se pide UNA vez y se pasa a los hijos por PGPASSWORD,
# en memoria y solo mientras dura la restauración.
$script:ClavePgAdmin = $null

function Test-ConexionAdmin {
  ConEntorno (Env-PgAdmin) { & $psql -X -q -w -d postgres -c 'select 1' *> $null }
  return ($LASTEXITCODE -eq 0)
}

function Asegurar-ClavePostgres {
  if (Test-ConexionAdmin) {
    Escribir-Ok 'conexión de administrador lista (sin pedir la clave)'
    return
  }
  if (-not [Environment]::UserInteractive) {
    Morir 'falta la clave de postgres y esta consola no es interactiva: define PGPASSWORD o añade una línea de postgres a .pgpass'
  }
  Write-Host ''
  Escribir-Aviso 'Restaurar abre varias conexiones por base. La clave se pide UNA sola vez:'
  $segura = Read-Host "Clave del usuario $PgAdminUser (se usa solo en esta restauración)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
  try { $script:ClavePgAdmin = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not (Test-ConexionAdmin)) {
    $script:ClavePgAdmin = $null
    Morir 'la clave de postgres no conecta: revísala y vuelve a ejecutar la restauración'
  }
  Escribir-Ok 'clave aceptada: no se volverá a pedir en esta restauración'
}

# La verificación de cada volcado toca la base temporal, así que la clave hace
# falta también sin `--yes`; con `--dry-run` no se conecta y no se pregunta.
if (-not $DryRun) { Asegurar-ClavePostgres }

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
  $rol = RolDeBase $base

  if ($DryRun) {
    Escribir-Detalle "[dry-run] base temporal $temp y luego $base, AMBAS con owner «$rol»"
    Escribir-Detalle "[dry-run] pg_restore --no-owner --role=$rol (las tablas quedan del servicio)"
    if ($KeepOld) { Escribir-Detalle "[dry-run] con --keep-old renombraría $base → $anteriorNombre" }
    continue
  }

  if (-not (Test-RolExiste $rol)) {
    Escribir-Error "${base}: no existe el rol «$rol» para dejarlo como propietario"
    Escribir-Detalle "revisa ROLE_$base en $configFile (o crea el rol con 20-aprovisionar.ps1)"
    $fallos++; continue
  }

  # ── 1. Verificación en una base temporal (no toca la real) ─────────────────
  Escribir-Detalle "verificando en $temp (la base real no se toca)…"
  Ejecutar-Sql "DROP DATABASE IF EXISTS `"$temp`""
  Ejecutar-Sql "CREATE DATABASE `"$temp`" OWNER `"$rol`""
  ConEntorno (Env-PgAdmin) { & $pgRestore --no-owner "--role=$rol" "--dbname=$temp" $dump *> $null }
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
    Ejecutar-Sql "ALTER DATABASE `"$base`" RENAME TO `"$anteriorNombre`""
    Escribir-Ok "${base}: la base anterior quedó como $anteriorNombre"
  }
  else {
    Ejecutar-Sql "DROP DATABASE IF EXISTS `"$base`" WITH (FORCE)"
  }
  Ejecutar-Sql "CREATE DATABASE `"$base`" OWNER `"$rol`""
  ConEntorno (Env-PgAdmin) { & $pgRestore --no-owner "--role=$rol" "--dbname=$base" $dump *> $null }
  if ($LASTEXITCODE -ne 0) { Escribir-Error "${base}: falló la restauración sobre la base real"; $fallos++; continue }
  # ANALYZE va DENTRO de la base restaurada (no como tabla desde postgres).
  Ejecutar-Sql 'ANALYZE' -Base $base
  Escribir-Ok "${base}: restaurada"

  # Comprobación de propiedad, como en Fedora: si las tablas no quedaron del rol del
  # servicio, las migraciones fallarán con 42501 y conviene verlo aquí, no al arrancar.
  $rolSql = $rol -replace "'", "''"
  $ajenas = ConEntorno (Env-PgAdmin) {
    & $psql -X -t -A -v ON_ERROR_STOP=1 -d $base -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND pg_get_userbyid(c.relowner) <> '$rolSql'"
  }
  $cuantas = 0
  [void][int]::TryParse((([string]($ajenas | Select-Object -First 1))).Trim(), [ref]$cuantas)
  if ($cuantas -gt 0) {
    Escribir-Aviso "${base}: $cuantas tabla(s) no quedaron a nombre de «$rol»; las migraciones podrían fallar"
    Escribir-Detalle "se arregla revisando ROLE_$base en $configFile y repitiendo la restauración"
  }
  else { Escribir-Ok "${base}: propiedad verificada (tablas del rol $rol)" }

  if (-not $KeepVerify) { Ejecutar-Sql "DROP DATABASE IF EXISTS $temp" }
}

Write-Host ''
if ($DryRun) { Escribir-Ok 'simulación terminada: nada se ha tocado'; exit 0 }
if ($fallos -gt 0) { Escribir-Error "$fallos base(s) con problemas"; exit 4 }

# Las bases restauradas traen datos cifrados con la clave del servidor anterior
# (WhatsApp y credenciales de canales). Si el respaldo trae esa clave, se pone para
# que el servicio pueda descifrarlos; si no, se avisa y WhatsApp pedirá re-vincular.
if (-not $DryRun) {
  $carpetaRespaldo = if ((Get-Item $From).PSIsContainer) { $From } else { Split-Path $From -Parent }
  [void](Reconciliar-ClaveAlmacen -Carpeta $carpetaRespaldo -Simular $false)
}

Escribir-Ok 'restauración correcta.'
Escribir-Detalle 'reinicia los servicios:  odontocrm reiniciar'
Escribir-Detalle 'si el respaldo es de otra versión del código, aplica antes las migraciones (pieza 3, o usa «odontocrm recuperar»).'
exit 0
