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

# ── npm con el entorno LIMPIO ────────────────────────────────────────────────
# `npm ci`/`npm install` **omiten y borran** las devDependencies si ven `NODE_ENV=production`
# (o `NPM_CONFIG_OMIT=dev` / `NPM_CONFIG_PRODUCTION`), y la compilación necesita `tsc`, que
# vive en ellas. El 2026-10-15 una instalación murió en su paso 2/10 con «'tsc' no se reconoce
# como un comando interno o externo» porque la consola traía `NODE_ENV=production` de un
# `odontocrm` ejecutado en ella antes. Toda instalación de dependencias + compilación de los
# guiones pasa por aquí, y el entorno de la consola se queda como estaba.
function Con-EntornoNpmLimpio {
  param([scriptblock]$Accion)
  $protegidas = @('NODE_ENV', 'NPM_CONFIG_PRODUCTION', 'NPM_CONFIG_OMIT')
  $anterior = @{}
  foreach ($k in $protegidas) {
    $anterior[$k] = [Environment]::GetEnvironmentVariable($k)
    Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue
  }
  try { & $Accion }
  finally {
    foreach ($k in $protegidas) {
      if ($null -eq $anterior[$k]) { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
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

# ── La carpeta del código es también la de los datos ─────────────────────────
# En Windows los datos, los logs y los respaldos viven DENTRO de la carpeta del código
# (`C:\OdontoCRM\data`, `…\logs`, `…\backups`), a diferencia de Fedora, donde el código está
# en `/opt/odontocrm` y los datos en `/var/lib/odontocrm`. Consecuencia que costó una tarde: la
# pieza 1 crea esas carpetas ANTES de que la pieza 3 clone el código, así que la carpeta del
# código nunca está vacía. Sin esta lista, la pieza 3 creía que había «algo de otro» dentro y se
# negaba a clonar: el instalador no pasaba de 1/10 en una máquina limpia.
#
# Devuelve los nombres de PRIMER NIVEL de esas carpetas (los que ya no se pueden tocar al clonar).
# Se derivan de las rutas configuradas, no se escriben a mano: si alguien mueve los datos por
# entorno (`ODONTOCRM_DATA_DIR`), la lista se ajusta sola; y si viven fuera del código, sale vacía.
function Get-CarpetasPropiasDelCodigo {
  $prefijo = $OdontoCode.TrimEnd('\') + '\'
  $propias = @()
  foreach ($ruta in @($OdontoDatos, $OdontoLogs, $OdontoBackups)) {
    if ($ruta -and $ruta.StartsWith($prefijo, [StringComparison]::OrdinalIgnoreCase)) {
      $resto = $ruta.Substring($prefijo.Length)
      if ($resto) { $propias += ($resto -split '[\\/]')[0] }
    }
  }
  return ($propias | Sort-Object -Unique)
}

# ── El entorno de MÁQUINA, traído a la sesión actual ─────────────────────────
# `pm2-installer` deja `PM2_HOME` y el prefijo global de npm en el entorno de **máquina** y avisa
# de que hay que abrir una consola nueva para verlos («close this window and start a new terminal
# session»). En una instalación encadenada eso no es una opción: las piezas 3 y 4 corren en la
# MISMA sesión que lanzó el instalador, así que sin esto `pm2` se resolvería por el PATH del
# USUARIO —que puede tener su propio `pm2` de desarrollo en `%APPDATA%\npm`— y con el home por
# defecto (`%USERPROFILE%\.pm2`), que es un PM2 DISTINTO del que supervisa el servicio. El
# resultado sería el peor de los posibles: los procesos se arrancarían donde el servicio no los ve
# y el instalador diría que todo fue bien.
#
# Se lee del registro (ámbito de máquina) y se trae SOLO lo que falte: el PATH de la máquina va
# DELANTE (como en un proceso nuevo, donde `Path` = máquina + usuario) y las variables se copian si
# esta sesión no las trae ya (lo que puso el operador manda).
function Importar-EntornoDeMaquina {
  param([string[]]$Variables = @())
  $maquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($maquina) {
    $actual = @($env:Path -split ';')
    $faltan = @(($maquina -split ';') | Where-Object { $_ -and ($actual -notcontains $_) })
    if ($faltan.Count -gt 0) { $env:Path = ($faltan -join ';') + ';' + $env:Path }
  }
  foreach ($nombre in $Variables) {
    if (-not [Environment]::GetEnvironmentVariable($nombre)) {
      $valor = [Environment]::GetEnvironmentVariable($nombre, 'Machine')
      if ($valor) { Set-Item -Path "Env:$nombre" -Value $valor }
    }
  }
}

# El `pm2.cmd` de la MÁQUINA (el del prefijo global de npm), no el que cada usuario tenga en su
# `%APPDATA%\npm`: el servicio corre como LocalService y solo ve el primero. Devuelve la ruta, o
# `pm2` a secas si no aparece (para fallar con el error de siempre en vez de en silencio).
function Get-Pm2Cmd {
  Importar-EntornoDeMaquina -Variables @('PM2_HOME')
  foreach ($dir in ($env:Path -split ';')) {
    if (-not $dir) { continue }
    $candidato = Join-Path $dir 'pm2.cmd'
    if (Test-Path $candidato) { return $candidato }
  }
  return 'pm2'
}

# ── Los «pipes» de PM2: en Windows solo puede haber UN demonio por máquina ────
# PM2 nombra sus «pipes» en FIJO y global —`\\.\pipe\rpc.sock` y `\\.\pipe\pub.sock`— en vez de
# llevar el `PM2_HOME` dentro (`pm2/paths.js` lo marca con un `@todo` explícito). Consecuencia que
# tumbó una instalación entera: el demonio que arranca `npm run setup` **como administrador**
# (instala `pm2-logrotate` con `pm2 install`) se queda DUEÑO de esos pipes, y el servicio —que corre
# como `LocalService`— recibe `connect EPERM //./pipe/pub.sock` al conectar, se cae y `winsw` lo
# deja en `Stopped` tras agotar sus reintentos. El servidor «queda instalado» y no corre nada.
#
# ¿Están ocupados ahora mismo? Sirve para saber si un demonio ajeno sigue vivo (y para comprobar,
# por efecto, que el que los creó es el del servicio).
function Test-Pm2PipesLibres {
  $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') |
      Where-Object { $_ -match '\\(rpc|pub)\.sock$' })
  return ($pipes.Count -eq 0)
}

# ── Invocar `pm2` SIN poderse colgar ─────────────────────────────────────────
# El CLI de PM2 espera a su demonio sin prisa (y si no lo encuentra, ¡se monta uno él!): en la
# instalación del 2026-10-15 un `pm2 jlist` se quedó pegado para siempre y con él todo el
# instalador, esperando una respuesta que nunca llegó. Toda llamada a `pm2` desde los guiones
# pasa por aquí, con techo de tiempo. Devuelve `{ Codigo, Salida, TiempoAgotado }`; el código
# 124 marca «no respondió».
function Invocar-Pm2 {
  param([string[]]$Argumentos, [int]$Segundos = 30, [string]$Directorio = '')
  $pm2 = Get-Pm2Cmd
  $trabajo = Start-Job -ScriptBlock {
    param($ejecutable, $argumentos, $directorio)
    if ($directorio) { Set-Location $directorio }
    $salida = & $ejecutable @argumentos 2>$null | Out-String
    [pscustomobject]@{ Salida = $salida; Codigo = $LASTEXITCODE }
  } -ArgumentList $pm2, $Argumentos, $Directorio
  if (Wait-Job -Job $trabajo -Timeout $Segundos) {
    $resultado = Receive-Job -Job $trabajo
    Remove-Job -Job $trabajo -Force
    return @{ Codigo = $resultado.Codigo; Salida = $resultado.Salida; TiempoAgotado = $false }
  }
  Stop-Job -Job $trabajo -ErrorAction SilentlyContinue
  Remove-Job -Job $trabajo -Force -ErrorAction SilentlyContinue
  return @{ Codigo = 124; Salida = ''; TiempoAgotado = $true }
}

# ── Demonios sueltos de PM2: se retiran ──────────────────────────────────────
# El PM2 del servicio corre en «no daemon mode» (DENTRO del servicio: `pm2.daemon_mode = false`
# en el `index.js` de pm2-installer), así que en esta máquina TODO `pm2\lib\Daemon.js` es un
# demonio suelto que se montó un CLI: un `pm2 jlist` a destiempo, una consola de desarrollo…
# Son los que dejan los «pipes» globales tomados y al servicio le dan `connect EPERM`
# (2026-10-15: primero una consola de prueba y luego el propio `jlist` del instalador).
# `pm2 kill` no siempre llega a matarlos —quedó uno zombie, sin pipes pero vivo—, así que aquí
# se retiran por PID. Devuelve cuántos retiró.
function Clear-DemoniosSueltos {
  $retirados = 0
  foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    if ($proc.CommandLine -notmatch 'pm2[\\/]lib[\\/]Daemon\.js') { continue }
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      $retirados++
      Escribir-Detalle "demonio suelto de PM2 retirado (PID $($proc.ProcessId))"
    }
    catch { Escribir-Aviso "no pude retirar el demonio suelto PID $($proc.ProcessId): $($_.Exception.Message)" }
  }
  return $retirados
}

# ── Esperar al «message bus» del servicio ────────────────────────────────────
# Los `rpc.sock`/`pub.sock` tardan un segundo en publicarse DESPUÉS de que el servicio pasa a
# `Running`, y si el CLI llega antes no encuentra demonio y se monta uno propio (del
# Administrador) que roba los «pipes» y deja la instalación colgada. Antes de hablarle a PM2
# desde los guiones se espera a que su bus esté publicado.
function Esperar-MessageBusPm2 {
  param([int]$Segundos = 20)
  for ($i = 0; $i -lt $Segundos; $i++) {
    if (-not (Test-Pm2PipesLibres)) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Deja libres los pipes: `pm2 kill` le pide al demonio dueño de ellos que se apague (si ya están
# libres no se invoca nada: un CLI sin demonio delante podría montarse uno solo para morir).
# Después se retiran los demonios sueltos, que es quien de verdad los soltó la última vez.
# Devuelve `$true` si al terminar están libres. NO se ejecuta en `--dry-run`: mata procesos.
function Clear-Pm2Global {
  if (-not (Test-Pm2PipesLibres)) {
    $resultado = Invocar-Pm2 -Argumentos @('kill') -Segundos 15
    if ($resultado.TiempoAgotado) { Escribir-Aviso '«pm2 kill» no respondió: retiro los demonios a mano' }
  }
  $null = Clear-DemoniosSueltos
  Start-Sleep -Milliseconds 800
  return (Test-Pm2PipesLibres)
}

# ── El servicio de PM2: arrancarlo y comprobar que SIGUE vivo ────────────────
# No basta con `Start-Service`: si los pipes están ocupados, `winsw` lo reintenta y lo deja en
# `Stopped` (el arranque «sale bien» y el servidor no corre nada). Y hay un motivo más para no
# ejecutar `pm2` a la ligera desde una consola de administrador: si no hay demonio, **PM2 arranca
# uno de la cuenta del que llama**, se queda con los pipes globales y entonces es el SERVICIO el
# que ya no puede arrancar. Por eso `odontocrm` y la verificación pasan por aquí antes de hablar
# con PM2.
function Confirmar-ServicioPm2 {
  param([int]$Segundos = 10)
  $servicio = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $servicio) { return $false }
  if ($servicio.Status -ne 'Running') {
    # `-ErrorAction Stop`: sin esto PowerShell escribe el fallo y sigue (el `catch` no lo vería).
    try { Start-Service -Name $servicio.Name -ErrorAction Stop } catch { return $false }
  }
  for ($i = 0; $i -lt $Segundos; $i++) {
    $actual = Get-Service -Name $servicio.Name -ErrorAction SilentlyContinue
    if ($actual -and $actual.Status -eq 'Running') { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# ── Telegram: comprobar un token y descubrir el chat ─────────────────────────
# Un token mal copiado de BotFather no falla en NINGÚN sitio: el servicio arranca, los avisos
# se quedan en la bandeja y nadie se entera hasta que un paciente no recibe su cita. Se
# comprueba aquí, contra la propia API de Telegram (es lo que hace el instalador de Fedora).
# Devuelve el objeto del bot (`id`, `username`, …) o `$null` si Telegram no lo confirma.
function Get-BotTelegram {
  param([string]$Token)
  if (-not $Token) { return $null }
  # PowerShell 5.1 no siempre negocia TLS 1.2 con `api.telegram.org`: sin esto la llamada falla
  # con un error de conexión que parece «no hay internet».
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  catch { }
  try {
    $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot$Token/getMe" -TimeoutSec 10 -ErrorAction Stop
    if ($r.ok) { return $r.result }
  }
  catch { }
  return $null
}

# El `chat.id` del administrador, sacado de las ACTUALIZACIONES del bot: es lo que evita pedir
# un número que nadie sabe de memoria (y equivocarse). Hace falta que el administrador le haya
# escrito algo al bot (`/start`); si no, no hay actualizaciones y devuelve `$null`.
#
# OJO con `Set-StrictMode` (lo pone este archivo): `$actualizacion.message` **lanza** si la
# actualización no trae esa clave, y Telegram manda `my_chat_member` (no `message`) al pulsar
# «Iniciar». Un `throw` ahí se lo comería el `catch` y el chat no se detectaría NUNCA, sin decir
# nada. Por eso se pregunta por la clave con `PSObject.Properties`, que sí devuelve `$null`.
function Select-ChatDeActualizaciones {
  param($Actualizaciones)
  foreach ($actualizacion in @($Actualizaciones)) {
    $mensaje = $actualizacion.PSObject.Properties['message']
    if (-not $mensaje -or -not $mensaje.Value) { continue }
    $chat = $mensaje.Value.PSObject.Properties['chat']
    if (-not $chat -or -not $chat.Value) { continue }
    if ($chat.Value.id) { return $chat.Value.id }
  }
  return $null
}

function Get-ChatTelegram {
  param([string]$Token)
  if (-not $Token) { return $null }
  try {
    $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot$Token/getUpdates" -TimeoutSec 10 -ErrorAction Stop
    if ($r.ok) { return (Select-ChatDeActualizaciones -Actualizaciones $r.result) }
  }
  catch { }
  return $null
}

# Un EJECUTABLE que va a lanzar una cuenta de servicio (Caddy corre como LocalService) necesita
# `RX` —leer Y ejecutar—, no `R`: Windows exige `FILE_EXECUTE` para crear el proceso, y un `R` a
# secas deja el arranque en «acceso denegado».
#
# Y hay que darlo EXPLÍCITAMENTE: los binarios se descargan en `%TEMP%` y se mueven a su carpeta,
# y al moverlos conservan las ACL de `%TEMP%` (del usuario Administrador, sin LocalService y con la
# herencia bloqueada). La carpeta de destino SÍ tiene el permiso del servicio, pero al archivo no
# le llega. Síntoma exacto: el servicio no arranca y el registro de eventos solo dice `%%5`.
function Permitir-EjecucionAlServicio {
  param([string]$Ruta)
  if ($DryRun) { return }
  if (-not (Test-Path $Ruta)) { return }
  & icacls $Ruta /grant "${SidServicioLocal}:(RX)" | Out-Null
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

# ¿Puede el servicio (LocalService) escribir aquí de verdad? Se comprueba creando un archivo
# con la cuenta del servicio, no mirando la ACL: una ACL puede decir «sí» y la carpeta estar
# en un punto montado donde no se pueda. El testigo se crea con `schtasks` como LocalService,
# que es EXACTAMENTE la cuenta con la que corre PM2. Sin consola de administrador no se puede
# crear la tarea (y la verificación se puede correr sin elevación), y entonces se mira la ACL.
function Test-EscrituraServicio {
  param([string]$Ruta = $OdontoTmp)
  if ($DryRun) { return $true }
  if (-not (Test-Path $Ruta)) {
    Escribir-Detalle "no existe la carpeta $Ruta"
    return $false
  }

  if (Test-Administrador) {
    $tarea = 'OdontoCRM-probar-escritura'
    $marca = Join-Path $Ruta "prueba-escritura-$([guid]::NewGuid().ToString('N')).tmp"
    # `cmd /c` porque la tarea solo sabe con un comando: el `type nul` deja el testigo si hay
    # escritura, y si no lo hay la tarea falla o sale sin testigo — los dos casos = falso.
    # `/create /f` sobrescribe cualquier tarea de un intento anterior que quedara colgada.
    schtasks /create /tn $tarea /sc once /st 00:00 /ru 'NT AUTHORITY\LOCAL SERVICE' `
      /tr "cmd /c type nul > `"$marca`"" /f *> $null
    if ($LASTEXITCODE -ne 0) {
      Escribir-Detalle 'no pude crear la tarea de prueba como LocalService (schtasks)'
      return $false
    }
    try {
      schtasks /run /tn $tarea *> $null
      $limite = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $limite -and -not (Test-Path $marca)) { Start-Sleep -Milliseconds 250 }
    }
    finally { schtasks /delete /tn $tarea /f *> $null }
    $puede = Test-Path $marca
    if ($puede) { Remove-Item -Path $marca -Force -ErrorAction SilentlyContinue }
    if (-not $puede) {
      Escribir-Detalle "la cuenta LocalService no pudo crear un archivo en $Ruta"
    }
    return $puede
  }

  # Respaldo sin elevación: la ACL del SID del servicio (S-1-5-19) con permiso de escritura.
  $escritura = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($regla in (Get-Acl -Path $Ruta).Access) {
    if ($regla.AccessControlType -ne 'Allow') { continue }
    $sid = $null
    try { $sid = $regla.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
    if ($sid -ne 'S-1-5-19') { continue }
    if (($regla.FileSystemRights -band $escritura) -ne 0) { return $true }
  }
  Escribir-Detalle "el ACL de $Ruta no da permiso de escritura al servicio (S-1-5-19)"
  return $false
}

# ── La prueba de los imprimibles (el PDF de verdad) ──────────────────────────
# Que `chrome.exe` exista no prueba que el servicio pueda USARLO: los guiones ejecutan
# `instalar\probar-pdf.mjs` con el MISMO entorno que tendrán los servicios de PM2
# (`TMP`/`TEMP`/`TMPDIR` en $OdontoTmp y `PLAYWRIGHT_BROWSERS_PATH` en $OdontoPlaywright).
# Así el «EPERM … mkdtemp» del 2026-10-15 sale en la instalación, no en el mostrador.
function Probar-Pdf {
  param([string]$Titulo = 'el PDF de prueba')
  if ($DryRun) { return $true }
  $prueba = Join-Path $PSScriptRoot 'probar-pdf.mjs'
  if (-not (Test-Path $prueba)) { Escribir-Aviso "no encuentro probar-pdf.mjs: no pruebo $Titulo"; return $false }
  # Precondición del test: la carpeta temporal del servicio. Sin ella Playwright falla con
  # «ENOENT … mkdtemp» y el fallo parece del navegador, no de la instalación.
  if (-not (Test-Path $OdontoTmp)) {
    Nuevo-Directorio -Ruta $OdontoTmp -Acceso 'Escritura' | Out-Null
  }
  $anterior = @{}
  foreach ($k in @('TMPDIR', 'TMP', 'TEMP', 'PLAYWRIGHT_BROWSERS_PATH')) {
    $anterior[$k] = [Environment]::GetEnvironmentVariable($k)
  }
  try {
    $env:TMPDIR = $OdontoTmp
    $env:TMP = $OdontoTmp
    $env:TEMP = $OdontoTmp
    $env:PLAYWRIGHT_BROWSERS_PATH = $OdontoPlaywright
    $salida = & node $prueba $OdontoCode 2>&1
    $bien = ($LASTEXITCODE -eq 0)
    if ($bien) {
      Escribir-Ok "$Titulo se compone con Chromium ($($salida | Select-Object -Last 1))"
    }
    else {
      Escribir-Aviso "no pude componer $Titulo"
      foreach ($linea in @($salida)) { Escribir-Detalle "  $linea" }
    }
    return $bien
  }
  finally {
    foreach ($k in @('TMPDIR', 'TMP', 'TEMP', 'PLAYWRIGHT_BROWSERS_PATH')) {
      if ($null -eq $anterior[$k]) { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue }
      else { Set-Item -Path "Env:\$k" -Value $anterior[$k] }
    }
  }
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
