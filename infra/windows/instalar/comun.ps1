# =============================================================================
# OdontoCRM · biblioteca compartida de los guiones de Windows
#
# Es una BIBLIOTECA: NO se ejecuta sola. Las piezas la cargan con `.` (dot-source):
#
#     . "$PSScriptRoot\comun.ps1"
#
# Aquí está lo que NO debe repetirse en cada pieza: la salida por pantalla, las rutas
# de producción, las comprobaciones (Administrador, comandos, PostgreSQL) y los ayudantes
# idempotentes (crear solo si falta, conceder permisos, esperar un puerto).
#
# Espejo de `infra/fedora/instalar/comun.sh`. Las decisiones de fondo son las mismas;
# lo que cambia es el sistema operativo:
#   · En Fedora hay `systemd` y el usuario de sistema `odontocrm`; aquí los servicios
#     corren como `NT AUTHORITY\LocalService` y los supervisa PM2 (ver ADR 0050).
#   · En Fedora los secretos viven en `/etc/odontocrm` (0600 root:root); aquí en
#     `C:\ProgramData\OdontoCRM\env` con ACL para Administradores y LocalService.
#   · Los permisos NO se dan con `chmod`: se dan con `icacls` y **por SID**, no por
#     nombre, porque en un Windows en español la cuenta se llama «SERVICIO LOCAL» y
#     `NT AUTHORITY\LocalService` no existe con ese nombre.
# =============================================================================

# La consola de Windows viene en una página de códigos heredada y los ✔ ✖ ! salen como
# «?». Esto la pone en UTF-8 para que la salida se lea como en Fedora.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# `set -u` de bash: un nombre mal escrito se nota en vez de valer $null en silencio.
Set-StrictMode -Version Latest

# **OJO con no poner `$ErrorActionPreference = 'Stop'`.** En PowerShell 5.1, cuando una orden
# NATIVA (`psql`, `npm`, `git`, `pm2`, `pg_dump`…) escribe en su salida de error —y eso es lo
# NORMAL: `npm` registra todo por stderr y `git` avisa por ahí—, con `Stop` eso se convierte
# en un error TERMINANTE y el guion ABORTA en el acto. Se descubrió con `psql` (un fallo de
# autenticación, en `--dry-run`, tumbaba el respaldo entero).
#
# El criterio es el de los guiones de Fedora: se comprueba **`$LASTEXITCODE`** después de cada
# orden nativa (su equivalente al `|| morir` de bash), y para las órdenes de PowerShell se usa
# `-ErrorAction Stop` donde de verdad importa que un fallo pare.
$ErrorActionPreference = 'Continue'

# ── Rutas ────────────────────────────────────────────────────────────────────
# El repositorio se deduce del propio guion: así funciona desde cualquier clon, de
# cualquier usuario y en cualquier ruta. (En Fedora esto fue uno de los fallos que más
# costó: rutas grabadas de una PC concreta.)
$OdontoRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not (Test-Path (Join-Path $OdontoRepo 'package.json'))) {
  Write-Host "  ✖ no encuentro la raíz del repositorio en $OdontoRepo" -ForegroundColor Red
  exit 1
}

# Las rutas se pueden sobrescribir por entorno, como en Fedora (ODONTOCRM_ENV_DIR, etc.).
# Sirve, sobre todo, para poder PROBAR las piezas sin tocar la máquina.
$OdontoCode = if ($env:ODONTOCRM_CODE_DIR) { $env:ODONTOCRM_CODE_DIR } else { 'C:\OdontoCRM' }
$OdontoDatos = if ($env:ODONTOCRM_DATA_DIR) { $env:ODONTOCRM_DATA_DIR } else { Join-Path $OdontoCode 'data' }
$OdontoLogs = if ($env:ODONTOCRM_LOG_DIR) { $env:ODONTOCRM_LOG_DIR } else { Join-Path $OdontoCode 'logs' }
$OdontoBackups = if ($env:ODONTOCRM_BACKUP_DIR) { $env:ODONTOCRM_BACKUP_DIR } else { Join-Path $OdontoCode 'backups' }
$OdontoEtc = if ($env:ODONTOCRM_ETC_DIR) { $env:ODONTOCRM_ETC_DIR } else { 'C:\ProgramData\OdontoCRM' }
$OdontoEnv = Join-Path $OdontoEtc 'env'
$OdontoTls = Join-Path $OdontoEtc 'tls'
$OdontoBin = Join-Path $OdontoEtc 'bin'
$OdontoCmd = Join-Path $OdontoBin 'cmd' # los lanzadores del PATH (odontocrm.cmd)
$OdontoWww = Join-Path $OdontoDatos 'www'
$OdontoCaPub = Join-Path $OdontoWww 'ca'
$OdontoStorage = Join-Path $OdontoDatos 'storage'
# Carpeta temporal del bot de administración: `%TEMP%` (C:\Windows\TEMP) NO es escribible
# por LocalService, así que los volcados a demanda van aquí (creada con Escritura).
$OdontoTmp = Join-Path $OdontoDatos 'tmp'
$OdontoPlaywright = Join-Path $OdontoDatos 'ms-playwright'

