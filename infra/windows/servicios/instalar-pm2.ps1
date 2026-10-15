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
# > NOTA WINDOWS (aprendida en una máquina real, 2026-10-14): en Windows PM2 nombra sus
#   «pipes» en FIJO y global (`\\.\pipe\rpc.sock` y `\\.\pipe\pub.sock`, con un `@todo` en
#   `pm2/paths.js`), así que en la máquina solo puede haber UN demonio de PM2. El `npm run setup`
#   de este instalador instala `pm2-logrotate` con `pm2 install` COMO ADMINISTRADOR, y eso deja un
#   demonio del administrador dueño de los pipes: el servicio —que corre como `LocalService`—
#   recibe `connect EPERM` y `winsw` lo deja en `Stopped` tras sus reintentos. Por eso este guion
#   hace `pm2 kill` (Clear-Pm2Global) antes de arrancar el servicio. Y por el mismo motivo, en esta
#   máquina no debe convivir un PM2 de desarrollo: se pelearían por los pipes.
#
# > TAMBIÉN: PM2 no soporta nvm-for-windows (Node tiene que ser una instalación estándar). Si
#   `pm2-installer` no sirviera, el repliegue es la opción A del plan (un servicio por proceso con
#   WinSW).
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

# ── Dejar los «pipes» libres y arrancar EL SERVICIO ────────
# Aquí está el detalle que costó una instalación entera. `npm run setup` instala `pm2-logrotate`
# llamando a `pm2 install` **como administrador**: eso arranca un demonio de PM2 de la cuenta del
# administrador que se queda con los «pipes» GLOBALES de PM2 (`\\.\pipe\rpc.sock` y `pub.sock`, de
# nombre fijo: ver la cabecera). Como el servicio corre como `LocalService`, al conectar recibe
# `EPERM` y se cae; `winsw` lo reintenta tres veces y lo deja en `Stopped`. El servidor queda
# «instalado» sin correr nada. Se le quitan los pipes a ese demonio para que los cree el servicio,
# que es quien tiene que ser su dueño, y se comprueba POR EFECTO: `pm2 jlist` tiene que responder.
function Iniciar-Pm2DelServicio {
  if (Clear-Pm2Global) {
    Escribir-Ok 'los «pipes» de PM2 quedaron libres (sin demonios de otra cuenta)'
  }
  else {
    Escribir-Aviso 'quedan «pipes» de PM2 ocupados: hay OTRO PM2 vivo en esta máquina'
    Escribir-Detalle 'ciérralo (o `pm2 kill` en su consola): si no, el servicio de PM2 no puede arrancar'
  }
  $svc = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $svc) { return $false }
  # `winsw` agota sus reintentos y se rinde, así que al estado hay que darle una vuelta limpia
  # (un `Start-Service` sobre un servicio rendido no siempre lo despierta).
  try { Restart-Service -Name $svc.Name -Force -ErrorAction Stop } catch { }
  if (-not (Confirmar-ServicioPm2)) { return $false }
  Escribir-Ok "servicio de PM2 en marcha: $($svc.Name)"
  # OJO con el reloj: el servicio pasa a `Running` ANTES de que su PM2 publique los «pipes» y,
  # si el CLI llega en ese hueco, no encuentra demonio y SE MONTA UNO PROPIO (del
  # Administrador) que se queda con ellos: el instalador se quedó aquí colgado para siempre el
  # 2026-10-15. Se espera al bus del servicio antes de tocar el CLI.
  if (-not (Esperar-MessageBusPm2)) {
    Escribir-Aviso 'el servicio está en marcha pero su «message bus» no llega a publicarse'
    Escribir-Detalle "mira $PM2_HOME\service\service.log"
    return $false
  }
  # La prueba de verdad: hablarle al PM2 DEL SERVICIO (no al que arrancó el `setup`). Si responde,
  # los pipes son suyos y el servicio está haciendo su trabajo. Con techo de tiempo: este mismo
  # `jlist` fue el que se colgó sin responder nunca.
  $resultado = Invocar-Pm2 -Argumentos @('jlist') -Segundos 20
  if (-not $resultado.TiempoAgotado -and $resultado.Codigo -eq 0) {
    Escribir-Ok 'el demonio del servicio responde (pm2 jlist)'
  }
  else {
    Escribir-Aviso 'el servicio está en marcha pero su demonio no responde a `pm2 jlist`'
    # Si el CLI llegó a montarse su demonio en el intento, que no quede: volvería a dejar los
    # «pipes» tomados y el servicio ya no podría arrancar más.
    $null = Clear-DemoniosSueltos
  }
  Escribir-Detalle 'para hablar con PM2 hace falta una consola de Administrador (corre como LocalService)'
  return $true
}

