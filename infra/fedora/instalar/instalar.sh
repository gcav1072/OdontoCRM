#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · INSTALADOR — un solo comando para un servidor nuevo
#
#   sudo bash infra/fedora/instalar/instalar.sh
#
# Encadena las cuatro piezas, en orden, y se detiene en la primera que falle
# diciendo exactamente con qué se retoma. Cada pieza se puede ejecutar sola:
#
#   10-preparar.sh      la máquina: paquetes, PostgreSQL, Node, nginx, mkcert,
#                       pg_hba, firewalld, avahi… y los directorios con permisos
#   20-aprovisionar.sh  las credenciales (ÚNICA fuente: /etc/odontocrm), las bases,
#                       los roles y los usuarios; comprueba que cada una CONECTE
#   30-desplegar.sh     el código (sin secretos) en /opt, migraciones, unidades de
#                       systemd, certificado TLS, proxy, SELinux y firewall
#   40-verificar.sh     el efecto: servicio a servicio, HTTPS, CA y puertos
#
# Opciones:
#   --con-dns               publica también el nombre por DNS propio (dnsmasq) para
#                           los Android que no entienden mDNS
#   --lan-cidr=192.168.1.0/24   abre 443 SOLO a esa red (recomendado en la clínica)
#   --nombre-mdns=consultorio   el nombre con el que entran los equipos (.local)
#   --admin-url=URL         cómo entrar a PostgreSQL como administrador; si no se
#                           indica, se usa el socket como usuario «postgres»
#   --rotar-credenciales    genera contraseñas NUEVAS (invalida las anteriores)
#   --sin-respaldo          no programa el respaldo diario
#   --solo=PIEZA            preparar | aprovisionar | desplegar | verificar
#   --comprobar             solo dice si la máquina está lista; no toca nada
#   --dry-run               enseña lo que haría, sin hacerlo
#
# Preguntas (una instalación nueva): la contraseña del administrador y, si se quieren
# ya, el token del bot de Telegram y las credenciales de WhatsApp. Se guardan en
# /etc/odontocrm (0600) y en la clave del admin; con Enter se omite cada una. Sin
# terminal, con `--sin-preguntas` o en `odontocrm actualizar` no se pregunta nada:
# la clave del admin se genera temporal y el bot queda en modo simulado.
#
#   --usuarios=admin,recepcion   cuentas a sembrar (por defecto SOLO `admin`: el
#                                resto del personal se da de alta desde /usuarios)
#   --con-todas-las-cuentas      siembra también `recepcion` y los odontólogos
#   --clave-admin=CLAVE          contraseña del administrador
#   --token-telegram=…           token de BotFather
#   --usuario-telegram=…         usuario del bot, sin @
#   --whatsapp-token=…           token de la WhatsApp Cloud API
#   --whatsapp-phone-id=…        identificador del número
#   --whatsapp-verify-token=…    el que inventa la clínica para el webhook
#   --whatsapp-app-secret=…      el App Secret de Meta
#   --sin-preguntas              no pregunta nada
#   --reconfigurar               vuelve a preguntar aunque ya haya valores
#
# Al terminar imprime la dirección por la que entran los aparatos de la consulta.
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS=""   # vacío = el que ya estuviera aprovisionado (ver comun.sh)
LAN_CIDR=""
ADMIN_URL=""
CON_DNS=0
SIN_RESPALDO=0
ROTAR=0
COMPROBAR=0
SOLO=""
SIN_PREGUNTAS="${SIN_PREGUNTAS:-0}"
RECONFIGURAR=0
# El servidor siembra SOLO el administrador: el resto del personal se da de alta desde
# la aplicación (`/usuarios`), que es donde tiene sentido decidir rol y datos.
USUARIOS_SEED="${USUARIOS_SEED:-admin}"
# Los datos que se pueden dar por bandera (o por entorno: son los mismos nombres que
# leen los servicios, así que exportarlos en la shell también vale).
CLAVE_ADMIN="${SEED_PASSWORD_ADMIN:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_BOT_USERNAME="${TELEGRAM_BOT_USERNAME:-}"
WHATSAPP_TOKEN="${WHATSAPP_TOKEN:-}"
WHATSAPP_PHONE_ID="${WHATSAPP_PHONE_ID:-}"
WHATSAPP_VERIFY_TOKEN="${WHATSAPP_VERIFY_TOKEN:-}"
WHATSAPP_APP_SECRET="${WHATSAPP_APP_SECRET:-}"
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --lan-cidr=*) LAN_CIDR="${arg#*=}" ;;
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    --con-dns) CON_DNS=1 ;;
    --sin-respaldo) SIN_RESPALDO=1 ;;
    --rotar-credenciales) ROTAR=1 ;;
    --comprobar) COMPROBAR=1 ;;
    --solo=*) SOLO="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --sin-preguntas) SIN_PREGUNTAS=1 ;;
    --reconfigurar) RECONFIGURAR=1 ;;
    --usuarios=*) USUARIOS_SEED="${arg#*=}" ;;
    --con-todas-las-cuentas) USUARIOS_SEED="" ;;
    --clave-admin=*) CLAVE_ADMIN="${arg#*=}" ;;
    --token-telegram=*) TELEGRAM_BOT_TOKEN="${arg#*=}" ;;
    --usuario-telegram=*) TELEGRAM_BOT_USERNAME="${arg#*=}" ;;
    --whatsapp-token=*) WHATSAPP_TOKEN="${arg#*=}" ;;
    --whatsapp-phone-id=*) WHATSAPP_PHONE_ID="${arg#*=}" ;;
    --whatsapp-verify-token=*) WHATSAPP_VERIFY_TOKEN="${arg#*=}" ;;
    --whatsapp-app-secret=*) WHATSAPP_APP_SECRET="${arg#*=}" ;;
    -h | --help) sed -n '2,51p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"
