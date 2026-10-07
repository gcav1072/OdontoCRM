# =============================================================================
# OdontoCRM · INSTALADOR — un solo comando para un servidor Windows nuevo
#
#   powershell -ExecutionPolicy Bypass -File infra\windows\instalar\instalar.ps1
#
# Encadena las cuatro piezas, en orden, y se detiene en la primera que falle diciendo
# exactamente con qué se retoma. Cada pieza se puede ejecutar sola:
#
#   10-preparar.ps1      la máquina: Node, PostgreSQL, binarios, directorios y permisos
#   20-aprovisionar.ps1  las credenciales (ÚNICA fuente: C:\ProgramData\OdontoCRM\env),
#                        las bases, los roles y los usuarios; comprueba que cada una CONECTE
#   30-desplegar.ps1     el código (sin secretos), Chromium, migraciones, servicio de PM2,
#                        certificado TLS, proxy (Caddy) y firewall
#   40-verificar.ps1     el efecto: credencial por credencial, los procesos, HTTPS y la CA
#
# Opciones:
#   --comprobar           solo dice si la máquina está lista; no toca nada
#   --dry-run             enseña lo que haría, sin hacerlo
#   --solo=PIEZA          preparar | aprovisionar | desplegar | verificar
#   --nombre-mdns=NOMBRE  nombre del servidor (por defecto: odontocrm)
#   --ip=IP               IP de la LAN (si no, se deduce)
#   --admin-url=URL       cómo entrar a PostgreSQL como administrador (EN WINDOWS ES
#                         OBLIGATORIO; si no se indica se usa PG_ADMIN_URL)
#   --usuarios=a,b        cuentas a sembrar (por defecto SOLO `admin`)
#   --clave-admin=CLAVE   contraseña del administrador
#   --token-telegram=…    token de BotFather    · --usuario-telegram=…
#   --whatsapp-token=…    cuatro datos de la WhatsApp Cloud API
#   --sin-preguntas       no pregunta nada (clave del admin al azar, bot simulado)
#   --reconfigurar        vuelve a preguntar aunque ya haya valores
#
# Espejo de `infra/fedora/instalar/instalar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · instalación del servidor de la consulta (Windows)

USO
  .\instalar.ps1 [opciones]

MODO
  --comprobar        Solo dice si la máquina está lista (no toca nada).
  --dry-run          Enseña lo que haría, sin ejecutarlo.
  --solo=PIEZA       preparar | aprovisionar | desplegar | verificar
  --ayuda            Esta ayuda.

DATOS
  --nombre-mdns=NOMBRE   --ip=IP   --admin-url=URL   --usuarios=a,b
  --clave-admin=CLAVE    --sin-preguntas            --reconfigurar
  --token-telegram=…   --usuario-telegram=…
  --token-bot-admin=…  --chat-bot-admin=…   (avisos de fallos del sistema)
  --whatsapp-token=…   --whatsapp-phone-id=…   --whatsapp-verify-token=…   --whatsapp-app-secret=…
'@

$Comprobar = Test-Bandera $args 'comprobar'
$Solo = Get-Argumento $args 'solo'
$SinPreguntas = Test-Bandera $args 'sin-preguntas'
$Reconfigurar = Test-Bandera $args 'reconfigurar'
$DryRun = Test-Bandera $args 'dry-run'
$Nombre = Get-Argumento $args 'nombre-mdns'
$Ip = Get-Argumento $args 'ip'
$AdminUrl = Get-Argumento $args 'admin-url'
$Usuarios = Get-Argumento $args 'usuarios'
$ClaveAdmin = Get-Argumento $args 'clave-admin'
$TokenTelegram = Get-Argumento $args 'token-telegram'
$UsuarioTelegram = Get-Argumento $args 'usuario-telegram'
$TokenBotAdmin = Get-Argumento $args 'token-bot-admin'
$ChatBotAdmin = Get-Argumento $args 'chat-bot-admin'
$WaToken = Get-Argumento $args 'whatsapp-token'
$WaPhone = Get-Argumento $args 'whatsapp-phone-id'
$WaVerify = Get-Argumento $args 'whatsapp-verify-token'
$WaAppSecret = Get-Argumento $args 'whatsapp-app-secret'

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }
if (-not $Usuarios) { $Usuarios = 'admin' }

