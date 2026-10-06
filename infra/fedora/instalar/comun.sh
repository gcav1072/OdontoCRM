#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · utilidades compartidas por las piezas del instalador
#
# Es una BIBLIOTECA (fedora:check-ok biblioteca): NO se ejecuta sola. Las otras
# piezas la cargan con `source`, y los traps de «no te cortes en silencio» los pone
# cada pieza en su propio archivo. Aquí solo hay salida por pantalla, rutas y
# comprobaciones; ninguna decisión de instalación.
#
# Las rutas se pueden sobrescribir por entorno. Existe sobre todo para poder
# PROBAR las piezas sin tocar la máquina (p. ej. ODONTOCRM_ENV_DIR=/tmp/prueba),
# que es lo que permite comprobar el instalador antes de usarlo en la clínica.
# =============================================================================

# ── Salida ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_OK=$'\033[32m✔\033[0m'; C_AV=$'\033[33m!\033[0m'; C_ER=$'\033[31m✖\033[0m'
  C_TI=$'\033[1m'; C_DIM=$'\033[2m'; C_RE=$'\033[0m'
else
  C_OK='✔'; C_AV='!'; C_ER='✖'; C_TI=''; C_DIM=''; C_RE=''
fi

ok() { printf '  %s %s\n' "$C_OK" "$1"; }
av() { printf '  %s %s\n' "$C_AV" "$1"; }
err() { printf '  %s %s\n' "$C_ER" "$1" >&2; }
paso() { printf '\n%s== %s ==%s\n' "$C_TI" "$1" "$C_RE"; }
detalle() { printf '      %s%s%s\n' "$C_DIM" "$1" "$C_RE"; }
morir() {
  printf '\n%s %s\n' "$C_ER" "$1" >&2
  exit 1
}

# ── Rutas ────────────────────────────────────────────────────────────────────
# El repositorio se deduce del propio guion: así funciona desde cualquier clon,
# de cualquier usuario y en cualquier ruta (fue uno de los fallos que más costó:
# rutas grabadas de una PC concreta).
INSTALADOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   infra/fedora/instalar/comun.sh  →  INSTALADOR_DIR = infra/fedora/instalar
#                                   →  ORIGEN = la raíz del repositorio (tres niveles arriba)
ORIGEN="$(cd "$INSTALADOR_DIR/../../.." && pwd)"

[[ -f "$ORIGEN/package.json" ]] ||
  morir "no encuentro la raíz del repositorio en $ORIGEN (¿se movió infra/fedora/instalar?)"

CODE_DIR="${ODONTOCRM_CODE_DIR:-/opt/odontocrm}"
ETC_DIR="${ODONTOCRM_ENV_DIR:-/etc/odontocrm}"
DATA_DIR="${ODONTOCRM_DATA_DIR:-/var/lib/odontocrm}"
LOG_DIR="${ODONTOCRM_LOG_DIR:-/var/log/odontocrm}"
BACKUP_DIR="${ODONTOCRM_BACKUP_DIR:-/var/backups/odontocrm}"

SERVICE_USER="${ODONTOCRM_USER:-odontocrm}"
SERVICE_GROUP="${ODONTOCRM_GROUP:-odontocrm}"

# Los 8 servicios con base de datos propia, en orden. El gateway va aparte: no
# tiene base de datos y su unidad es otra.
SERVICIOS=(identity patients scheduling notifications clinical odontogram screens reporting)
PUERTO_GATEWAY=8090
NOMBRE_MDNS_POR_DEFECTO=odontocrm
ZONA_HORARIA="${ODONTOCRM_TZ:-America/Caracas}"

# ── Comprobaciones ───────────────────────────────────────────────────────────
es_root() { [[ "$(id -u)" == "0" ]]; }

exigir_root() {
  es_root && return 0
  morir "esta pieza necesita sudo:  sudo bash $0 $*"
}

# El usuario real detrás de sudo. Sin sudo (root de verdad) no hay ninguno.
usuario_real() {
  if es_root && [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    printf '%s' "$SUDO_USER"
  else
    printf '%s' "${USER:-root}"
  fi
}

# IP de la LAN por la que sale el tráfico (no la de loopback ni la de docker).
ip_lan() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip"
}

interfaz_lan() {
  ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1 || true
}

# La red /24 de la interfaz por la que se sale a la LAN (para abrir 443 solo ahí).
red_lan() {
  local iface
  iface="$(interfaz_lan)"
  [[ -n "$iface" ]] || return 0
  ip -o -f inet addr show dev "$iface" 2>/dev/null | awk 'NR==1 {print $4; exit}' || true
}

# ── Ejecución que respeta --dry-run ──────────────────────────────────────────
DRY_RUN="${DRY_RUN:-0}"
ejecutar() {
  if (( DRY_RUN )); then
    printf '      %s[dry-run] %s%s\n' "$C_DIM" "$*" "$C_RE"
    return 0
  fi
  "$@"
}