$PuertoGateway = 8090
$ZonaHoraria = 'Venezuela Standard Time' # el identificador de Windows (para Set-TimeZone)
$TzIana = 'America/Caracas' # el que leen Node y los servicios (TZ=…); Node lo entiende
$NombrePorDefecto = 'odontocrm'

# Los SID a los que se dan permisos (ver la nota de arriba sobre el idioma).
$SidAdministradores = '*S-1-5-32-544'
$SidServicioLocal = '*S-1-5-19'
# SYSTEM: lo necesitan las TAREAS PROGRAMADAS (respaldos, alertas y red), que Windows
# ejecuta como SYSTEM por defecto. Sin esto, la tarea del respaldo no podría escribir en
# la carpeta de respaldos (que es solo de Administradores) y fallaría de madrugada.
$SidSistema = '*S-1-5-18'

# Lo pone cada pieza al leer `--dry-run`; aquí nace en falso para que las funciones de
# esta biblioteca lo puedan consultar sin fallar.
$DryRun = $false

# La lista de servicios se lee UNA vez del repositorio (tools/servicios.mjs) y se cachea.
$OdontoInfo = $null

# ── Salida ───────────────────────────────────────────────────────────────────
function Escribir-Ok { param([string]$Texto) Write-Host "  ✔ $Texto" -ForegroundColor Green }
function Escribir-Aviso { param([string]$Texto) Write-Host "  ! $Texto" -ForegroundColor Yellow }
function Escribir-Error { param([string]$Texto) Write-Host "  ✖ $Texto" -ForegroundColor Red }
function Escribir-Detalle { param([string]$Texto) Write-Host "      $Texto" -ForegroundColor DarkGray }
function Escribir-Paso {
  param([string]$Texto)
  Write-Host ''
  Write-Host "== $Texto ==" -ForegroundColor Cyan
}

function Morir {
  param([string]$Mensaje, [int]$Codigo = 1)
  Escribir-Error $Mensaje
  exit $Codigo
}

# Aviso de «no te cortes en silencio»: en Fedora esto salvó un ensayo entero, que moría
# justo antes del resumen y parecía que «el reinicio no funcionaba». Cada pieza pone:
#     trap { Escribir-Corte; exit 1 }
function Escribir-Corte {
  $linea = $_.InvocationInfo.ScriptLineNumber
  $guion = Split-Path $_.InvocationInfo.ScriptName -Leaf
  Write-Host ''
  Escribir-Error "$guion se detuvo en la línea $linea"
  Write-Host "      $($_.Exception.Message)" -ForegroundColor DarkGray
}

