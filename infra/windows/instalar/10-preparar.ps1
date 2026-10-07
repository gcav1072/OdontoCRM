# =============================================================================
# OdontoCRM · 1/4 · Preparar la máquina (Windows)
#
# Deja la PC lista para que el resto del instalador pueda trabajar:
#   · Node.js y Git (si faltan, con `winget`)
#   · PostgreSQL 18: servicio arrancado, puerto 5432 a la escucha y `pg_hba.conf`
#     en `scram-sha-256` para las conexiones TCP
#   · los binarios que Windows no trae: `mkcert.exe` y `caddy.exe`
#   · los directorios de producción con sus permisos (ACL) y el PATH de la máquina
#
# NO instala nada de la aplicación y NO crea credenciales: eso es la pieza 2.
# Es idempotente: lo que ya está, se salta.
#
#   powershell -ExecutionPolicy Bypass -File infra\windows\instalar\10-preparar.ps1
#   ...\10-preparar.ps1 --comprobar      # solo dice si la máquina está lista; no toca nada
#   ...\10-preparar.ps1 --dry-run        # enseña lo que haría, sin hacerlo
#
# Espejo de `infra/fedora/instalar/10-preparar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · 1/4 · Preparar la máquina (Windows)

USO
  .\10-preparar.ps1 [--dry-run] [--comprobar] [--sin-binarios]

OPCIONES
  --dry-run        Enseña lo que haría, sin cambiar nada (se puede sin Administrador).
  --comprobar      Solo comprueba si la máquina está lista; no toca NADA.
  --sin-binarios   No descarga mkcert/caddy (los instala otro medio).
  --ayuda          Esta ayuda.
'@

$Comprobar = Test-Bandera $args 'comprobar'
$SinBinarios = Test-Bandera $args 'sin-binarios'
if (Test-Bandera $args 'ayuda' -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }
$DryRun = Test-Bandera $args 'dry-run'

# ── Modo comprobación: ¿está la máquina lista? No toca NADA. ─────────────────
# Es lo primero que uno quiere saber antes de empezar, y se puede ejecutar sin
# Administrador: aquí no se escribe nada.
if ($Comprobar) {
  Write-Host ''
  Write-Host '¿Está esta máquina lista para instalar OdontoCRM?' -ForegroundColor White
  Write-Host ''
  $problemas = 0
  function Revisar {
    param([string]$Que, [scriptblock]$Prueba, [string]$Arreglo)
    try { $bien = & $Prueba } catch { $bien = $false }
    if ($bien) { Escribir-Ok $Que } else { Escribir-Aviso "$Que → $Arreglo"; $script:problemas++ }
  }

  Revisar 'Windows con PowerShell 5.1 o superior' { $PSVersionTable.PSVersion.Major -ge 5 } 'actualiza Windows'
  Revisar 'Node.js 22.9 o superior' { (Get-NodeMayor) -ge 22 } 'lo instala la pieza 1'
  Revisar 'npm disponible' { Test-Comando npm } 'viene con Node'
  Revisar 'Git disponible' { Test-Comando git } 'lo instala la pieza 1'
  Revisar 'PostgreSQL instalado' { $null -ne (Get-PgBin) } 'lo instala la pieza 1'
  Revisar 'el servicio de PostgreSQL existe' { $null -ne (Get-ServicioPostgres) } 'lo instala la pieza 1'
  Revisar 'hay conexión a internet' {
    try {
      $r = Invoke-WebRequest -Uri 'https://registry.npmjs.org' -UseBasicParsing -Method Head -TimeoutSec 8
      $r.StatusCode -lt 500
    }
    catch { $false }
  } 'hace falta para npm ci y para descargar los binarios'

  # Y si ya hay una instalación, se dice en qué estado está (sin cambiarla).
  if (Test-Path (Join-Path $OdontoEnv 'odontocrm.env')) {
    Write-Host ''
    Escribir-Ok "ya hay un entorno aprovisionado en $OdontoEnv (esto es una repetición, no una instalación desde cero)"
  }
  Write-Host ''
  if ($problemas -eq 0) {
    Escribir-Ok 'todo listo: ejecuta 10-preparar.ps1 como Administrador'
  }
  else {
    Escribir-Aviso "$problemas cosa(s) por resolver antes de empezar (arriba está cada una)"
  }
  exit 0
}