# ── Modo comprobación: ¿está la máquina lista? No toca NADA. ────────────────
if ($Comprobar) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '10-preparar.ps1') --comprobar
  exit $LASTEXITCODE
}

if (-not $DryRun) { Afirmar-Administrador }

$Nombre = Get-Nombre -Pedido $Nombre
if (-not $Ip) { $Ip = Get-IpLan }

Write-Host ''
Write-Host '╔══════════════════════════════════════════════════════════════════╗' -ForegroundColor White
Write-Host '║  OdontoCRM · instalación del servidor de la consulta (Windows)   ║' -ForegroundColor White
Write-Host '╚══════════════════════════════════════════════════════════════════╝' -ForegroundColor White
Escribir-Detalle "repositorio : $OdontoRepo"
Escribir-Detalle "código      : $OdontoCode"
Escribir-Detalle "secretos    : $OdontoEnv   (única fuente de verdad — ADR 0043)"
Escribir-Detalle "nombre      : $Nombre   IP: $Ip"
if ($DryRun) { Escribir-Aviso '--dry-run: no se cambia nada' }

# ── Las preguntas (una instalación nueva) ───────────────────────────────────
# Se preguntan UNA vez aquí y viajan por ENTORNO a las piezas. Sin terminal, con
# --sin-preguntas o en --dry-run no se pregunta: la clave del admin se genera al azar y el
# bot queda en modo simulado. Lo que ya esté configurado no se vuelve a preguntar.
$hayTerminal = [Environment]::UserInteractive
if (-not $DryRun -and -not $SinPreguntas -and $hayTerminal -and $Solo -notin @('verificar')) {
  $yaAprovisionado = Test-Path (Join-Path $OdontoEnv 'odontocrm.env')

  if (-not $ClaveAdmin -and -not $yaAprovisionado) {
    Write-Host ''
    Write-Host '  Puesta en marcha — se crea la cuenta «admin»; Enter omite lo demás' -ForegroundColor White
    $segura = Read-Host '      Contraseña del administrador (mínimo 10; Enter para generarla)' -AsSecureString
    $texto = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura))
    if ($texto.Length -ge 10) { $ClaveAdmin = $texto; Escribir-Ok 'contraseña del administrador guardada' }
    elseif ($texto.Length -gt 0) { Escribir-Aviso 'menos de 10 caracteres: se generará una temporal' }
    else { Escribir-Detalle 'sin contraseña: se generará una temporal y se imprimirá UNA vez' }
  }
  elseif ($yaAprovisionado -and -not $Reconfigurar) {
    Escribir-Detalle 'ya hay un entorno aprovisionado: no se toca la contraseña del administrador'
  }

  if (-not $TokenTelegram) {
    $r = Read-Host '      Token del bot de Telegram (Enter para omitir; queda en modo simulado)'
    if ($r) { $TokenTelegram = $r }
  }
  if (-not $TokenBotAdmin) {
    $r = Read-Host '      Token del bot de ADMINISTRACIÓN —avisos de fallos del sistema— (Enter para omitir)'
    if ($r) { $TokenBotAdmin = $r }
  }
  if ($TokenBotAdmin -and -not $ChatBotAdmin) {
    $r = Read-Host '      Chat del administrador (Enter para abrir Telegram, escribirle /start al bot y pulsar Enter)'
    if ($r) { $ChatBotAdmin = $r }
  }
  if (-not $WaToken) {
    $r = Read-Host '      Token de la WhatsApp Cloud API (Enter para omitir)'
    if ($r) { $WaToken = $r }
  }
}
elseif ($DryRun) { Escribir-Detalle '[dry-run] no se pregunta nada' }
elseif ($SinPreguntas) { Escribir-Detalle '--sin-preguntas: clave del admin al azar y bot en modo simulado' }