# ── Comprobaciones ───────────────────────────────────────────────────────────
function Test-Administrador {
  $identidad = [Security.Principal.WindowsIdentity]::GetCurrent()
  # SYSTEM (S-1-5-18) es asimilable a Administrador: es la cuenta con la que Windows ejecuta
  # las tareas programadas, y sin esto `odontocrm alertas` fallaría dentro de la tarea.
  if ($identidad.User.Value -eq 'S-1-5-18') { return $true }
  $principal = New-Object Security.Principal.WindowsPrincipal($identidad)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Equivale a `exigir_root` en Fedora: sin permisos no se toca nada. `--dry-run` puede
# ejecutarse sin ser Administrador, porque no cambia nada.
function Afirmar-Administrador {
  if (Test-Administrador) { return }
  Escribir-Error 'este guion necesita una consola de Administrador.'
  Escribir-Detalle 'Abre PowerShell con clic derecho → «Ejecutar como administrador» y repítelo.'
  exit 5
}

function Test-Comando {
  param([string]$Nombre)
  return [bool](Get-Command $Nombre -ErrorAction SilentlyContinue)
}

# Versión mayor de Node (0 si no está). Se usa en la preparación y en la comprobación previa.
function Get-NodeMayor {
  if (-not (Test-Comando node)) { return 0 }
  $v = & node --version 2>$null
  if ($v -match '^v(\d+)') { return [int]$Matches[1] }
  return 0
}

# ── Argumentos al estilo Fedora (`--clave=valor`, `--bandera`) ────────────────
function Get-Argumento {
  param([string[]]$Argumentos, [string]$Nombre)
  foreach ($arg in $Argumentos) {
    if ($arg -like "--$Nombre=*") { return $arg.Substring($arg.IndexOf('=') + 1) }
  }
  return $null
}

function Test-Bandera {
  param([string[]]$Argumentos, [string]$Nombre)
  foreach ($arg in $Argumentos) {
    if ($arg -eq "--$Nombre") { return $true }
  }
  return $false
}

# ── Ejecución que respeta --dry-run ──────────────────────────────────────────
# Se le pasa una descripción (lo que se vería en `--dry-run`) y un bloque con la orden.
function Invocar {
  param([string]$Descripcion, [scriptblock]$Accion)
  if ($DryRun) {
    Escribir-Detalle "[dry-run] $Descripcion"
    return
  }
  & $Accion
}

# ── Directorios y permisos ───────────────────────────────────────────────────
# `Acceso`: Escritura (los datos que el servicio produce) · Lectura (lo que solo lee) ·
# Ninguno (solo Administradores).
function Otorgar-Acceso {
  param([string]$Ruta, [string]$Acceso = 'Lectura', [switch]$SoloAdministradores)
  if ($DryRun) { return }
  if (-not (Test-Path $Ruta)) { return }
  & icacls $Ruta /grant "${SidAdministradores}:(OI)(CI)F" | Out-Null
  & icacls $Ruta /grant "${SidSistema}:(OI)(CI)F" | Out-Null
  if (-not $SoloAdministradores) {
    switch ($Acceso) {
      'Escritura' { & icacls $Ruta /grant "${SidServicioLocal}:(OI)(CI)M" | Out-Null }
      'Lectura' { & icacls $Ruta /grant "${SidServicioLocal}:(OI)(CI)R" | Out-Null }
      'Ninguno' { }
    }
  }
}

function Nuevo-Directorio {
  param([string]$Ruta, [string]$Acceso = 'Lectura', [switch]$SoloAdministradores)
  if (Test-Path $Ruta) {
    Escribir-Ok "$Ruta ya existe"
  }
  elseif ($DryRun) {
    Escribir-Detalle "[dry-run] crear $Ruta ($Acceso)"
    return
  }
  else {
    # `-Force` no falla si ya existe: idempotente por construcción.
    New-Item -ItemType Directory -Force -Path $Ruta | Out-Null
    Escribir-Ok "creado $Ruta"
  }
  if (-not $DryRun) { Otorgar-Acceso -Ruta $Ruta -Acceso $Acceso -SoloAdministradores:$SoloAdministradores }
}

# Cierra los permisos de un archivo de secretos: solo Administradores (y, si se pide,
# LocalService en modo lectura). Se QUITA la herencia para que no entre «Users».
function Proteger-Archivo {
  param([string]$Ruta, [switch]$LecturaServicio)
  if ($DryRun) { return }
  if (-not (Test-Path $Ruta)) { return }
  & icacls $Ruta /inheritance:r | Out-Null
  & icacls $Ruta /grant "${SidAdministradores}:F" | Out-Null
  & icacls $Ruta /grant "${SidSistema}:R" | Out-Null
  if ($LecturaServicio) { & icacls $Ruta /grant "${SidServicioLocal}:R" | Out-Null }
}

# ── Red ──────────────────────────────────────────────────────────────────────
# La IP de la LAN por la que sale esta máquina (la que se teclea desde otro equipo).
# No es la de la primera tarjeta: puede ser una virtual (Hyper-V, WSL, VirtualBox).
function Get-IpLan {
  try {
    $ruta = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
      Sort-Object RouteMetric | Select-Object -First 1
    if ($ruta) {
      $ip = Get-NetIPAddress -InterfaceIndex $ruta.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($ip) { return $ip.IPAddress }
    }
  }
  catch { }
  $alterna = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1
  if ($alterna) { return $alterna.IPAddress }
  return $null
}

# Espera ACTIVA a que un puerto responda. Es la lección más cara de Fedora: mandar a
# arrancar PostgreSQL y en la línea siguiente conectarse falla con ECONNREFUSED si el
# motor tarda tres segundos en abrir el puerto.
function Esperar-Puerto {
  param([int]$Puerto, [string]$Equipo = '127.0.0.1', [int]$Segundos = 30)
  if ($DryRun) { return $true }
  $limite = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $limite) {
    $listo = Test-NetConnection -ComputerName $Equipo -Port $Puerto -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($listo) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# ── PostgreSQL ───────────────────────────────────────────────────────────────
# Los binarios del instalador oficial (EDB) NO quedan en el PATH. Se buscan en su sitio.
function Get-PgBin {
  if ($env:ODONTOCRM_PGBIN) { return $env:ODONTOCRM_PGBIN }
  foreach ($version in @('18', '17', '16', '15')) {
    $ruta = Join-Path (Join-Path 'C:\Program Files\PostgreSQL' $version) 'bin'
    if (Test-Path (Join-Path $ruta 'psql.exe')) { return $ruta }
  }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return (Split-Path $cmd.Source -Parent) }
  return $null
}

function Get-PgVersion {
  $bin = Get-PgBin
  if (-not $bin) { return $null }
  $carpeta = Split-Path $bin -Parent
  return (Split-Path $carpeta -Leaf)
}

# ── El administrador de PostgreSQL ───────────────────────────────────────────
# En Fedora, sin `--admin-url` se usa el socket «peer» (`runuser -u postgres`), que funciona
# en una instalación recién hecha sin teclear ninguna contraseña. En Windows ese socket NO
# existe: o hay URL, o no se puede crear ninguna base. Hasta ahora la única salida era pasar
# la URL por la línea de órdenes, y la contraseña de `postgres` —que es la del MOTOR— quedaba
# en el historial de PowerShell y en la lista de procesos, a la vista de cualquiera de la
# máquina. Aquí se PIDE por teclado y se oculta al escribir.
function ConvertTo-TextoClaro {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Segura)
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Segura)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Devuelve la URL del administrador de PostgreSQL. Si ya viniera por bandera (`--admin-url`) o
# por entorno (`PG_ADMIN_URL`), devuelve ESA tal cual (no se pregunta dos veces). Si no, y hay
# consola, compone `postgres://USUARIO:CLAVE@EQUIPO:PUERTO/BASE` con la contraseña tecleada
# —**codificada**, porque una `@`, `:` o `/` dentro de la clave partiría la URL por la mitad—,
# la deja en `PG_ADMIN_URL` (para las piezas y herramientas siguientes) y **no la imprime**.
# Con `-SinPreguntar` (--dry-run, --sin-preguntas) o sin consola devuelve `$null`, y quien
# llama decide: el aprovisionador lo explica y se detiene.
function Resolver-AdminUrlPostgres {
  param(
    [string]$Url = '',
    [string]$Usuario = 'postgres',
    [string]$Equipo = '127.0.0.1',
    [int]$Puerto = 5432,
    [string]$Base = 'postgres',
    [string]$Pregunta = '',
    [switch]$SinPreguntar
  )
  if ($Url) { return $Url }
  if ($env:PG_ADMIN_URL) { return $env:PG_ADMIN_URL }
  if ($SinPreguntar -or -not [Environment]::UserInteractive) { return $null }

  if ($Pregunta) { Escribir-Detalle $Pregunta }
  Write-Host ''
  Escribir-Detalle 'Se escribe oculta: no queda en el historial ni en la lista de procesos.'
  $clave = $null
  try {
    $segura = Read-Host "      Contraseña de «$Usuario» (Enter para cancelar)" -AsSecureString
    $clave = ConvertTo-TextoClaro $segura
  }
  catch { return $null }
  if ([string]::IsNullOrEmpty($clave)) { return $null }

  $url = "postgres://${Usuario}:$([Uri]::EscapeDataString($clave))@${Equipo}:$Puerto/$Base"
  $env:PG_ADMIN_URL = $url
  Escribir-Ok "administrador de PostgreSQL: postgres://${Usuario}:***@${Equipo}:$Puerto/$Base"
  return $url
}