$DryRun = $DryRun -or (Test-Bandera $args 'dry-run')
if (-not $DryRun) { Afirmar-Administrador }

Write-Host ''
Write-Host 'OdontoCRM · 1/4 · Preparar la máquina (Windows)' -ForegroundColor White
Escribir-Detalle "repositorio : $OdontoRepo"
Escribir-Detalle "código      : $OdontoCode"
Escribir-Detalle "secretos    : $OdontoEnv"
if ($DryRun) { Escribir-Aviso '--dry-run: no se cambia nada' }

# ── 1. Node.js, npm y Git ────────────────────────────────────────────────────
Escribir-Paso '1/7 · Node.js, npm y Git'

$hayWinget = Test-Comando winget
if ($hayWinget) { Escribir-Ok 'winget disponible (sirve para instalar lo que falte)' }
else { Escribir-Aviso 'no hay `winget`: si falta algo habrá que instalarlo a mano (Microsoft Store → «Instalador de aplicaciones»)' }

function Instalar-ConWinget {
  param([string]$Id, [string]$Que)
  if (-not $hayWinget) { return $false }
  Invocar "winget install $Id" {
    & winget install --id $Id --silent --accept-package-agreements --accept-source-agreements 2>&1 |
      Out-Null
  }
  if ($DryRun) { return $true }
  return $true
}

if ((Get-NodeMayor) -ge 22) {
  Escribir-Ok "Node.js ya presente: $(& node --version)"
}
else {
  Escribir-Aviso 'Node.js 22.9+ no está (o es más viejo)'
  $instalado = Instalar-ConWinget -Id 'OpenJS.NodeJS' -Que 'Node.js'
  if ((-not $DryRun) -and (Get-NodeMayor) -lt 22 -and -not $instalado) {
    Morir 'instala Node.js 22.9 o superior desde https://nodejs.org y vuelve a ejecutar esto.'
  }
}

if (Test-Comando npm) { Escribir-Ok "npm ya presente: $(& npm --version)" }
elseif (-not $DryRun) { Morir 'no encuentro `npm` (viene con Node.js): reinstala Node.js.' }

if (Test-Comando git) { Escribir-Ok "Git ya presente: $((& git --version) -replace 'git version ', '')" }
else { Instalar-ConWinget -Id 'Git.Git' -Que 'Git' | Out-Null }

# ── 2. PostgreSQL: motor, servicio y puerto ──────────────────────────────────
Escribir-Paso '2/7 · PostgreSQL'

if ($null -eq (Get-PgBin)) {
  Escribir-Aviso 'PostgreSQL no está instalado'
  Instalar-ConWinget -Id 'PostgreSQL.PostgreSQL.18' -Que 'PostgreSQL 18' | Out-Null
}

$pgBin = Get-PgBin
if ($null -eq $pgBin) {
  if ($DryRun) { Escribir-Detalle '[dry-run] se instalaría PostgreSQL 18' }
  else {
    Morir 'instala PostgreSQL 18 desde https://www.postgresql.org/download/windows/ y vuelve a ejecutar esto.'
  }
}
else {
  Escribir-Ok "PostgreSQL en $pgBin"
}

$servicio = Get-ServicioPostgres
if ($null -eq $servicio) {
  if (-not $DryRun) { Morir 'no encuentro el servicio de PostgreSQL (¿terminó de instalarse?)' }
}
else {
  Escribir-Ok "servicio: $($servicio.Name) ($($servicio.Status))"
  if ($servicio.Status -ne 'Running') {
    Invocar "arrancar el servicio $($servicio.Name)" {
      Set-Service -Name $servicio.Name -StartupType Automatic
      Start-Service -Name $servicio.Name
    }
  }
  else {
    Invocar "dejar el servicio $($servicio.Name) en arranque automático" {
      Set-Service -Name $servicio.Name -StartupType Automatic
    }
  }

  # Espera ACTIVA: el motor tarda unos segundos en abrir el puerto.
  Escribir-Detalle 'esperando a que PostgreSQL escuche en 127.0.0.1:5432…'
  if (-not $DryRun) {
    if (Esperar-Puerto -Puerto 5432 -Segundos 30) { Escribir-Ok 'PostgreSQL escucha en el 5432' }
    else { Morir 'PostgreSQL no abrió el puerto 5432 a tiempo (mira el visor de eventos del servicio).' }
  }
}

