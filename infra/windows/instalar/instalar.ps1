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
#   --admin-url=URL       cómo entrar a PostgreSQL como administrador. Si no se indica, se
#                         usa PG_ADMIN_URL y, si tampoco hay, se PIDE la contraseña del
#                         usuario postgres por teclado (oculta; no queda en el historial)
#   --admin-usuario=…     usuario administrador (por defecto: postgres)
#   --admin-host=…        equipo de PostgreSQL (por defecto: 127.0.0.1)
#   --admin-puerto=…      puerto de PostgreSQL (por defecto: 5432)
#   --recuperar-postgres  PostgreSQL ya estaba y su contraseña se perdió: la que se dé pasa a
#                         ser la nueva (se fija por la «ventana de confianza», solo 127.0.0.1)
#   --usuarios=a,b        cuentas a sembrar (por defecto SOLO `admin`; «all» = juego
#                         de desarrollo completo: admin, recepcion y los odontólogos)
#   --clave-admin=CLAVE   contraseña del administrador
#   --token-telegram=…    token de BotFather    · --usuario-telegram=…
#   --token-bot-admin=…   bot de administración (avisos) · --chat-bot-admin=…
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
  --nombre-mdns=NOMBRE   --ip=IP   --usuarios=a,b
  --admin-url=URL        --admin-usuario=…   --admin-host=…   --admin-puerto=…
  --recuperar-postgres   (la contraseña que se dé pasa a ser la NUEVA)
  --clave-admin=CLAVE    --sin-preguntas            --reconfigurar
  --token-telegram=…   --usuario-telegram=…
  --token-bot-admin=…  --chat-bot-admin=…   (avisos de fallos del sistema)
  --whatsapp-token=…   --whatsapp-phone-id=…   --whatsapp-verify-token=…   --whatsapp-app-secret=…

CANALES
  · Los tokens de Telegram se COMPRUEBAN contra la API: si el token vale, se enseña el nombre
    del bot (ese nombre se guarda como `TELEGRAM_BOT_USERNAME`, que es el del enlace
    t.me/<usuario>) y se completa solo.
  · El chat del administrador NO se pregunta: se DETECTA. Se te pedirá que le escribas
    «/start» al bot y se lee su `chat.id` de las actualizaciones.
  · Las credenciales de los canales se guardan SIEMPRE en notifications.env, también cuando se
    ejecuta una sola pieza (por ejemplo `--solo=desplegar`): no se quedan en la pantalla.
'@