# La copia en claro de la contraseña que va DENTRO de una URL de administrador
# (`postgres://usuario:clave@equipo:puerto/base`). Se devuelve `''` si la URL no la trae
# —`PG_ADMIN_URL` puede venir de un `.pgpass` o de un usuario con otro mecanismo—, y en ese
# caso quien llama NO inventa nada: pregunta o lo dice.
function Get-ClaveDeAdminUrl {
  param([string]$Url)
  if (-not $Url) { return '' }
  $m = [regex]::Match($Url, '^[A-Za-z][A-Za-z0-9+.-]*://[^:/@]*:([^@]*)@')
  if (-not $m.Success) { return '' }
  try { return [Uri]::UnescapeDataString($m.Groups[1].Value) } catch { return $m.Groups[1].Value }
}

function Get-PsqlExe {
  $bin = Get-PgBin
  if (-not $bin) { return $null }
  $exe = Join-Path $bin 'psql.exe'
  if (Test-Path $exe) { return $exe }
  return $null
}

# ¿La credencial del administrador CONECTA? Es la regla del repositorio: una credencial vale
# cuando entra, no cuando el archivo existe. Devuelve $false sin ruido si `psql` no está.
function Probar-ClavePostgres {
  param(
    [string]$Usuario = 'postgres',
    [string]$Equipo = '127.0.0.1',
    [int]$Puerto = 5432,
    [string]$Base = 'postgres',
    [string]$Clave
  )
  $psql = Get-PsqlExe
  if (-not $psql) { return $false }
  # La contraseña va por ENTORNO (`PGPASSWORD`), nunca como argumento: en la lista de procesos
  # la vería cualquiera de la máquina. `PGCONNECT_TIMEOUT` evita que la comprobación se quede
  # colgada si el motor está levantado pero no responde.
  $anterior = $env:PGPASSWORD
  $anteriorTimeout = $env:PGCONNECT_TIMEOUT
  $env:PGPASSWORD = $Clave
  $env:PGCONNECT_TIMEOUT = '5'
  try {
    $salida = & $psql -X -w -tAc 'select 1' -h $Equipo -p $Puerto -U $Usuario -d $Base 2>$null
    return ($LASTEXITCODE -eq 0 -and "$salida".Trim() -eq '1')
  }
  finally {
    if ($null -eq $anterior) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $anterior }
    if ($null -eq $anteriorTimeout) { Remove-Item Env:\PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue }
    else { $env:PGCONNECT_TIMEOUT = $anteriorTimeout }
  }
}