export DRY_RUN

# ── Modo comprobación: ¿está la máquina lista? No toca NADA. ────────────────
# Es lo primero que uno quiere saber antes de empezar, y se puede ejecutar sin
# sudo: aquí no se escribe nada.
if (( COMPROBAR )); then
  printf '%s¿Está esta máquina lista para instalar?%s\n\n' "$C_TI" "$C_RE"
  problemas=0
  revisar() {
    if eval "$2" >/dev/null 2>&1; then ok "$1"; else av "$1 → $3"; problemas=$((problemas + 1)); fi
  }
  revisar 'Fedora (o compatible con dnf)' 'command -v dnf' 'este instalador usa dnf'
  revisar 'Node 22.9 o superior' 'node -e "process.exit(Number(process.versions.node.split(\".\")[0])>=22?0:1)"' 'lo instala la pieza 1'
  revisar 'npm disponible' 'command -v npm' 'viene con Node'
  revisar 'PostgreSQL instalado' 'command -v psql' 'lo instala la pieza 1'
  revisar 'git disponible' 'command -v git' 'lo instala la pieza 1'
  revisar 'el repositorio es un clon de git' "git -C \"$ORIGEN\" rev-parse --git-dir" 'clona el repositorio; no copies la carpeta'
  revisar 'hay conexión a internet' 'timeout 8 curl -fsSI https://registry.npmjs.org >/dev/null' 'hace falta para npm ci, NodeSource y mkcert'
  revisar 'ninguna otra pila usa los puertos' '! pgrep -f "node --watch|tools/stack.mjs"' 'para la pila de desarrollo: npm run dev:stop'

  # Y si ya hay una instalación, se dice en qué estado está (sin cambiarla).
  if [[ -f "$ETC_DIR/odontocrm.env" ]]; then
    echo
    ok "ya hay un entorno aprovisionado en $ETC_DIR (esto es una repetición, no una instalación desde cero)"
  fi
  echo
  (( problemas == 0 )) && ok 'todo listo:  sudo bash infra/fedora/instalar/instalar.sh' ||
    av "$problemas cosa(s) por resolver antes de empezar (arriba está cada una)"
  exit 0
fi

# `--dry-run` no toca nada: se puede revisar el plan sin sudo, igual que en las piezas.
(( DRY_RUN )) || exigir_root

# ── Las cuatro piezas ───────────────────────────────────────────────────────
# Cada una se ejecuta en un proceso aparte: si una falla, el instalador se para
# ahí y NO sigue con las siguientes sobre una base a medias.
pieza() {
  local nombre="$1" guion="$2"
  shift 2
  paso "$nombre"
  if bash "$INSTALADOR_DIR/$guion" "$@"; then
    return 0
  fi
  echo
  err "la pieza «$nombre» falló."
  printf '      Se retoma exactamente desde ahí con:\n' >&2
  printf '          sudo bash %s/%s%s\n\n' "$INSTALADOR_DIR" "$guion" "${1:+ $*}" >&2
  printf '      Nada de lo que ya se hizo se pierde: todas las piezas son idempotentes.\n' >&2
  exit 1
}