# ── ¿Ya está? El servicio es el candado (idempotente). ───────────────────────
$servicio = Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($servicio -and -not $Forzar) {
  Escribir-Ok "el servicio de PM2 ya está instalado: $($servicio.Name) ($($servicio.Status))"
  if ($servicio.Status -ne 'Running' -and -not $DryRun) {
    if (-not (Iniciar-Pm2DelServicio)) {
      Escribir-Aviso 'el servicio de PM2 no consigue quedarse en marcha'
      Escribir-Detalle "mira $PM2_HOME\service\service.log (¿hay otro PM2 vivo?)"
    }
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

  # ── 2b. Restos de una instalación anterior: ARCHIVOS sin servicio ──────────
  # TRAMPA (2026-10-15, la que rompió dos instalaciones): node-windows considera el
  # servicio «instalado» mirando solo los archivos `daemon\pm2.exe` y `daemon\pm2.xml`
  # (`exists` de node-windows), NO el servicio de Windows. `desinstalar.ps1` borraba el
  # servicio pero dejaba `C:\ProgramData\pm2`; al reinstalar, node-windows respondía
  # «Already installed.», **no creaba ningún servicio**, y el paso siguiente moría con el
  # críptico «Could not find "pm2.exe" service after 10 attempts». Si hay archivos sin
  # servicio detrás, se retiran para que la instalación sea de verdad.
  $dirServicioPm2 = Join-Path $PM2_HOME 'service'
  $restosPm2 = Join-Path $dirServicioPm2 'daemon\pm2.xml'
  if ((-not (Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue)) -and (Test-Path $restosPm2)) {
    Escribir-Aviso 'hay restos de una instalación anterior (archivos de servicio pero ningún servicio de Windows)'
    Escribir-Detalle 'node-windows diría «Already installed» y no crearía el servicio: los retiro'
    try { Remove-Item -Recurse -Force $dirServicioPm2 -ErrorAction Stop } catch { }
    if (Test-Path $restosPm2) {
      Morir "no pude retirar los restos de $dirServicioPm2 (¿servicio «marcado para eliminación»?): reinicia Windows y repite"
    }
    Escribir-Ok "restos retirados: $dirServicioPm2"
  }

  # ── 3. Crear el servicio y confirmar que arranca ───────────────────────────
  # Antes de nada, los «pipes» libres: el `setup` arranca el servicio mientras su propio
  # `pm2 install` (el logrotate) deja un demonio del Administrador dueño de ellos, y las
  # primeras caídas del servicio son `connect EPERM` (2026-10-15: dos de tres intentos de
  # winsw). Si además queda vivo un demonio de antes —una consola de desarrollo, un CLI
  # suelto—, el servicio NO arranca en todo el `setup` y el error que se ve después no apunta
  # a la causa.
  Clear-Pm2Global | Out-Null
  Escribir-Detalle 'creando el servicio de Windows (una sola vez)…'
  & npm run setup 2>&1 | ForEach-Object { Escribir-Detalle $_ }
  if ($LASTEXITCODE -ne 0) {
    # Un reintento no estorba: node-windows espera ~10 veces a que el servicio aparezca y
    # en una máquina cargada se queda corto (así falló el 2026-10-14).
    Escribir-Aviso '«npm run setup» falló; reintento una vez…'
    Start-Sleep -Seconds 5
    & npm run setup 2>&1 | ForEach-Object { Escribir-Detalle $_ }
  }
  if ($LASTEXITCODE -ne 0) {
    # Los restos «archivos sin servicio» ya se limpiaron arriba (2b). Si aún falla, queda la
    # otra causa: el servicio anterior quedó **«marcado para eliminación»** por un desinstalar
    # sin reiniciar. Windows reserva el nombre hasta que se reinicie (o se cierren las consolas
    # con un handle abierto) y node-windows no puede crearlo: termina con
    # «Could not find "pm2.exe" service after 10 attempts», que no dice nada útil.
    $zombie = (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\pm2.exe') -and
      (-not (Get-Service -Name 'pm2*' -ErrorAction SilentlyContinue))
    if ($zombie) {
      Escribir-Error 'el servicio de PM2 anterior quedó «marcado para eliminación» y Windows no deja crear otro con ese nombre'
      Escribir-Detalle 'reinicia Windows (o cierra servicios.msc y las consolas que lo tengan abierto) y repite'
    }
    Morir "«npm run setup» falló (código $LASTEXITCODE). Mira la salida de arriba."
  }
}
finally { Pop-Location }

# ── 4. Arrancar el servicio con los «pipes» en su sitio ──────────────────────
if (Iniciar-Pm2DelServicio) { exit 0 }
Escribir-Aviso 'el servicio de PM2 no consigue quedarse en marcha'
Escribir-Detalle "mira $PM2_HOME\service\service.log"
Morir 'no se pudo dejar PM2 como servicio'