# ── La «ventana de confianza»: fijar la contraseña cuando no se conoce ───────
# Es el equivalente en Windows del socket «peer» de Linux. En Fedora, root entra como
# `postgres` sin contraseña (`runuser -u postgres psql`), así que un motor recién instalado
# NUNCA deja fuera al instalador. En Windows no hay nada parecido: el motor exige contraseña
# y el instalador de EDB **no la elige** (winget lo lanza con `--mode unattended
# --unattendedmodeui none`, sin `--superpassword`), así que la instalación en limpio moría en
# la pieza 2 con «password authentication failed» —o con un rol `postgres` sin contraseña
# utilizable— y no había forma de salir desde el propio instalador.
#
# El arreglo es el que usa cualquier DBA cuando se queda fuera: durante unos segundos se
# permite entrar SIN contraseña por la interfaz local (solo `127.0.0.1`/`::1`), se fija la
# contraseña con `ALTER ROLE`, y se restaura `pg_hba.conf` **tal como estaba** (el `finally`,
# aunque algo falle a mitad). El motor se reinicia dos veces (no hay nadie conectado todavía:
# esto corre en la pieza 1, antes de desplegar).
#
# Devuelve $true solo si, al final, la contraseña CONECTA de verdad.
function Reiniciar-ClavePostgres {
  param(
    [Parameter(Mandatory = $true)][string]$Clave,
    [string]$Usuario = 'postgres',
    [string]$Equipo = '127.0.0.1',
    [int]$Puerto = 5432,
    [string]$Base = 'postgres'
  )
  if ($DryRun) {
    Escribir-Detalle "[dry-run] fijaría la contraseña de «$Usuario» por la ventana de confianza"
    return $false
  }
  $psql = Get-PsqlExe
  if (-not $psql) { Escribir-Error 'no encuentro psql.exe: ¿está instalado PostgreSQL?'; return $false }
  $pgBin = Get-PgBin
  $hba = Join-Path (Split-Path $pgBin -Parent) 'data\pg_hba.conf'
  if (-not (Test-Path $hba)) { Escribir-Error "no encuentro pg_hba.conf en $hba"; return $false }
  $servicio = Get-ServicioPostgres
  if (-not $servicio) { Escribir-Error 'no encuentro el servicio de PostgreSQL'; return $false }
  $nombreServicio = $servicio.Name

  $sinBom = New-Object System.Text.UTF8Encoding($false) # PostgreSQL rechaza el BOM
  $original = [IO.File]::ReadAllText($hba)
  # SOLO las líneas de bases de datos locales (`host all <usuario> 127.0.0.1/32`): se dejan
  # fuera las de `replication`, que no hacen falta para fijar la contraseña.
  $ventana = $original -replace '(?m)^(host\s+all\s+\S+\s+(?:127\.0\.0\.1/32|::1/128)\s+)\S+\s*$', '${1}trust'
  if ($ventana -eq $original) {
    Escribir-Error "$hba no tiene líneas «host all … 127.0.0.1/32»: no puedo abrir la ventana de confianza"
    return $false
  }
  $copia = "$hba.antes-de-odontocrm"

  try {
    Copy-Item -Path $hba -Destination $copia -Force
    [IO.File]::WriteAllText($hba, $ventana, $sinBom)
    Restart-Service -Name $nombreServicio -Force
    if (-not (Esperar-Puerto -Puerto $Puerto -Segundos 30)) {
      Escribir-Error "PostgreSQL no volvió a escuchar en el $Puerto tras reiniciar el servicio"
      return $false
    }

    # La contraseña va por ENTRADA ESTÁNDAR (no como argumento) y el literal SQL se escapa.
    $sql = "ALTER ROLE ""$Usuario"" WITH PASSWORD '$($Clave -replace "'", "''")';"
    $salida = $sql | & $psql -X -q -v ON_ERROR_STOP=1 -h $Equipo -p $Puerto -U $Usuario -d $Base 2>&1
    if ($LASTEXITCODE -ne 0) {
      Escribir-Error 'PostgreSQL rechazó el cambio de contraseña:'
      foreach ($l in @("$salida" -split "`r?`n")) { if ($l) { Escribir-Detalle $l } }
      return $false
    }
  }
  finally {
    # Pase lo que pase, `pg_hba.conf` vuelve a como estaba.
    if (Test-Path $copia) {
      [IO.File]::WriteAllText($hba, [IO.File]::ReadAllText($copia), $sinBom)
      Restart-Service -Name $nombreServicio -Force | Out-Null
      if (-not (Esperar-Puerto -Puerto $Puerto -Segundos 30)) {
        Escribir-Aviso "PostgreSQL tardó en volver tras restaurar $hba (míralo antes de seguir)"
      }
    }
  }

  return (Probar-ClavePostgres -Usuario $Usuario -Equipo $Equipo -Puerto $Puerto -Base $Base -Clave $Clave)
}