printf '%s╔══════════════════════════════════════════════════════════════════╗%s\n' "$C_TI" "$C_RE"
printf '%s║  OdontoCRM · instalación del servidor de la consulta             ║%s\n' "$C_TI" "$C_RE"
printf '%s╚══════════════════════════════════════════════════════════════════╝%s\n' "$C_TI" "$C_RE"
detalle "repositorio : $ORIGEN"
detalle "código      : $CODE_DIR"
detalle "secretos    : $ETC_DIR   (única fuente de verdad — ADR 0043)"
detalle "usuario     : $(usuario_real)"
(( DRY_RUN )) && av '--dry-run: no se cambia nada'
(( ROTAR )) && av '--rotar-credenciales: se generan contraseñas NUEVAS'

# ── Los datos que no se pueden inventar ─────────────────────────────────────
# Se preguntan UNA vez, aquí, y viajan por entorno a las piezas 2 y 3 —que siguen
# siendo desatendidas: `odontocrm actualizar` ejecuta la 3 sin pasar por este guion—.
#
# · Sin terminal, con `--sin-preguntas` o en `--dry-run` no se pregunta nada: la clave
#   del admin se genera temporal y el bot queda en modo simulado, como siempre.
# · Lo que ya esté configurado no se vuelve a preguntar (`--reconfigurar` lo fuerza):
#   repetir la instalación no debe borrar ni reescribir el token de nadie.
preguntar_secreto() { # $1 título · $2 pista · $3 texto del prompt (opcional)
  [[ -t 0 && $SIN_PREGUNTAS -eq 0 ]] || return 1
  printf '\n  %s%s%s\n' "$C_TI" "$1" "$C_RE" >&2
  [[ -n "${2:-}" ]] && detalle "$2" >&2
  local valor=""
  # Se lee de /dev/tty a propósito: si la salida va a un registro (`| tee`), la pregunta
  # sigue siendo interactiva y **lo tecleado no aparece** en el registro. Y el texto del
  # prompt se puede cambiar: en la confirmación no tiene sentido ofrecer «Enter para
  # omitir» (omitir la confirmación no significa nada, la clave ya está escrita).
  read -r -s -p "${3:-      valor (Enter para omitir): }" valor </dev/tty || valor=""
  printf '\n' >&2
  [[ -n "$valor" ]] || return 1
  printf '%s' "$valor"
}

preguntar_texto() { # igual, pero a la vista
  [[ -t 0 && $SIN_PREGUNTAS -eq 0 ]] || return 1
  printf '\n  %s%s%s\n' "$C_TI" "$1" "$C_RE" >&2
  [[ -n "${2:-}" ]] && detalle "$2" >&2
  local valor=""
  read -r -p '      valor (Enter para omitir): ' valor </dev/tty || valor=""
  [[ -n "$valor" ]] || return 1
  printf '%s' "$valor"
}

preguntar_si() { # 0 = sí · 1 = no (también cuando no hay terminal)
  [[ -t 0 && $SIN_PREGUNTAS -eq 0 ]] || return 1
  local respuesta=""
  read -r -p "  $1 [s/N] " respuesta </dev/tty || respuesta=""
  [[ "$respuesta" =~ ^[sSyY] ]]
}

ya_configurado() { # $1 archivo · $2 clave: ¿ya tiene valor? (--reconfigurar lo ignora)
  (( RECONFIGURAR )) && return 1
  [[ -f "$1" ]] || return 1
  grep -qE "^$2=.+" "$1" 2>/dev/null
}

if (( DRY_RUN )); then
  detalle '[dry-run] no se pregunta nada'
elif [[ -n "$SOLO" && "$SOLO" != "aprovisionar" && "$SOLO" != "desplegar" ]]; then
  detalle "--solo=$SOLO: no hace falta preguntar nada"
elif (( SIN_PREGUNTAS )); then
  detalle '--sin-preguntas: clave del admin al azar y bot en modo simulado'
elif [[ ! -t 0 ]]; then
  detalle 'sin terminal: clave del admin al azar y bot en modo simulado'
  detalle 'para configurarlo después:  RUNBOOK §5 (usuarios) y §6 (bot)'