# Los valores viajan a las piezas por ENTORNO, nunca como argumentos (en la lista de
# procesos los vería cualquiera de la máquina). El vacío es «no lo toques».
$env:USUARIOS_SEED = $Usuarios
if ($ClaveAdmin) { $env:SEED_PASSWORD_ADMIN = $ClaveAdmin }
if ($TokenTelegram) { $env:TELEGRAM_BOT_TOKEN = $TokenTelegram }
if ($TokenBotAdmin) { $env:ADMIN_TELEGRAM_BOT_TOKEN = $TokenBotAdmin }
if ($ChatBotAdmin) { $env:ADMIN_TELEGRAM_CHAT_ID = $ChatBotAdmin }
if ($UsuarioTelegram) { $env:TELEGRAM_BOT_USERNAME = $UsuarioTelegram }
if ($WaToken) { $env:WHATSAPP_TOKEN = $WaToken }
if ($WaPhone) { $env:WHATSAPP_PHONE_ID = $WaPhone }
if ($WaVerify) { $env:WHATSAPP_VERIFY_TOKEN = $WaVerify }
if ($WaAppSecret) { $env:WHATSAPP_APP_SECRET = $WaAppSecret }
if ($AdminUrl) { $env:PG_ADMIN_URL = $AdminUrl }

# ── Las cuatro piezas ───────────────────────────────────────────────────────
# Cada una se ejecuta en un proceso aparte: si una falla, el instalador se para ahí y NO
# sigue con las siguientes sobre una base a medias.
function Invocar-Pieza {
  param([string]$Titulo, [string]$Guion, [string[]]$Extra = @())
  Escribir-Paso $Titulo
  $ruta = Join-Path $PSScriptRoot $Guion
  $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ruta) + $Extra
  & powershell @argumentos
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Escribir-Error "la pieza «$Titulo» falló."
    Escribir-Detalle 'Se retoma exactamente desde ahí con:'
    Write-Host "          .\$Guion $($Extra -join ' ')" -ForegroundColor White
    Write-Host '      Nada de lo que ya se hizo se pierde: todas las piezas son idempotentes.'
    exit 1
  }
}

$comunes = @()
if ($Nombre) { $comunes += "--nombre-mdns=$Nombre" }
if ($Ip) { $comunes += "--ip=$Ip" }
if ($DryRun) { $comunes += '--dry-run' }

$argsAprovisionar = @($comunes)
$argsDesplegar = @($comunes)
if ($AdminUrl) { $argsAprovisionar += "--admin-url=$AdminUrl" }

switch ($Solo) {
  'preparar' { Invocar-Pieza '1/4 · Preparar la máquina' '10-preparar.ps1' $comunes }
  'aprovisionar' { Invocar-Pieza '2/4 · Aprovisionar' '20-aprovisionar.ps1' $argsAprovisionar }
  'desplegar' { Invocar-Pieza '3/4 · Desplegar' '30-desplegar.ps1' $argsDesplegar }
  'verificar' { Invocar-Pieza '4/4 · Verificar' '40-verificar.ps1' @() }
  '' {
    Invocar-Pieza '1/4 · Preparar la máquina' '10-preparar.ps1' $comunes
    Invocar-Pieza '2/4 · Aprovisionar bases, roles y credenciales' '20-aprovisionar.ps1' $argsAprovisionar
    Invocar-Pieza '3/4 · Desplegar el servidor' '30-desplegar.ps1' $argsDesplegar

    Escribir-Paso '4/4 · Verificar'
    if ($DryRun) {
      Escribir-Detalle '[dry-run] comprobaría los procesos, HTTPS, la CA y el firewall'
    }
    else {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '40-verificar.ps1')
      if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Escribir-Aviso 'hay algo que arreglar (arriba está cada cosa con lo que le falta).'
        Escribir-Detalle 'la instalación queda hecha; corrige lo señalado y repite la verificación:'
        Write-Host '    .\40-verificar.ps1'
        exit 1
      }
    }
  }
  default { Morir "--solo=$Solo no existe. Opciones: preparar, aprovisionar, desplegar, verificar" }
}

Write-Host ''
Write-Host '══════════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host '  Instalación terminada' -ForegroundColor Green
Write-Host '══════════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host ''
Write-Host '  Desde los aparatos de la consulta:'
Write-Host "      https://$Ip" -ForegroundColor White
Write-Host ''
Write-Host '  El día a día del servidor:'
Write-Host '      .\40-verificar.ps1        los procesos, HTTPS y la CA'
Write-Host '      pm2 status                los procesos'
Write-Host '      pm2 logs odontocrm-clinical'
Write-Host ''
Write-Host "  Los secretos viven SOLO en $OdontoEnv. El código de $OdontoCode"
Write-Host '  no contiene ninguno: se puede borrar y volver a clonar sin perder nada.'
Write-Host ''