# ── 3. pg_hba.conf: TCP con contraseña (scram-sha-256) ───────────────────────
# El instalador de EDB suele dejarlo bien, pero no siempre: si las líneas de TCP quedan
# en `ident`/`trust`, los servicios —que entran por 127.0.0.1 con su contraseña— no
# pueden conectar y reintentan en bucle. Se cambia SOLO eso.
Escribir-Paso '3/7 · pg_hba.conf: TCP con contraseña (scram-sha-256)'

$pgHba = $null
if ($pgBin) {
  $candidato = Join-Path (Split-Path $pgBin -Parent) 'data\pg_hba.conf'
  if (Test-Path $candidato) { $pgHba = $candidato }
}

if (-not $pgHba) {
  Escribir-Aviso 'no encuentro pg_hba.conf; si los servicios no conectan, revisa la sección de PostgreSQL'
}
else {
  $contenido = Get-Content -Path $pgHba -Raw
  $nuevo = $contenido -replace '(?m)^(host\s+\S+\s+\S+\s+(?:127\.0\.0\.1/32|::1/128)\s+)(?:ident|trust)\s*$', '${1}scram-sha-256'
  if ($nuevo -eq $contenido) {
    Escribir-Ok 'ya está en scram-sha-256 para TCP (sin cambios)'
  }
  else {
    Invocar "poner TCP en scram-sha-256 en $pgHba" {
      Copy-Item -Path $pgHba -Destination "$pgHba.antes-de-odontocrm" -Force
      Set-Content -Path $pgHba -Value $nuevo -Encoding UTF8
      # Recargar sin reiniciar: `pg_ctl reload`. Se busca junto a los binarios.
      $pgCtl = Join-Path $pgBin 'pg_ctl.exe'
      if (Test-Path $pgCtl) {
        $datos = Join-Path (Split-Path $pgBin -Parent) 'data'
        & $pgCtl reload -D $datos 2>&1 | Out-Null
      }
    }
    Escribir-Ok 'TCP pasa a scram-sha-256 (copia previa en pg_hba.conf.antes-de-odontocrm)'
  }
}

# ── 4. PATH de la máquina ────────────────────────────────────────────────────
Escribir-Paso '4/7 · PATH de la máquina'

function Add-RutaAlPath {
  param([string]$Ruta)
  if (-not (Test-Path $Ruta)) { return }
  $actual = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($null -eq $actual) { $actual = '' }
  if (($actual -split ';') -contains $Ruta) {
    Escribir-Ok "ya está en el PATH: $Ruta"
    return
  }
  Invocar "añadir al PATH de la máquina: $Ruta" {
    [Environment]::SetEnvironmentVariable('Path', ($actual.TrimEnd(';') + ';' + $Ruta), 'Machine')
    if (($env:Path -split ';') -notcontains $Ruta) { $env:Path = $env:Path.TrimEnd(';') + ';' + $Ruta }
  }
}

if ($pgBin) { Add-RutaAlPath $pgBin }
Add-RutaAlPath $OdontoCmd

# ── 5. Política de ejecución de PowerShell ───────────────────────────────────
# Sin esto, invocar `pm2` (que es `pm2.ps1`) falla con «no se puede cargar el archivo
# porque la ejecución de scripts está deshabilitada». Es el arreglo que pm2-installer
# también pide (configure-policy).
Escribir-Paso '5/7 · Política de ejecución'
$politica = Get-ExecutionPolicy -Scope LocalMachine
if ($politica -in @('Undefined', 'Restricted', 'AllSigned')) {
  Invocar "Set-ExecutionPolicy RemoteSigned (LocalMachine)" {
    Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force
  }
  Escribir-Ok "política puesta en RemoteSigned (estaba en $politica)"
}
else {
  Escribir-Ok "política ya permitida: $politica"
}

# ── 6. Los binarios que Windows no trae: mkcert y caddy ──────────────────────
# No se versionan en Git (son binarios de terceros): se descargan y, si hay hash fijado,
# se verifica. Mientras no lo haya, se imprime el que salió para poder fijarlo.
Escribir-Paso '6/7 · Binarios (mkcert y caddy)'