else
  printf '\n%sPuesta en marcha%s — se crea la cuenta «admin»; Enter omite lo demás\n' "$C_TI" "$C_RE"

  # 1) La contraseña del administrador (solo si es una instalación nueva).
  if [[ -n "$CLAVE_ADMIN" ]]; then
    detalle 'contraseña del administrador: la que pasaste por bandera'
  elif [[ -f "$ETC_DIR/odontocrm.env" ]] && (( ! RECONFIGURAR )); then
    detalle 'ya hay un entorno aprovisionado: no se toca la contraseña del administrador'
  else
    while true; do
      if ! valor="$(preguntar_secreto 'Contraseña del administrador' 'Mínimo 10 caracteres. Nace temporal: el sistema pedirá cambiarla al primer acceso.')"; then
        detalle 'sin contraseña: se generará una temporal y se imprimirá UNA vez'
        break
      fi
      if (( ${#valor} < 10 )); then
        err 'menos de 10 caracteres: no la guardo, prueba otra vez'
        continue
      fi
      if ! repetida="$(preguntar_secreto 'Repite la contraseña del administrador' '' '      repítela: ')"; then
        err 'no la repetiste: vuelve a empezar'
        continue
      fi
      if [[ "$valor" != "$repetida" ]]; then
        err 'no coinciden: vuelve a empezar'
        continue
      fi
      CLAVE_ADMIN="$valor"
      ok 'contraseña del administrador guardada (no se imprime en ningún sitio)'
      break
    done
  fi

  # 2) El bot de Telegram, con el token comprobado contra Telegram: un token mal copiado
  #    se descubre aquí y no tres días después, cuando un paciente no recibe su aviso.
  if [[ -z "$TELEGRAM_BOT_TOKEN" ]] && ! ya_configurado "$ETC_DIR/notifications.env" 'TELEGRAM_BOT_TOKEN'; then
    if valor="$(preguntar_secreto 'Token del bot de Telegram (BotFather)' 'Sin él los avisos quedan en la bandeja como pendientes manuales; se puede poner después.')"; then
      if (( ${#valor} < 20 )); then
        av 'un token de BotFather tiene más de 20 caracteres: no lo guardo'
      else
        TELEGRAM_BOT_TOKEN="$valor"
      fi
    fi
  fi
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]] && command -v curl >/dev/null; then
    if respuesta="$(timeout 10 curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null)" &&
      [[ "$respuesta" == *'"ok":true'* ]]; then
      TELEGRAM_BOT_USERNAME="$(printf '%s' "$respuesta" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
      ok "Telegram confirma el bot: @${TELEGRAM_BOT_USERNAME}"
    else
      av 'Telegram no confirmó ese token (¿internet?, ¿mal copiado?): se guarda igual'
      detalle "se corrige en $ETC_DIR/notifications.env y reiniciando odontocrm@notifications"
    fi
  fi
  if [[ -n "$TELEGRAM_BOT_TOKEN" && -z "$TELEGRAM_BOT_USERNAME" ]] &&
    ! ya_configurado "$ETC_DIR/notifications.env" 'TELEGRAM_BOT_USERNAME'; then
    if valor="$(preguntar_texto 'Usuario del bot, sin @' 'Es el que arma el enlace t.me/<usuario> (opcional).')"; then
      TELEGRAM_BOT_USERNAME="${valor#@}"
    fi
  fi

  # 3) WhatsApp (Cloud API): cuatro datos, y los tres últimos solo se tienen al crear la
  #    app en Meta. Se pueden dejar para después; el canal simplemente no se activa.
  if [[ -z "$WHATSAPP_TOKEN" ]] && ! ya_configurado "$ETC_DIR/notifications.env" 'WHATSAPP_TOKEN'; then
    if preguntar_si '¿Configurar WhatsApp ahora (Cloud API de Meta)?'; then
      if valor="$(preguntar_secreto 'Token de la WhatsApp Cloud API')" && (( ${#valor} >= 20 )); then
        WHATSAPP_TOKEN="$valor"
      else
        av 'sin un token de 20 caracteres o más no configuro WhatsApp: se omite'
      fi
    fi
  fi
  if [[ -n "$WHATSAPP_TOKEN" ]]; then
    if [[ -z "$WHATSAPP_PHONE_ID" ]]; then
      valor="$(preguntar_texto 'Identificador del número (phone number ID)')" && WHATSAPP_PHONE_ID="$valor"
    fi
    if [[ -z "$WHATSAPP_VERIFY_TOKEN" ]]; then
      valor="$(preguntar_texto 'Verify token del webhook' 'Lo inventa la clínica: Meta lo repite al verificar. Mínimo 8 caracteres.')" &&
        WHATSAPP_VERIFY_TOKEN="$valor"
    fi
    if [[ -z "$WHATSAPP_APP_SECRET" ]]; then
      valor="$(preguntar_secreto 'App Secret de Meta' 'Firma los webhooks (App settings → Basic).')" &&
        WHATSAPP_APP_SECRET="$valor"
    fi
  fi

  # Resumen sin secretos: lo que va a quedar configurado. Se mira TAMBIÉN lo que ya esté
  # en /etc/odontocrm: en una instalación repetida el token sigue ahí y decir «sin token»
  # haría pensar que se ha perdido (se conserva, que es lo que hace aprovisionar).
  resumen_admin='temporal al azar (se imprime una vez)'
  if [[ -n "$CLAVE_ADMIN" ]]; then
    resumen_admin='con la contraseña que elegiste'
  elif [[ -f "$ETC_DIR/odontocrm.env" ]] && (( ! RECONFIGURAR )); then
    resumen_admin='sin cambios (ya hay un entorno aprovisionado)'
  fi
  resumen_tg='sin token: modo simulado'
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    resumen_tg="con token (@${TELEGRAM_BOT_USERNAME:-sin usuario})"
  elif ya_configurado "$ETC_DIR/notifications.env" 'TELEGRAM_BOT_TOKEN'; then
    resumen_tg='ya configurado en el servidor (se conserva)'
  fi
  resumen_wa='no configurado'
  if [[ -n "$WHATSAPP_TOKEN" ]]; then
    resumen_wa='configurado ahora'
  elif ya_configurado "$ETC_DIR/notifications.env" 'WHATSAPP_TOKEN'; then
    resumen_wa='ya configurado en el servidor (se conserva)'
  fi
  printf '\n'
  detalle "cuentas a crear : ${USUARIOS_SEED:-admin, recepcion y los odontólogos de clinic.ts}"
  detalle "admin           : $resumen_admin"
  detalle "Telegram        : $resumen_tg"
  detalle "WhatsApp        : $resumen_wa"
fi

# Los valores viajan a las piezas por ENTORNO, nunca como argumentos (en `ps` los vería
# cualquiera de la máquina). El vacío significa «no lo toques»: aprovisionar conserva lo
# que ya hubiera escrito y desplegar genera la contraseña temporal.
#
# **Solo se exporta lo que TIENE valor.** Una variable exportada y VACÍA no es «ausente»
# para los esquemas de los servicios (son `.min(20).optional()`, y `''` no pasa el
# mínimo), y `con-entorno` pasa a las migraciones y a los servicios el entorno del
# proceso tal cual: exportar `WHATSAPP_TOKEN=''` desde aquí tumbaba las migraciones de
# notifications con «Configuración inválida … el valor es más corto o menor de lo
# permitido». Pasó en la primera instalación de verdad (el WhatsApp se dejó sin
# configurar), y era el propio instalador quien envenenaba el entorno.
export USUARIOS_SEED
[[ -n "$CLAVE_ADMIN" ]] && export SEED_PASSWORD_ADMIN="$CLAVE_ADMIN"
[[ -n "$TELEGRAM_BOT_TOKEN" ]] && export TELEGRAM_BOT_TOKEN
[[ -n "$TELEGRAM_BOT_USERNAME" ]] && export TELEGRAM_BOT_USERNAME
[[ -n "$WHATSAPP_TOKEN" ]] && export WHATSAPP_TOKEN
[[ -n "$WHATSAPP_PHONE_ID" ]] && export WHATSAPP_PHONE_ID
[[ -n "$WHATSAPP_VERIFY_TOKEN" ]] && export WHATSAPP_VERIFY_TOKEN
[[ -n "$WHATSAPP_APP_SECRET" ]] && export WHATSAPP_APP_SECRET

NOMBRE_MDNS="$(resolver_nombre "$NOMBRE_MDNS")"
FQDN="$(nombre_fqdn "$NOMBRE_MDNS")"
COMUNES=(--nombre-mdns="$NOMBRE_MDNS")
(( DRY_RUN )) && COMUNES+=(--dry-run)

# OJO: `--admin-url` NO va en COMUNES. Lo entienden las piezas 2 y 3, pero la 1
# (preparar la máquina) no lo conoce y abortaría con «opción no reconocida» en el
# primer paso de la instalación —que es exactamente lo que hacía—.
ARGS_APROV=("${COMUNES[@]}")
ARGS_DESP=("${COMUNES[@]}")
[[ -n "$ADMIN_URL" ]] && ARGS_APROV+=(--admin-url="$ADMIN_URL")
[[ -n "$ADMIN_URL" ]] && ARGS_DESP+=(--admin-url="$ADMIN_URL")
(( ROTAR )) && ARGS_APROV+=(--rotate)
(( CON_DNS )) && ARGS_DESP+=(--con-dns)
(( SIN_RESPALDO )) && ARGS_DESP+=(--sin-respaldo)
# Sin --lan-cidr, la pieza abre el 443 en la zona de la interfaz de la LAN.
[[ -n "$LAN_CIDR" ]] && ARGS_DESP+=(--lan-cidr="$LAN_CIDR")

case "$SOLO" in
  preparar) pieza '1/4 · Preparar la máquina' 10-preparar.sh "${COMUNES[@]}" ;;
  aprovisionar) pieza '2/4 · Aprovisionar' 20-aprovisionar.sh "${ARGS_APROV[@]}" ;;
  desplegar) pieza '3/4 · Desplegar' 30-desplegar.sh "${ARGS_DESP[@]}" ;;
  verificar) pieza '4/4 · Verificar' 40-verificar.sh --nombre-mdns="$NOMBRE_MDNS" ;;
  '') ;;
  *) morir "--solo=$SOLO no existe. Opciones: preparar, aprovisionar, desplegar, verificar" ;;
esac

if [[ -z "$SOLO" ]]; then
  pieza '1/4 · Preparar la máquina' 10-preparar.sh "${COMUNES[@]}"
  pieza '2/4 · Aprovisionar bases, roles y credenciales' 20-aprovisionar.sh "${ARGS_APROV[@]}"
  pieza '3/4 · Desplegar el servidor' 30-desplegar.sh "${ARGS_DESP[@]}"

  paso '4/4 · Verificar'
  if (( DRY_RUN )); then
    # En `--dry-run` no se verifica de verdad: la instalación todavía no existe, así
    # que lo único que saldría son fallos inventados. Además las comprobaciones tocan
    # cosas que necesitan root (firewall, certificado) y colgarían o mentirían.
    detalle "[dry-run] comprobaría los 9 servicios, HTTPS, la CA y los puertos"
    detalle "    sudo bash $INSTALADOR_DIR/40-verificar.sh"
  elif ! bash "$INSTALADOR_DIR/40-verificar.sh" --nombre-mdns="$NOMBRE_MDNS"; then
    echo
    av 'hay algo que arreglar (arriba está cada cosa con lo que le falta).'
    detalle 'la instalación queda hecha; corrige lo señalado y repite la verificación:'
    detalle "    sudo bash $INSTALADOR_DIR/40-verificar.sh"
    exit 1
  fi
fi

printf '\n%s══════════════════════════════════════════════════════════════════%s\n' "$C_TI" "$C_RE"
printf '%s  Instalación terminada%s\n' "$C_TI" "$C_RE"
printf '%s══════════════════════════════════════════════════════════════════%s\n\n' "$C_TI" "$C_RE"
printf '  Desde los aparatos de la consulta:\n'
printf '      %shttps://%s%s\n\n' "$C_TI" "$FQDN" "$C_RE"
printf '  El día a día del servidor:\n'
printf '      sudo odontocrm estado        cómo va todo\n'
printf '      sudo odontocrm verificar     los 9 servicios, uno a uno\n'
printf '      sudo odontocrm respaldar     copia de seguridad ahora\n'
printf '      sudo odontocrm actualizar    traer la versión nueva\n\n'
printf '  Los secretos viven SOLO en %s. El código de %s\n' "$ETC_DIR" "$CODE_DIR"
printf '  no contiene ninguno: se puede borrar y volver a clonar sin perder nada.\n\n'
