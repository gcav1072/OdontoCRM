#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · 2/4 · Aprovisionar: credenciales, bases, roles y usuarios
#
# **Esta es la ÚNICA pieza del despliegue que escribe credenciales.** Lo hace en
# `/etc/odontocrm/`, que es la única fuente de verdad (ADR 0043): genera cada
# secreto UNA vez, crea el rol y la base con ESA misma contraseña y después lo
# comprueba conectándose de verdad, uno por uno.
#
# Lo que NO hace: no copia secretos a ningún sitio, y no escribe nada dentro del
# código desplegado. No existe un segundo juego de credenciales que pueda
# desfasarse, que es la causa de fondo de los fallos anteriores.
#
#   sudo bash infra/fedora/instalar/20-aprovisionar.sh
#   sudo bash infra/fedora/instalar/20-aprovisionar.sh --admin-url="postgres://…/postgres"
#   sudo bash infra/fedora/instalar/20-aprovisionar.sh --solo-verificar   # no cambia nada
#   sudo bash infra/fedora/instalar/20-aprovisionar.sh --rotate           # contraseñas nuevas
#   sudo bash infra/fedora/instalar/20-aprovisionar.sh --dry-run
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS="$NOMBRE_MDNS_POR_DEFECTO"
IP=""
ADMIN_URL=""
EXTRAS=()
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --ip=*) IP="${arg#*=}" ;;
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    --rotate) EXTRAS+=(--rotate) ;;
    --solo-verificar) EXTRAS+=(--solo-verificar) ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"

# `--dry-run` no toca nada, así que se puede ejecutar sin sudo: es la forma de
# revisar el plan completo en una máquina que todavía no es el servidor.
(( DRY_RUN )) || exigir_root

printf '%sOdontoCRM · 2/4 · Aprovisionar%s\n' "$C_TI" "$C_RE"

# La IP de la LAN se deduce sola: es la que van a teclear los aparatos de la
# consulta, y con ella se forma WEB_ORIGIN (el CORS del gateway).
[[ -n "$IP" ]] || IP="$(ip_lan)"
[[ -n "$IP" ]] && detalle "IP de la LAN: $IP" || av 'no pude deducir la IP de la LAN (usa --ip=…)'

argumentos=(
  "$ORIGEN/infra/fedora/instalar/aprovisionar.mjs"
  "--env-dir=$ETC_DIR"
  "--host=$NOMBRE_MDNS"
  "--tz=$ZONA_HORARIA"
)
[[ -n "$IP" ]] && argumentos+=("--ip=$IP")
[[ -n "$ADMIN_URL" ]] && argumentos+=("--admin-url=$ADMIN_URL")
(( DRY_RUN )) && argumentos+=(--dry-run)
(( ${#EXTRAS[@]} > 0 )) && argumentos+=("${EXTRAS[@]}")

command -v node >/dev/null 2>&1 || morir 'no encuentro `node`: ejecuta antes 10-preparar.sh'

node "${argumentos[@]}"
codigo=$?

# Los permisos se vuelven a fijar aquí y no se delegan: systemd lee estos archivos
# COMO ROOT y le pasa las variables al proceso, así que 0600 root:root es correcto
# y el servicio no necesita poder leerlos.
if (( codigo == 0 )) && (( ! DRY_RUN )) && [[ -d "$ETC_DIR" ]]; then
  chown root:root "$ETC_DIR"/*.env 2>/dev/null || true
  chmod 0600 "$ETC_DIR"/*.env 2>/dev/null || true
  chown -R root:"$SERVICE_GROUP" "$ETC_DIR/keys" 2>/dev/null || true
  chmod 0750 "$ETC_DIR" "$ETC_DIR/keys" 2>/dev/null || true
  ok "permisos de $ETC_DIR revisados (0600 root:root los .env, 0750 root:$SERVICE_GROUP el resto)"
fi

(( codigo == 0 )) || morir "el aprovisionamiento falló (código $codigo)"
printf '\n%s2/4 listo.%s Las credenciales viven SOLO en %s y conectan.\n' "$C_TI" "$C_RE" "$ETC_DIR"
detalle "siguiente:  sudo bash $INSTALADOR_DIR/30-desplegar.sh"