# ── El navegador de los PDF (Chromium de Playwright) ─────────────────────────
# Lo necesitan el récipe A5 (`clinical`), la factura y el recibo (`billing`) y los reportes.
# **No viene con el código**: Playwright lo descarga aparte y los servicios lo buscan en
# `PLAYWRIGHT_BROWSERS_PATH`. Si falta, esos endpoints fallan (503 explicado, pero fallan).
# Por eso lo baja la pieza 3, idempotente.
#
# Se comprueba el EJECUTABLE, no solo la carpeta: una descarga a medias deja el directorio
# creado y vacío, y entonces «parece instalado» sin estarlo.
function Test-Navegador {
  param([string]$Ruta = $OdontoPlaywright)
  if (-not (Test-Path $Ruta)) { return $false }
  $exe = Get-ChildItem -Path $Ruta -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('chrome.exe', 'headless_shell.exe', 'chrome-headless-shell.exe') } |
    Select-Object -First 1
  return ($null -ne $exe)
}

function Get-NavegadorExe {
  param([string]$Ruta = $OdontoPlaywright)
  if (-not (Test-Path $Ruta)) { return $null }
  $exe = Get-ChildItem -Path $Ruta -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'chrome.exe' } | Select-Object -First 1
  if ($exe) { return $exe.FullName }
  return $null
}