$Binarios = @(
  @{
    Nombre = 'mkcert.exe'
    Url    = 'https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe'
    # > PENDIENTE WINDOWS: fijar el SHA-256 de esta versión de mkcert para verificar la
    #   descarga. Mientras esté vacío, el guion avisa y sigue (imprime el hash obtenido).
    Sha256 = ''
  },
  @{
    Nombre = 'caddy.exe'
    Url    = 'https://caddyserver.com/api/download?os=windows&arch=amd64'
    # > PENDIENTE WINDOWS: igual, fijar el SHA-256 de la versión de Caddy que se adopte.
    Sha256 = ''
  }
)

function Descargar-Binario {
  param([string]$Nombre, [string]$Url, [string]$Sha256)
  $destino = Join-Path $OdontoBin $Nombre
  if (Test-Path $destino) {
    Escribir-Ok "$Nombre ya está en $OdontoBin"
    return
  }
  if ($DryRun) {
    Escribir-Detalle "[dry-run] descargar $Nombre de $Url"
    return
  }
  New-Item -ItemType Directory -Force -Path $OdontoBin | Out-Null
  $temporal = Join-Path $env:TEMP ("odontocrm-" + [Guid]::NewGuid().ToString('N') + ".tmp")
  try {
    Invoke-WebRequest -Uri $Url -OutFile $temporal -UseBasicParsing -TimeoutSec 300
    $hash = (Get-FileHash -Path $temporal -Algorithm SHA256).Hash.ToLower()
    if ($Sha256) {
      if ($hash -ne $Sha256.ToLower()) {
        Morir "el hash de $Nombre NO coincide.`n  esperado: $Sha256`n  obtenido: $hash"
      }
      Escribir-Ok "$Nombre descargado y verificado (sha256 $($hash.Substring(0, 12))…)"
    }
    else {
      Escribir-Aviso "$Nombre descargado SIN hash fijado (sha256 $hash) — fíjalo en 10-preparar.ps1"
    }
    Move-Item -Path $temporal -Destination $destino -Force
  }
  finally {
    if (Test-Path $temporal) { Remove-Item -Path $temporal -Force -ErrorAction SilentlyContinue }
  }
}

if ($SinBinarios) {
  Escribir-Aviso '--sin-binarios: no descargo mkcert ni caddy'
}
else {
  foreach ($b in $Binarios) { Descargar-Binario -Nombre $b.Nombre -Url $b.Url -Sha256 $b.Sha256 }
}

# ── 7. Directorios y permisos ────────────────────────────────────────────────
#
# El reparto no es decorativo. En Fedora el código es de root y de solo lectura para el
# servicio; aquí el equivalente es: Administradores con control total y LocalService con
# lo justo. Los datos que el servicio ESCRIBE (storage, navegador, logs) van con M
# (modificar); lo que solo LEE (el código compilado, los secretos, el certificado) va con R.
Escribir-Paso '7/7 · Directorios y permisos'

Nuevo-Directorio -Ruta $OdontoCode -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoDatos -Acceso 'Escritura'
Nuevo-Directorio -Ruta $OdontoStorage -Acceso 'Escritura'
Nuevo-Directorio -Ruta $OdontoPlaywright -Acceso 'Escritura'
Nuevo-Directorio -Ruta $OdontoLogs -Acceso 'Escritura'
Nuevo-Directorio -Ruta $OdontoWww -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoCaPub -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoBackups -Acceso 'Ninguno' -SoloAdministradores
Nuevo-Directorio -Ruta $OdontoEtc -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoEnv -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoTls -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoBin -Acceso 'Lectura'
Nuevo-Directorio -Ruta $OdontoCmd -Acceso 'Lectura'

# ── Hora correcta ────────────────────────────────────────────────────────────
# Afecta a tickets, citas y JWT. En Windows la zona es un identificador, no «America/Caracas».
$tz = (Get-TimeZone).Id
if ($tz -eq $ZonaHoraria) {
  Escribir-Ok "zona horaria correcta: $tz"
}
else {
  Escribir-Aviso "zona horaria actual «$tz»; el sistema espera «$ZonaHoraria»."
  Escribir-Detalle "Corrígelo en Configuración → Hora e idioma → Fecha y hora, o con:"
  Escribir-Detalle "    Set-TimeZone -Id '$ZonaHoraria'"
}

Escribir-Listo -Numero '1/4' -Texto 'La máquina está preparada.' -Siguiente '.\20-aprovisionar.ps1'
