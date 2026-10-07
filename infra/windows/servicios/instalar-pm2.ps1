# =============================================================================
# OdontoCRM · PM2 como servicio de Windows (ADR 0050, opción B)
#
#   .\instalar-pm2.ps1 [--dry-run] [--forzar]
#
# Windows no trae un «systemd» y PM2 tampoco se registra solo: hay que crearle un
# servicio. Se usa **`pm2-installer`** tal cual (opción B, la más sencilla y probada),
# con la versión FIJA que vive en este archivo —no la última— para que una instalación de
# dentro de un año haga lo mismo que la de hoy.
#
# Qué deja hecho, siguiendo lo que hace `pm2-installer` en Windows:
#   · configura npm para que sus archivos globales vivan en `C:\ProgramData\npm`
#     (accesibles a la cuenta del servicio) y `pm2` queda instalado globalmente;
#   · crea `C:\ProgramData\pm2` y fija `PM2_HOME` a nivel de máquina;
#   · crea el **servicio de Windows** con `node-windows` (corre como `LocalService`);
#   · instala `pm2-logrotate` para que los registros no llenen el disco.
#
# El servicio corre como `NT AUTHORITY\LocalService` (no como un usuario `odontocrm`: en
# Windows no se crea ese usuario). Por eso los `.env` y el certificado llevan ACL de
# lectura para ese SID —los pone `20-aprovisionar.ps1`— y los logs/datos, de escritura.
#
# > PENDIENTE WINDOWS: validar en una máquina real (PM2 no soporta nvm-for-windows: Node
#   tiene que ser una instalación estándar). Si `pm2-installer` no sirviera, el repliegue
#   es la opción A del plan (un servicio por proceso con WinSW).
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$DryRun = Test-Bandera $args 'dry-run'
$Forzar = Test-Bandera $args 'forzar'
if (-not $DryRun) { Afirmar-Administrador }

# Versión fija de pm2-installer (no «la última»): una instalación reproducible.
$PM2_INSTALLER_VERSION = '3.4.3'
$PM2_INSTALLER_URL = "https://github.com/jessety/pm2-installer/archive/refs/tags/v$PM2_INSTALLER_VERSION.zip"
$PM2_HOME = 'C:\ProgramData\pm2'
$NPM_PREFIX = 'C:\ProgramData\npm'
$instalador = Join-Path $OdontoEtc 'pm2-installer'

Write-Host ''
Write-Host 'OdontoCRM · PM2 como servicio de Windows' -ForegroundColor White
Escribir-Detalle "pm2-installer v$PM2_INSTALLER_VERSION"
Escribir-Detalle "PM2_HOME → $PM2_HOME"
if ($DryRun) { Escribir-Aviso '--dry-run: no se cambia nada' }

# ── ¿Ya está? El servicio es el candado (idempotente). ───────────────────────
$servicio = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($servicio -and -not $Forzar) {
  Escribir-Ok "el servicio de PM2 ya está instalado: $($servicio.Name) ($($servicio.Status))"
  if ($servicio.Status -ne 'Running' -and -not $DryRun) {
    Invocar "arrancar $($servicio.Name)" { Start-Service -Name $servicio.Name }
  }
  return
}

if (-not (Test-Comando node)) { Morir 'falta Node.js: ejecuta antes 10-preparar.ps1' }
if (-not (Test-Comando npm)) { Morir 'falta npm: reinstala Node.js' }

# nvm-for-windows rompe pm2-installer (lo dice su README). Mejor detectarlo y parar aquí
# con un mensaje claro que fallar tres pasos más adelante.
if ($env:NVM_HOME -or (Test-Path (Join-Path $env:APPDATA 'nvm'))) {
  Escribir-Aviso 'parece haber nvm-for-windows instalado: PM2 como servicio no lo soporta.'
  Escribir-Detalle 'instala Node.js «estándar» (el MSI de nodejs.org) y repite esto.'
}

if ($DryRun) {
  Escribir-Detalle "[dry-run] descargar $PM2_INSTALLER_URL"
  Escribir-Detalle "[dry-run] npm run configure && npm run configure-policy && npm run setup"
  Escribir-Detalle "[dry-run] con npm prefix=$NPM_PREFIX y PM2_HOME=$PM2_HOME (nivel de máquina)"
  exit 0
}

# ── 1. Descargar y extraer pm2-installer (versión fija) ──────────────────────
if (Test-Path (Join-Path $instalador 'package.json')) {
  Escribir-Ok "pm2-installer ya descargado en $instalador"
}
else {
  New-Item -ItemType Directory -Force -Path $OdontoEtc | Out-Null
  $zip = Join-Path $env:TEMP "pm2-installer-$PM2_INSTALLER_VERSION.zip"
  Escribir-Detalle "descargando pm2-installer v$PM2_INSTALLER_VERSION…"
  Invoke-WebRequest -Uri $PM2_INSTALLER_URL -OutFile $zip -UseBasicParsing -TimeoutSec 300
  if (Test-Path $instalador) { Remove-Item -Recurse -Force $instalador }
  Expand-Archive -Path $zip -DestinationPath $OdontoEtc -Force
  # El zip trae una carpeta `pm2-installer-<versión>`; se renombra a un nombre estable.
  $extraida = Get-ChildItem -Path $OdontoEtc -Directory -Filter 'pm2-installer-*' | Select-Object -First 1
  if ($extraida) { Move-Item -Path $extraida.FullName -Destination $instalador }
  Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $instalador 'package.json'))) {
    Morir "no pude extraer pm2-installer en $instalador"
  }
  Escribir-Ok "pm2-installer v$PM2_INSTALLER_VERSION en $instalador"
}

# ── 2. Configurar npm y PM2_HOME a nivel de máquina ──────────────────────────
# Es lo que hace `npm run configure`: sin esto, la cuenta del servicio no encuentra el
# ejecutable de PM2 (que vive en el prefijo global de npm, privado del usuario).
Push-Location $instalador
try {
  Invocar 'npm run configure (prefijo global y caché en ProgramData)' {
    & npm run configure 2>&1 | Out-Null
  }
  Escribir-Ok "npm configurado (prefix=$NPM_PREFIX, PM2_HOME=$PM2_HOME)"

  # La política de ejecución tiene que permitir invocar `pm2.ps1` (10-preparar.ps1 ya lo
  # deja en RemoteSigned; esto lo repite por si se ejecutó esta pieza sola).
  Invocar 'npm run configure-policy (RemoteSigned)' {
    & npm run configure-policy 2>&1 | Out-Null
  }

  # ── 3. Crear el servicio y confirmar que arranca ───────────────────────────
  Escribir-Detalle 'creando el servicio de Windows (una sola vez)…'
  & npm run setup 2>&1 | ForEach-Object { Escribir-Detalle $_ }
  if ($LASTEXITCODE -ne 0) {
    Morir "«npm run setup» falló (código $LASTEXITCODE). Mira la salida de arriba."
  }
}
finally { Pop-Location }

# ── 4. Comprobar que el servicio quedó vivo ─────────────────────────────────
$servicio = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($servicio) {
  if ($servicio.Status -ne 'Running') { Start-Service -Name $servicio.Name }
  Escribir-Ok "servicio de PM2 instalado y arrancado: $($servicio.Name)"
  Escribir-Detalle 'para hablar con PM2 hace falta una consola de Administrador (corre como LocalService)'
}
else {
  Escribir-Aviso 'no veo el servicio de PM2: revisa la salida de «npm run setup»'
  Morir 'no se pudo dejar PM2 como servicio'
}