# El servicio del motor (EDB lo llama `postgresql-x64-18`). Se descubre, no se escribe.
function Get-ServicioPostgres {
  return (Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*agent*' } | Select-Object -First 1)
}

# Lee `CLAVE=VALOR` de un archivo de entorno, sin interpretarlo (nada de dot-source).
function Get-ValorEnv {
  param([string]$Archivo, [string]$Clave)
  if (-not (Test-Path $Archivo)) { return $null }
  $linea = Select-String -Path $Archivo -Pattern "^$Clave=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $linea) { return $null }
  return ($linea.Line -replace "^$Clave=", '')
}

# ── La lista de servicios (del repositorio, nunca a mano) ────────────────────
# `tools/servicios.mjs` es la única fuente: una carpeta `services/<x>/` con `migrations/`
# y su puerto en `.env.example`. Tenerla a mano ya falló tres veces con `billing`.
function Get-Info {
  if ($null -ne $OdontoInfo) { return $OdontoInfo }
  if (-not (Test-Comando node)) {
    Morir 'no encuentro «node»: instálalo con 10-preparar.ps1 antes de seguir.'
  }
  $json = & node (Join-Path $OdontoRepo 'tools\servicios.mjs') --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $json) {
    Morir 'no pude leer la lista de servicios (tools/servicios.mjs --json)'
  }
  $OdontoInfo = $json | ConvertFrom-Json
  return $OdontoInfo
}

# ── ¿Compiló TODO? ───────────────────────────────────────────────────────────
# Comprueba que, tras `npm run build`, existe el punto de entrada de cada servicio y el del
# gateway. Un `tsc -b` incremental puede dar por bueno un proyecto del que no emitió todos sus
# módulos, y el servicio arranca con el código viejo (pasó con el módulo del encaje del récipe:
# salía encogido y en dos hojas). `npm run prebuild` compila en limpio; esto lo verifica.
# Devuelve la lista de rutas que FALTAN (vacía = todo bien).
function Get-EntrypointsFaltantes {
  $info = Get-Info
  $faltan = @()
  foreach ($s in $info.servicios) {
    $ruta = Join-Path $OdontoCode "services\$($s.nombre)\dist\index.js"
    if (-not (Test-Path $ruta)) { $faltan += "services/$($s.nombre)/dist/index.js" }
  }
  if (-not (Test-Path (Join-Path $OdontoCode 'apps\gateway\dist\index.js'))) {
    $faltan += 'apps/gateway/dist/index.js'
  }
  return $faltan
}

# ── ¿El código compilado es el del disco? ────────────────────────────────────
# Un `git reset --hard` (o un `checkout`) en el código cambia el FUENTE pero NO recompila: el
# servicio sigue corriendo el `dist` viejo sin que nadie se entere hasta que algo falla en el
# papel. La marca `.odontocrm-build-commit` la escribe `npm run postbuild`. Devuelve $null si
# cuadra (o si no se puede saber), y si no, el motivo del aviso.
function Get-AvisoDistViejo {
  $marca = Join-Path $OdontoCode '.odontocrm-build-commit'
  if (-not (Test-Path $marca)) { return $null }
  $compilado = (Get-Content $marca -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $compilado) { return $null }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $head = (& git -C $OdontoCode rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $head) { return $null }
  $head = $head.Trim()
  if ($compilado -eq $head) { return $null }
  $col = [Math]::Min(7, $compilado.Length)
  $headCol = [Math]::Min(7, $head.Length)
  return "el dist se compiló del commit $($compilado.Substring(0, $col)), no del actual ($($head.Substring(0, $headCol)))"
}

# Nombre con el que entran los equipos. Sin mDNS en Windows, se entra por IP; esto queda
# para el certificado y para WEB_ORIGIN (y por si algún día se añade el nombre al hosts).
function Get-Nombre {
  param([string]$Pedido = '')
  if ($Pedido) { return $Pedido }
  $archivo = Join-Path $OdontoEnv 'odontocrm.env'
  if (Test-Path $archivo) {
    $linea = Select-String -Path $archivo -Pattern '^ODONTOCRM_NOMBRE=' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($linea) { return ($linea.Line -replace '^ODONTOCRM_NOMBRE=', '') }
  }
  return $NombrePorDefecto
}

# ── Resumen de cierre ────────────────────────────────────────────────────────
function Escribir-Listo {
  param([string]$Numero, [string]$Texto, [string]$Siguiente)
  Write-Host ''
  Write-Host "$Numero listo. $Texto" -ForegroundColor Green
  if ($Siguiente) { Escribir-Detalle "siguiente:  $Siguiente" }
}