$Comprobar = Test-Bandera $args 'comprobar'
$Solo = Get-Argumento $args 'solo'
$SinPreguntas = Test-Bandera $args 'sin-preguntas'
$Reconfigurar = Test-Bandera $args 'reconfigurar'
$DryRun = Test-Bandera $args 'dry-run'
$Nombre = Get-Argumento $args 'nombre-mdns'
$Ip = Get-Argumento $args 'ip'
$AdminUrl = Get-Argumento $args 'admin-url'
if (-not $AdminUrl) { $AdminUrl = $env:PG_ADMIN_URL }
$AdminUsuario = Get-Argumento $args 'admin-usuario'
$AdminHost = Get-Argumento $args 'admin-host'
$AdminPuerto = Get-Argumento $args 'admin-puerto'
$RecuperarPostgres = Test-Bandera $args 'recuperar-postgres'
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

  # La contraseña del administrador de PostgreSQL (el usuario del MOTOR, no el de la app). Se
  # pregunta aquí, una sola vez, y viaja a las piezas por ENTORNO. Es lo que sustituye a pasar
  # `--admin-url="postgres://postgres:CLAVE@…"` por la línea de órdenes, que dejaba la clave en
  # el historial de PowerShell. Hace falta en la 1 (que instala y comprueba el motor), en la 2
  # (que crea las bases) y en la 3 (que crea el rol de respaldo en su paso 10/10). Solo la
  # verificación (la 4) no la usa.
  if ($Solo -ne 'verificar' -and -not $AdminUrl) {
    $UsuarioAdmin = if ($AdminUsuario) { $AdminUsuario } else { 'postgres' }
    $EquipoAdmin = if ($AdminHost) { $AdminHost } else { '127.0.0.1' }
    $PuertoAdmin = if ($AdminPuerto) { [int]$AdminPuerto } else { 5432 }
    $Pregunta = 'Para crear las bases hace falta la contraseña del administrador de PostgreSQL.'
    if ($RecuperarPostgres) {
      $Pregunta = 'PostgreSQL ya está instalado y no se conoce su contraseña: la que escribas pasa a ser la NUEVA.'
    }
    # Si el motor se va a instalar AHORA (y no estamos recuperando una contraseña perdida),
    # Enter genera una al azar que se imprime UNA vez: esa contraseña nace con el motor.
    $AleatoriaSiVacia = ($null -eq (Get-PgBin)) -and -not $RecuperarPostgres
    $AdminUrl = Resolver-AdminUrlPostgres -Usuario $UsuarioAdmin -Equipo $EquipoAdmin `
      -Puerto $PuertoAdmin -Pregunta $Pregunta -AleatoriaSiVacia:$AleatoriaSiVacia
    if (-not $AdminUrl) {
      Escribir-Aviso 'sin contraseña de PostgreSQL: la instalación se detendrá antes de crear las bases'
    }
  }

  if (-not $TokenTelegram) {
    $r = Read-Host '      Token del bot de Telegram (Enter para omitir; queda en modo simulado)'
    if ($r) { $TokenTelegram = $r.Trim() }
  }
  # Un token de BotFather ronda los 45 caracteres: si es mucho más corto no es un token, y
  # guardarlo dejaría los avisos en un «modo simulado» que parece configurado (lo comprueba el
  # instalador de Fedora desde el primer día). Y se comprueba contra Telegram, que además dice
  # el nombre del bot: `TELEGRAM_BOT_USERNAME` es lo que arma el enlace `t.me/<usuario>`.
  if ($TokenTelegram -and $TokenTelegram.Length -lt 20) {
    Escribir-Aviso 'un token de BotFather tiene más de 20 caracteres: no lo guardo'
    $TokenTelegram = $null
  }
  if ($TokenTelegram) {
    $bot = Get-BotTelegram -Token $TokenTelegram
    if ($bot) {
      Escribir-Ok "Telegram confirma el bot: @$($bot.username)"
      if (-not $UsuarioTelegram) { $UsuarioTelegram = $bot.username }
    }
    else {
      Escribir-Aviso 'Telegram no confirmó ese token (¿internet?, ¿mal copiado?): se guarda igual'
    }
  }

  if (-not $TokenBotAdmin) {
    $r = Read-Host '      Token del bot de ADMINISTRACIÓN —avisos de fallos del sistema— (Enter para omitir)'
    if ($r) { $TokenBotAdmin = $r.Trim() }
  }
  if ($TokenBotAdmin -and $TokenBotAdmin.Length -lt 20) {
    Escribir-Aviso 'un token de BotFather tiene más de 20 caracteres: no lo guardo'
    $TokenBotAdmin = $null
  }
  # El chat de destino se DESCUBRE, no se pregunta: se le pide al administrador que le escriba
  # al bot y se lee su `chat.id` de las actualizaciones. Es lo que evita teclear un número que
  # nadie sabe de memoria (y equivocarse). Sin el chat, el bot de administración no puede avisar.
  if ($TokenBotAdmin -and -not $ChatBotAdmin) {
    $botAdmin = Get-BotTelegram -Token $TokenBotAdmin
    if (-not $botAdmin) {
      Escribir-Aviso 'Telegram no confirmó ese token de administración: se guarda igual'
    }
    else {
      Escribir-Ok "el bot de administración existe (@$($botAdmin.username))"
      for ($intento = 1; $intento -le 3; $intento++) {
        $ChatBotAdmin = Get-ChatTelegram -Token $TokenBotAdmin
        if ($ChatBotAdmin) { break }
        if ($intento -lt 3) {
          $aviso = "      Abre Telegram, escríbele «/start» a @$($botAdmin.username) y pulsa Enter"
          Read-Host "$aviso (intento $intento de 3)" | Out-Null
        }
      }
      if ($ChatBotAdmin) { Escribir-Ok "chat del administrador detectado: $ChatBotAdmin" }
      else {
        Escribir-Aviso 'no pude detectar el chat: se puede poner luego en notifications.env'
        Escribir-Detalle '    (ADMIN_TELEGRAM_CHAT_ID: escríbele algo al bot y copia el número)'
      }
    }
  }

  if (-not $WaToken) {
    $r = Read-Host '      Token de la WhatsApp Cloud API (Enter para omitir)'
    if ($r) { $WaToken = $r.Trim() }
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
# `--sin-preguntas` va a TODAS las piezas: la 1 y la 2 también preguntarían lo suyo si no, y
# aquí ya se decidió no preguntar nada. (Las que no lo conocen lo ignoran.)
if ($SinPreguntas) { $comunes += '--sin-preguntas' }
# `--recuperar-postgres` solo lo entiende la pieza 1 (es la que toca el motor); las demás lo
# ignoran sin quejarse.
if ($RecuperarPostgres) { $comunes += '--recuperar-postgres' }

$argsAprovisionar = @($comunes)
$argsDesplegar = @($comunes)
# La contraseña del MOTOR no viaja como argumento: en la lista de procesos del hijo la vería
# cualquiera de la máquina. Va por entorno (`PG_ADMIN_URL`, que el hijo hereda).

# ── Que las credenciales de los canales QUEDEN guardadas ────────────────────
# Los tokens y el resto de los datos de los canales viven en `notifications.env`, y quien los
# escribe es la pieza 2 (el aprovisionador). Si esta corrida NO la va a ejecutar, hay que
# llamarla en modo «solo archivos»: si no, se piden, se usan para comprobarlos… y se pierden al
# terminar (que es justo lo que pasaba con `--solo=desplegar`). Ese modo no toca la base ni las
# claves de firma; reescribe los `.env` conservando lo que ya había.
$hayCanales = [bool]($TokenTelegram -or $UsuarioTelegram -or $TokenBotAdmin -or $ChatBotAdmin -or
  $WaToken -or $WaPhone -or $WaVerify -or $WaAppSecret)
if ($hayCanales -and -not $DryRun -and -not ($Solo -in @('', 'aprovisionar'))) {
  Write-Host ''
  Escribir-Paso 'Guardando las credenciales de los canales'
  Invocar-Pieza 'Canales (solo los archivos)' '20-aprovisionar.ps1' (@($comunes) + '--solo-archivos')
}

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
