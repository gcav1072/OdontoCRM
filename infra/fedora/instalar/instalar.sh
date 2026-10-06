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
# Al terminar imprime la dirección por la que entran los aparatos de la consulta.
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS="$NOMBRE_MDNS_POR_DEFECTO"
LAN_CIDR=""
ADMIN_URL=""
CON_DNS=0
SIN_RESPALDO=0
ROTAR=0
COMPROBAR=0
SOLO=""
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
    -h | --help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

COMUNES=(--nombre-mdns="$NOMBRE_MDNS")
(( DRY_RUN )) && COMUNES+=(--dry-run)
[[ -n "$ADMIN_URL" ]] && COMUNES+=(--admin-url="$ADMIN_URL")

ARGS_APROV=("${COMUNES[@]}")
ARGS_DESP=("${COMUNES[@]}")
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
printf '      %shttps://%s.local%s\n\n' "$C_TI" "$NOMBRE_MDNS" "$C_RE"
printf '  El día a día del servidor:\n'
printf '      sudo odontocrm estado        cómo va todo\n'
printf '      sudo odontocrm verificar     los 9 servicios, uno a uno\n'
printf '      sudo odontocrm respaldar     copia de seguridad ahora\n'
printf '      sudo odontocrm actualizar    traer la versión nueva\n\n'
printf '  Los secretos viven SOLO en %s. El código de %s\n' "$ETC_DIR" "$CODE_DIR"
printf '  no contiene ninguno: se puede borrar y volver a clonar sin perder nada.\n\n'
