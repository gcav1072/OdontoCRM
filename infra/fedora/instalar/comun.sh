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

# Lee `CLAVE=VALOR` de un archivo de entorno, sin interpretarlo (nada de `source`).
leer_clave_entorno() {
  local archivo="$1" clave="$2"
  [[ -r "$archivo" ]] || return 0
  sed -n "s/^${clave}=//p" "$archivo" 2>/dev/null | head -1 || true
}

# El nombre con el que entran los equipos de la consulta.
#
# Si no se pasa `--nombre-mdns`, se RECUPERA el que se usó al aprovisionar (queda en
# odontocrm.env). Importa: `odontocrm actualizar` llama al despliegue sin argumentos,
# y sin esto una clínica instalada como `consultorio` volvía a `odontocrm.local` en
# cada actualización —reemitiendo el certificado para el nombre equivocado—, con lo
# que los equipos se quedaban con el aviso de certificado.
resolver_nombre() {
  local nombre="${1:-}"
  if [[ -z "$nombre" ]]; then
    nombre="$(leer_clave_entorno "$ETC_DIR/odontocrm.env" ODONTOCRM_NOMBRE || true)"
  fi
  printf '%s' "${nombre:-$NOMBRE_MDNS_POR_DEFECTO}"
}

# El nombre completo: se le añade `.local` (el espacio de mDNS) salvo que ya traiga
# un dominio propio. Es el error que hacía que WEB_ORIGIN y PUBLIC_APP_URL dijeran
# `https://odontocrm` mientras el certificado y nginx usaban `odontocrm.local`: el QR
# de todos los récipes apuntaba a un nombre que no resuelve en ningún equipo.
nombre_fqdn() {
  local nombre="${1:-}"
  if [[ "$nombre" == *.* ]]; then printf '%s' "$nombre"; else printf '%s.local' "$nombre"; fi
}

# ¿El certificado cubre TODOS estos nombres? Se mira el `subjectAltName` real, no
# el archivo: se usa para no reemitir un certificado que ya sirve (pisar uno propio
# de la clínica sin avisar sería perder el que emitió su proveedor) y para que la
# verificación diga la verdad.
cert_cubre() {
  local cert="$1"
  shift
  [[ -f "$cert" ]] || return 1
  local alt
  alt="$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')" || true
  [[ -n "$alt" ]] || return 1
  local nombre
  for nombre in "$@"; do
    grep -q "$nombre" <<<"$alt" || return 1
  done
  return 0
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
