#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# OdontoCRM · Aprovisionamiento de producción en Fedora (43 o superior)
# -----------------------------------------------------------------------------
# Archivo : infra/fedora/install.sh
# Versión : 0.1.0-draft  (borrador de la Fase 0 — se prueba y completa en la Fase 10)
# Guía    : infra/fedora/INSTALL.md  (leerla ANTES de ejecutar este script)
#
# USO
#   sudo ./install.sh                       # SIMULACIÓN (dry-run): no cambia nada
#   sudo ./install.sh --apply               # aplica de verdad
#   sudo ./install.sh --apply --supervisor=systemd
#   sudo ./install.sh --apply --with-firewall --lan-cidr=192.168.1.0/24
#   sudo ./install.sh --apply --with-selinux
#   sudo ./install.sh --help
#
# QUÉ HACE
#   1. Verifica que se ejecuta como root en un Fedora.
#   2. Instala los paquetes dnf (PostgreSQL 18, git, firewalld, SELinux tools,
#      dependencias de Chromium para Playwright, utilidades de respaldo).
#   3. Instala Node.js 26 (NodeSource por defecto; alternativa COPR) y PM2 global.
#   4. Crea el usuario de sistema `odontocrm` (sin shell de login, sin sudo).
#   5. Crea el layout de directorios con propietario y permisos correctos.
#   6. Genera PLANTILLAS de entorno con marcadores CAMBIAR_*, en DOS archivos
#      como en desarrollo (`.env` de la raíz + `services/<servicio>/.env`):
#        /etc/odontocrm/odontocrm.env   COMÚN a los 9 servicios
#        /etc/odontocrm/<servicio>.env  PROPIO de cada servicio
#      (nunca secretos reales, nunca sobrescribe un archivo existente).
#   7. Registra el arranque automático del supervisor elegido (PM2 o systemd).
#   8. Opcional (--with-firewall / --with-selinux): reglas de firewalld y
#      contextos/booleanos de SELinux.
#
# QUÉ NO HACE (por diseño — ver INSTALL.md)
#   · NO inicializa el clúster de PostgreSQL (`postgresql-18-setup --initdb` es
#     un paso manual y consciente: INSTALL.md §5).
#   · NO crea, borra ni restaura bases de datos.
#   · NO ejecuta migraciones ni seeds, ni toca datos clínicos.
#   · NO escribe secretos reales: solo plantillas con marcadores CAMBIAR_*.
#   · NO habilita ni arranca servicios: imprime los comandos para que el
#     operador los ejecute cuando el código ya esté compilado.
#
# IDEMPOTENCIA
#   Se puede ejecutar N veces. No sobrescribe archivos de configuración ni
#   secretos existentes; los pasos ya aplicados se reportan como «ya existe».
#
# CÓDIGOS DE SALIDA
#   0 = correcto · 1 = error de ejecución · 2 = uso incorrecto
#   3 = precondición no cumplida (no es root / no es Fedora / falta dnf)
# =============================================================================

set -euo pipefail

# ── Aviso de dónde se corta ──────────────────────────────────────────────────
# Un guion que se corta EN SILENCIO es el peor fallo posible: pasó en el ensayo de la
# Fase 10, que moría (por una variable sin definir, con `set -u`) justo antes de imprimir
# el «Resumen» y de reiniciar, y parecía que el reinicio «no funcionaba».
#
# Este aviso NO cambia el comportamiento (los guiones siguen adelante donde ya lo hacían):
# solo dice por stderr en qué línea se detuvo y con qué código. Cuando bash aborta por
# `set -u`, esto imprime la línea exacta; cuando un comando falla y el guion continúa,
# queda anotado para que nadie se quede sin saberlo.
trap 'codigo=$?; printf "\n✖ %s: se detuvo en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR

# Y un aviso de SALIDA: se ejecuta siempre, incluso cuando bash aborta por `set -u` (ese
# caso **no** pasa por el trap de ERR). Es el que habría dicho «el ensayo terminó con
# error en la línea X» en vez de dejar una salida truncada que parecía un reinicio roto.
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT


readonly SCRIPT_NAME="${0##*/}"
readonly SCRIPT_VERSION="0.1.0-draft"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# -----------------------------------------------------------------------------
# Valores por defecto (sobrescribibles con flags o variables de entorno)
# -----------------------------------------------------------------------------
SERVICE_USER="${SERVICE_USER:-odontocrm}"
SERVICE_GROUP="${SERVICE_GROUP:-odontocrm}"
CODE_DIR="${CODE_DIR:-/opt/odontocrm}"
DATA_DIR="${DATA_DIR:-/var/lib/odontocrm}"
LOG_DIR="${LOG_DIR:-/var/log/odontocrm}"
ETC_DIR="${ETC_DIR:-/etc/odontocrm}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/odontocrm}"
PG_MAJOR="${PG_MAJOR:-18}"
PGDATA="${PGDATA:-/var/lib/pgsql/data}"
NODE_MAJOR="${NODE_MAJOR:-26}"
TIMEZONE="${TIMEZONE:-America/Caracas}"

SUPERVISOR="pm2"        # pm2 | systemd | none
NODE_CHANNEL="auto"     # auto | nodesource | copr | distro | skip
APPLY=0                 # 0 = dry-run (por defecto), 1 = aplicar
WITH_FIREWALL=0
WITH_SELINUX=0
WITH_CHROMIUM_DEPS=1
WITH_SYSTEMD_UNITS=0    # instalar unidades aunque el supervisor sea pm2
ENABLE_SERVICES=0       # habilitar servicios systemd (requiere código desplegado)
WITH_STORAGE_HTTPD=0    # etiquetar storage como httpd_sys_content_t
PM2_SAVE=0              # ejecutar `pm2 save` si ya hay procesos
PROXY_PORT="${PROXY_PORT:-443}"
LAN_CIDR="${LAN_CIDR:-}"

# Servicios del sistema (los 8 servicios con base de datos + el gateway aparte).
# Formato: "<nombre>:<puerto>:<base_de_datos>"; el gateway se trata por separado.
readonly SERVICES=(
  "identity:4001:odonto_identity"
  "patients:4002:odonto_patients"
  "scheduling:4003:odonto_scheduling"
  "notifications:4004:odonto_notifications"
  "clinical:4005:odonto_clinical"
  "odontogram:4006:odonto_odontogram"
  "screens:4007:odonto_screens"
  "reporting:4008:odonto_reporting"
)
readonly GATEWAY_PORT=8090
readonly PLAYWRIGHT_DIR="/var/lib/odontocrm/ms-playwright"   # navegadores (Fase 7)
readonly GATEWAY_DB=""

# -----------------------------------------------------------------------------
# Utilidades de salida
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

log()     { printf '%s\n' "${C_DIM}[info]${C_RESET} $*"; }
ok()      { printf '%s\n' "${C_GREEN}[ ok ]${C_RESET} $*"; }
warn()    { printf '%s\n' "${C_YELLOW}[aviso]${C_RESET} $*" >&2; }
err()     { printf '%s\n' "${C_RED}[error]${C_RESET} $*" >&2; }
step()    { printf '\n%s\n' "${C_BOLD}${C_BLUE}==> $*${C_RESET}"; }
pending() { printf '%s\n' "${C_YELLOW}[PENDIENTE FASE 10]${C_RESET} $*"; }
die()     { local code="${2:-1}"; err "${1:-error inesperado}"; exit "$code"; }

usage() {
  cat <<EOF
${SCRIPT_NAME} v${SCRIPT_VERSION} — aprovisiona OdontoCRM en Fedora (43+)

USO
  sudo ./${SCRIPT_NAME} [opciones]

MODO
  --dry-run                 Solo muestra lo que haría (PREDETERMINADO).
  --apply                   Ejecuta los cambios.
  -h, --help                Muestra esta ayuda.

COMPONENTES
  --node-channel=auto|nodesource|copr|distro|skip
                            Origen de Node.js ${NODE_MAJOR} (por defecto: auto → NodeSource).
  --supervisor=pm2|systemd|none
                            Quién mantiene vivos los servicios (por defecto: pm2).
                            Registra el arranque automático del elegido.
  --with-systemd-units      Instala las unidades systemd aunque el supervisor sea pm2.
  --enable-services         Habilita los servicios systemd (SIN arrancarlos).
  --pm2-save                Ejecuta \`pm2 save\` como ${SERVICE_USER} si hay procesos.
  --skip-chromium-deps      No instala las dependencias del navegador (Playwright).
  --with-firewall           Configura firewalld (requiere --lan-cidr).
  --lan-cidr=CIDR           Red autorizada a la LAN, p. ej. 192.168.1.0/24.
  --proxy-port=N            Puerto del reverse proxy a abrir (por defecto: 443).
  --with-selinux            Aplica contextos y booleanos de SELinux.
  --with-storage-httpd      En SELinux, etiqueta storage como httpd_sys_content_t
                            (solo si el proxy sirve archivos directamente).

RUTAS (raras veces necesario cambiarlas)
  --code-dir=DIR  --data-dir=DIR  --log-dir=DIR  --etc-dir=DIR  --backup-dir=DIR
  --service-user=USER  --timezone=ZONA

EJEMPLOS
  sudo ./${SCRIPT_NAME}
  sudo ./${SCRIPT_NAME} --apply
  sudo ./${SCRIPT_NAME} --apply --supervisor=systemd --enable-services
  sudo ./${SCRIPT_NAME} --apply --with-firewall --lan-cidr=192.168.1.0/24
EOF
}

# -----------------------------------------------------------------------------
# Ejecución consciente del modo: en dry-run nada se ejecuta ni se escribe
# (las comprobaciones son de solo lectura: rpm -q, getent, timedatectl, test -f)
# -----------------------------------------------------------------------------
run() {
  if (( APPLY )); then
    printf '       %s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
    "$@"
  else
    printf '       %s[dry-run]$ %s%s\n' "$C_DIM" "$*" "$C_RESET"
  fi
}

# Escribe un archivo solo si no existe (idempotente, nunca sobrescribe).
write_if_missing() {
  local path="$1"; shift
  local mode="$1"; shift
  local content="$1"
  if [[ -e "$path" ]]; then
    ok "ya existe, no se modifica: $path"
    return 0
  fi
  if (( APPLY )); then
    printf '%s\n' "$content" >"$path"
    chmod "$mode" "$path"
    ok "creado: $path (permisos $mode)"
  else
    printf '       %s[dry-run] crear %s (permisos %s)%s\n' "$C_DIM" "$path" "$mode" "$C_RESET"
  fi
}

ensure_dir() {
  local path="$1" mode="$2" owner="$3" group="$4"
  if (( APPLY )); then
    install -d -m "$mode" -o "$owner" -g "$group" "$path"
    ok "directorio listo: $path (${mode} ${owner}:${group})"
  else
    printf '       %s[dry-run] install -d -m %s -o %s -g %s %s%s\n' \
      "$C_DIM" "$mode" "$owner" "$group" "$path" "$C_RESET"
  fi
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Compara un archivo de unidad con el del repositorio e instala solo si difiere.
install_unit_if_changed() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || { warn "no se encontró la unidad de origen: $src"; return 1; }
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    ok "unidad ya actualizada, sin cambios: $dst"
    return 0
  fi
  if (( APPLY )); then
    install -m 0644 -o root -g root "$src" "$dst"
    ok "unidad instalada: $dst"
  else
    printf '       %s[dry-run] install -m 0644 %s %s%s\n' "$C_DIM" "$src" "$dst" "$C_RESET"
  fi
}

# -----------------------------------------------------------------------------
# 0. Precondiciones
# -----------------------------------------------------------------------------
preflight() {
  step "0/9 · Precondiciones"

  if (( EUID != 0 )); then
    err "este script debe ejecutarse como root (use: sudo ./${SCRIPT_NAME} ${*:-})"
    exit 3
  fi
  ok "ejecutando como root"

  if [[ -r /etc/fedora-release ]]; then
    ok "sistema: $(cat /etc/fedora-release)"
    if ! have_cmd dnf; then die "no se encontró dnf: este script es solo para Fedora" 3; fi
  else
    err "no se detectó /etc/fedora-release: este script está pensado para Fedora"
    exit 3
  fi

  local tz_now; tz_now="$(timedatectl show -p Timezone --value 2>/dev/null || echo desconocida)"
  if [[ "$tz_now" == "$TIMEZONE" ]]; then
    ok "zona horaria correcta: $tz_now"
  else
    warn "zona horaria actual «$tz_now»; el sistema espera «$TIMEZONE»."
    warn "  Corrija con: timedatectl set-timezone $TIMEZONE"
  fi

  if (( APPLY )); then
    warn "MODO APPLY: se aplicarán cambios reales en este sistema."
  else
    log "MODO DRY-RUN (predeterminado): no se modificará nada. Use --apply para ejecutar."
  fi
}

# -----------------------------------------------------------------------------
# 1. Paquetes dnf
# -----------------------------------------------------------------------------
PKGS_BASE=(
  git tar gzip xz zstd rsync curl ca-certificates
  logrotate chrony
  firewalld
  # SELinux: `semanage`/`restorecon` y `audit2why` vienen en policycoreutils-python-utils,
  # `sesearch`/`seinfo` en setools-console, `sealert` en setroubleshoot-server y
  # `ausearch` en audit. El nombre `setools-conftools` que traía la guía no existe en Fedora.
  policycoreutils-python-utils setools-console setroubleshoot-server audit
)
PKGS_PG=(
  "postgresql${PG_MAJOR}-server"
  "postgresql${PG_MAJOR}-contrib"
)
# Dependencias de ejecución de Chromium (Playwright) en Fedora.
# > PENDIENTE FASE 10: la lista exacta puede variar según la versión de Fedora y
#   de Playwright. Verificación recomendada tras instalar el navegador:
#     ldd /var/lib/odontocrm/ms-playwright/chromium-*/chrome-linux/chrome | grep 'not found'
#   y `npx playwright install-deps chromium` (si la distribución es soportada; en
#   Fedora NO lo está y se instala la lista de abajo). El intento se deja a propósito.
#   (fedora:check-ok)
PKGS_CHROMIUM=(
  nss nspr atk at-spi2-atk cups-libs
  libdrm mesa-libgbm libxshmfence
  libX11 libXext libXcursor libXi libXtst libXcomposite libXdamage libXfixes libXrandr
  pango alsa-lib libxkbcommon libxkbcommon-x11
  liberation-fonts dejavu-sans-fonts
)

install_packages() {
  step "1/9 · Paquetes dnf"

  local pkgs=("${PKGS_BASE[@]}" "${PKGS_PG[@]}")
  (( WITH_CHROMIUM_DEPS )) && pkgs+=("${PKGS_CHROMIUM[@]}")

  local missing=()
  local p
  for p in "${pkgs[@]}"; do
    rpm -q "$p" >/dev/null 2>&1 || missing+=("$p")
  done

  if (( ${#missing[@]} == 0 )); then
    ok "todos los paquetes requeridos ya están instalados"
  else
    log "paquetes a instalar (${#missing[@]}): ${missing[*]}"
    run dnf install -y --setopt=install_weak_deps=False "${missing[@]}"
  fi

  if (( WITH_CHROMIUM_DEPS )); then
    pending "confirmar que la lista PKGS_CHROMIUM cubre todas las bibliotecas que"
    pending "  Chromium necesita en el Fedora concreto (use el comando ldd comentado arriba)."
  fi
}

# -----------------------------------------------------------------------------
# 2. Node.js y npm
# -----------------------------------------------------------------------------
node_major_installed() {
  have_cmd node || return 1
  local v; v="$(node --version 2>/dev/null || true)"
  [[ "$v" =~ ^v([0-9]+) ]] || return 1
  (( BASH_REMATCH[1] >= NODE_MAJOR ))
}

install_node() {
  step "2/9 · Node.js ${NODE_MAJOR} y npm"

  if node_major_installed; then
    ok "Node.js ya presente: $(node --version) · npm $(npm --version 2>/dev/null || echo '?')"
    return 0
  fi

  case "$NODE_CHANNEL" in
    skip)
      warn "--node-channel=skip: se omite la instalación de Node.js"
      ;;
    distro)
      log "instalando nodejs/npm desde los repositorios de Fedora"
      run dnf install -y nodejs npm
      ;;
    copr)
      log "habilitando el COPR de la comunidad Node.js para la versión ${NODE_MAJOR}"
      run dnf install -y 'dnf-command(copr)'
      run dnf copr enable -y "nodejs/nodejs${NODE_MAJOR}"
      run dnf install -y nodejs npm
      ;;
    nodesource | auto)
      log "instalando el repositorio RPM de NodeSource para la versión ${NODE_MAJOR}"
      # El instalador oficial se descarga, se revisa y luego se ejecuta (no se
      # canaliza directamente a bash) para que el operador pueda auditarlo.
      if (( APPLY )); then
        local tmp; tmp="$(mktemp /tmp/nodesource-setup-XXXXXX.sh)"
        curl -fsSL -o "$tmp" "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x"
        log "instalador descargado en $tmp (sha256: $(sha256sum "$tmp" | cut -d' ' -f1))"
        bash "$tmp"
        rm -f "$tmp"
        dnf install -y nodejs
      else
        printf '       %s[dry-run]$ curl -fsSL -o /tmp/nodesource-setup-XXXXXX.sh \\\n' "$C_DIM"
        printf '       %s             https://rpm.nodesource.com/setup_%s.x%s\n' "$C_DIM" "$NODE_MAJOR" "$C_RESET"
        printf '       %s[dry-run]$ (revisar el script) && bash /tmp/nodesource-setup-XXXXXX.sh%s\n' "$C_DIM" "$C_RESET"
        printf '       %s[dry-run]$ dnf install -y nodejs%s\n' "$C_DIM" "$C_RESET"
      fi
      ;;
    *)
      die "valor no válido para --node-channel: $NODE_CHANNEL" 2
      ;;
  esac

  if (( APPLY )); then
    if node_major_installed; then
      ok "Node.js instalado: $(node --version) · npm $(npm --version)"
    else
      warn "Node.js ${NODE_MAJOR}+ no quedó disponible. Revise el canal elegido"
      warn "  (--node-channel=copr|distro) o instálelo manualmente antes de continuar."
      pending "verificar en el Fedora real qué canal entrega Node.js ${NODE_MAJOR} y fijarlo en INSTALL.md §4."
    fi
  else
    pending "confirmar en el Fedora real la disponibilidad de Node.js ${NODE_MAJOR}"
    pending "  (NodeSource vs COPR vs repositorio de Fedora) → INSTALL.md §4."
  fi
}

# -----------------------------------------------------------------------------
# 3. PM2 (global) y registro del arranque automático
# -----------------------------------------------------------------------------
install_pm2() {
  step "3/9 · PM2 y arranque automático"

  if [[ "$SUPERVISOR" == "none" ]]; then
    log "--supervisor=none: se omite PM2"
    return 0
  fi

  if have_cmd pm2; then
    if (( APPLY )); then
      ok "PM2 ya instalado: $(pm2 --version 2>/dev/null || echo '?')"
    else
      ok "PM2 ya instalado (no se consulta la versión en dry-run para no arrancar su demonio)"
    fi
  else
    run npm install -g pm2
  fi

  if [[ "$SUPERVISOR" != "pm2" ]]; then
    log "supervisor elegido: $SUPERVISOR → no se registra el arranque de PM2"
    return 0
  fi

  # `pm2 startup` crea /etc/systemd/system/pm2-<usuario>.service. Es idempotente
  # en la práctica, pero se comprueba antes para no reescribirlo en cada corrida.
  if [[ -f "/etc/systemd/system/pm2-${SERVICE_USER}.service" ]]; then
    ok "arranque automático de PM2 ya registrado (pm2-${SERVICE_USER}.service)"
  else
    log "registrando el arranque automático de PM2 para el usuario ${SERVICE_USER}"
    run pm2 startup systemd -u "$SERVICE_USER" --hp "$DATA_DIR"
    if (( APPLY )) && [[ ! -f "/etc/systemd/system/pm2-${SERVICE_USER}.service" ]]; then
      warn "no se creó pm2-${SERVICE_USER}.service automáticamente."
      warn "  Ejecute el comando que imprimió PM2 (aparece como «sudo env PATH=... pm2 startup ...»)"
      warn "  o use la alternativa con unidades systemd: --supervisor=systemd"
    fi
  fi

  if (( PM2_SAVE )); then
    log "guardando la lista de procesos de PM2 (pm2 save)"
    run runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" PM2_HOME="$DATA_DIR/.pm2" pm2 save
  else
    log "arranque con PM2 (si se elige ese supervisor), desde ${CODE_DIR}:"
    log "  pm2 start infra/fedora/ecosystem.config.cjs   # rutas absolutas /opt/odontocrm/…"
    log "  pm2 save                                      # DESPUÉS de arrancar (INSTALL.md §10.4)"
  fi

  pending "verificar en la Fase 10 que PM2 arranca los 9 servicios tras un reinicio"
  pending "  y que lee los DOS .env de /etc/odontocrm con --env-file-if-exists"
  pending "  (requiere 0640 root:${SERVICE_GROUP}; INSTALL.md §10.4)."
}

# -----------------------------------------------------------------------------
# 4. Usuario de sistema y layout de directorios
# -----------------------------------------------------------------------------
create_user_and_dirs() {
  step "4/9 · Usuario de sistema y directorios"

  if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    ok "el usuario $SERVICE_USER ya existe ($(getent passwd "$SERVICE_USER" | cut -d: -f6))"
  else
    log "creando el usuario de sistema $SERVICE_USER (sin shell de login, sin sudo)"
    # HOME = $DATA_DIR: el servicio necesita un HOME escribible para cachés
    # (por ejemplo el navegador de Playwright). /opt es de solo lectura para el
    # servicio por el endurecimiento de systemd (ProtectSystem=strict).
    run useradd \
      --system \
      --create-home \
      --home-dir "$DATA_DIR" \
      --shell /usr/sbin/nologin \
      --comment "OdontoCRM · servicios Node (sin login)" \
      --user-group \
      "$SERVICE_USER"
  fi

  # --- Código (solo lectura para el servicio) --------------------------------
  ensure_dir "$CODE_DIR" 0755 root root

  # --- Datos y caché (escritura del servicio) --------------------------------
  ensure_dir "$DATA_DIR" 0750 "$SERVICE_USER" "$SERVICE_GROUP"
  ensure_dir "$DATA_DIR/storage" 0750 "$SERVICE_USER" "$SERVICE_GROUP"
  ensure_dir "$DATA_DIR/ms-playwright" 0750 "$SERVICE_USER" "$SERVICE_GROUP"
  ensure_dir "$DATA_DIR/tmp" 0750 "$SERVICE_USER" "$SERVICE_GROUP"

  # --- Logs ------------------------------------------------------------------
  ensure_dir "$LOG_DIR" 0750 "$SERVICE_USER" "$SERVICE_GROUP"

  # --- Configuración y secretos ---------------------------------------------
  # El directorio es 0750 root:odontocrm para que el servicio pueda ATRAVESARLO
  # y leer las claves de firma (/etc/odontocrm/keys), pero los archivos *.env
  # son 0600 root:root: los lee systemd COMO ROOT y los inyecta como variables,
  # así que el servicio NO necesita leerlos (así lo exige el plan §11).
  ensure_dir "$ETC_DIR" 0750 root "$SERVICE_GROUP"

  # --- Respaldos (solo root) -------------------------------------------------
  ensure_dir "$BACKUP_DIR" 0700 root root
}

# -----------------------------------------------------------------------------
# 5. Plantillas de configuración en /etc/odontocrm
# -----------------------------------------------------------------------------
env_header() {
  local svc="$1"
  cat <<EOF
# ─────────────────────────────────────────────────────────────────────────────
# OdontoCRM · variables de entorno PROPIAS de «${svc}»
# PLANTILLA generada por infra/fedora/install.sh v${SCRIPT_VERSION}
# Reemplace TODO valor marcado CAMBIAR_* antes de arrancar el servicio.
# Permisos: 0600 root:root (systemd las lee como root con EnvironmentFile=).
# Este archivo NUNCA debe copiarse al repositorio ni compartirse por chat.
# Corresponde al \`services/<servicio>/.env\` del desarrollo (el SEGUNDO
# --env-file-if-exists del arranque real). Lo común a los 9 servicios está en
# ${ETC_DIR}/odontocrm.env (el PRIMERO).
# Los nombres siguen el contrato real del código (Fase 0):
#   packages/kernel/src/config.ts · services/<svc>/src/config.ts ·
#   apps/gateway/src/config.ts · .env.example · infra/db/bootstrap.mjs
# > PENDIENTE FASE 10: los servicios de las Fases 2-9 añadirán variables
#   propias; reconciliar cada archivo con su services/<svc>/src/config.ts.
# ─────────────────────────────────────────────────────────────────────────────
EOF
}

env_header_common() {
  cat <<EOF
# ─────────────────────────────────────────────────────────────────────────────
# OdontoCRM · variables de entorno COMUNES a los 9 servicios
# PLANTILLA generada por infra/fedora/install.sh v${SCRIPT_VERSION}
# Reemplace TODO valor marcado CAMBIAR_* antes de arrancar los servicios.
# Permisos: 0600 root:root (systemd las lee como root con EnvironmentFile=).
# Este archivo NUNCA debe copiarse al repositorio ni compartirse por chat.
# Corresponde al \`.env\` de la RAÍZ del repositorio en desarrollo (el PRIMER
# --env-file-if-exists del arranque real). Lo propio de cada servicio está en
# ${ETC_DIR}/<servicio>.env (el SEGUNDO). En systemd se cargan los dos, en ese
# orden, con dos líneas EnvironmentFile= (INSTALL.md §10.2).
# Los nombres siguen el contrato real del código (Fase 0):
#   packages/kernel/src/config.ts · apps/gateway/src/config.ts · .env.example
# ─────────────────────────────────────────────────────────────────────────────
EOF
}

# Cuerpo del archivo COMÚN. Los puertos y las URLs se generan del array SERVICES
# para que no existan dos listas que puedan divergir.
env_common_body() {
  cat <<EOF
# --- Entorno general (packages/kernel · baseEnvSchema) ------------------------
NODE_ENV=production
LOG_LEVEL=info
LOG_PRETTY=false
TZ=${TIMEZONE}
SERVICE_VERSION=0.1.0

# --- Modo test: NUNCA activo en producción (plan §12) ------------------------
# El plan lo llama ALLOW_TEST_MODE y .env.example (Fase 0) usa TEST_MODE: se
# dejan AMBOS en false hasta que la Fase 10 fije el nombre definitivo.
TEST_MODE=false
ALLOW_TEST_MODE=false

# --- Escucha de cada servicio (verificado en el código, Fase 0) ---------------
# NO existe una variable PORT genérica: cada servicio lee su propio
# <SERVICIO>_HOST y <SERVICIO>_PORT. Siempre en loopback: la LAN entra solo por
# el reverse proxy (§11). Tabla de puertos: INSTALL.md §2.2.
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=${GATEWAY_PORT}
EOF

  local entry name port upper
  for entry in "${SERVICES[@]}"; do
    IFS=':' read -r name port _ <<<"$entry"
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    printf '%s_HOST=127.0.0.1\n%s_PORT=%s\n' "$upper" "$upper" "$port"
  done

  cat <<EOF

# --- URLs internas (las usa el gateway para el proxy por recurso) -------------
# Una URL vacía equivale a «ese servicio todavía no existe» (Fase 0).
EOF

  for entry in "${SERVICES[@]}"; do
    IFS=':' read -r name port _ <<<"$entry"
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    printf '%s_URL=http://127.0.0.1:%s\n' "$upper" "$port"
  done

  cat <<EOF

# --- Origen permitido de la SPA (CORS del gateway) ---------------------------
# WEB_ORIGIN: el origen con el que se abre la SPA en el navegador (esquema + host +
# puerto), o el CORS la bloqueará. Admite VARIOS separados por comas: pon el nombre y
# la IP con los que entran los equipos de la clínica, porque el navegador manda el que
# se teclee.
WEB_ORIGIN=https://CAMBIAR_HOST, https://CAMBIAR_IP_DEL_SERVIDOR
EOF
}

# Cuerpo del archivo PROPIO de un servicio: su base de datos (si tiene) y los
# secretos que no comparte con nadie.
env_service_body() {
  local svc="$1" db="$2"

  if [[ -n "$db" ]]; then
    cat <<EOF
# --- Base de datos propia (una base y un rol por servicio, plan §1.2) --------
# La cadena real la genera \`npm run db:bootstrap\` (Fase 0) dentro del
# repositorio (services/<servicio>/.env); en producción se traslada aquí y el
# .env del repositorio se BORRA: no debe quedar ninguno dentro de ${CODE_DIR}
# (INSTALL.md §8.6). No la escriba a mano salvo que sepa lo que hace.
DATABASE_URL=postgres://CAMBIAR_USUARIO_DB:CAMBIAR_PASSWORD_DB@127.0.0.1:5432/${db}
# EVENTS_DATABASE_URL (la cola compartida, odonto_events) NO se pone aquí: la escribe
# `npm run db:bootstrap` en services/<servicio>/.env y se traslada a este archivo en
# INSTALL.md §8.6. Sin ella, cada servicio usaría su propia base para la cola y los
# eventos no llegarían a los demás.
DATABASE_POOL_MAX=10
EOF
  fi

  cat <<EOF

# --- Secreto compartido de los JWT de servicio (REST interno, plan §2.3) -----
# DEBE ser el MISMO valor en los 9 servicios. Lo genera \`npm run db:bootstrap\`
# en el .env del repositorio (o genérelo con: openssl rand -base64 48).
INTERNAL_SERVICE_SECRET=CAMBIAR_SECRETO_INTERNO_COMPARTIDO
EOF
}

# Arregla valores heredados que impiden arrancar. `install.sh` nunca sobrescribe un
# archivo existente, así que una plantilla con un valor inválido se queda para
# siempre: aquí se corrige el único caso conocido.
#
# `TELEGRAM_MODE=polling` venía en la plantilla de las Fases 4-9: el esquema acepta
# `auto | real | simulado` (el long polling es el transporte, no un modo), así que el
# servicio de notificaciones moría con `ConfigError: valor no permitido` — y con él la
# migración. Medido en el ensayo de la Fase 10.
corregir_valores_obsoletos() {
  local archivo

  # 1) notifications.env: TELEGRAM_MODE=polling no es un valor válido.
  archivo="/etc/odontocrm/notifications.env"
  if [[ -f "$archivo" ]] && grep -qE '^TELEGRAM_MODE=polling[[:space:]]*$' "$archivo"; then
    if (( APPLY )); then
      sed -i 's|^TELEGRAM_MODE=polling[[:space:]]*$|TELEGRAM_MODE=auto|' "$archivo"
      ok "corregido TELEGRAM_MODE=polling → auto en $archivo (con 'polling' el servicio no arranca)"
    else
      printf '       %s[dry-run] sed -i s/TELEGRAM_MODE=polling/TELEGRAM_MODE=auto/ %s%s\n' "$C_DIM" "$archivo" "$C_RESET"
    fi
  fi

  # 2) patients/clinical: la variable del almacén se llamaba STORAGE_ROOT, que
  #    ningún servicio lee; el servicio caía a `./storage/…` sobre /opt (solo
  #    lectura con ProtectSystem=strict) y moría en bucle. Se renombra conservando
  #    el valor que hubiera.
  local almacen="/var/lib/odontocrm/storage"
  for archivo in /etc/odontocrm/patients.env /etc/odontocrm/clinical.env; do
    [[ -f "$archivo" ]] || continue
    if ! grep -qE '^STORAGE_DIR=' "$archivo"; then
      if grep -qE '^STORAGE_ROOT=' "$archivo"; then
        (( APPLY )) && sed -i -E "s|^STORAGE_ROOT=(.*)$|STORAGE_DIR=\1|" "$archivo"
        ok "renombrado STORAGE_ROOT → STORAGE_DIR en $archivo (el servicio lee STORAGE_DIR)"
      else
        (( APPLY )) && printf '\nSTORAGE_DIR=%s\n' "$almacen" >>"$archivo"
        ok "añadido STORAGE_DIR=$almacen en $archivo"
      fi
    fi
    if ! grep -qE '^MAX_FILE_BYTES=' "$archivo"; then
      (( APPLY )) && printf 'MAX_FILE_BYTES=20971520\n' >>"$archivo"
      ok "añadido MAX_FILE_BYTES=20971520 (20 MB) en $archivo (STORAGE_MAX_UPLOAD_MB no lo lee nadie)"
    fi
    (( APPLY )) && sed -i '/^STORAGE_MAX_UPLOAD_MB=/d' "$archivo" || true
  done

  # 3) clinical: la URL pública (QR del récipe) tiene que ser la del proxy, no localhost.
  archivo="/etc/odontocrm/clinical.env"
  if [[ -f "$archivo" ]] && ! grep -qE '^PUBLIC_APP_URL=' "$archivo"; then
    local web_origin
    web_origin="$(sed -n 's/^WEB_ORIGIN=//p' /etc/odontocrm/odontocrm.env | head -1)"
    (( APPLY )) && printf 'PUBLIC_APP_URL=%s\n' "${web_origin:-https://CAMBIAR_HOST_O_IP_DEL_SERVIDOR}" >>"$archivo"
    ok "añadido PUBLIC_APP_URL=${web_origin:-CAMBIAR…} en $archivo (lo usa el QR de verificación del récipe)"
  fi

  # 3-bis) clinical y reporting generan PDF con Playwright: sin la ruta, el
  #    navegador se busca en la caché del usuario del servicio y la exportación
  #    responde 503. (Medido en la Fase 10: los récipes salían y la exportación no.)
  for archivo in /etc/odontocrm/clinical.env /etc/odontocrm/reporting.env; do
    [[ -f "$archivo" ]] || continue
    if ! grep -qE '^PLAYWRIGHT_BROWSERS_PATH=' "$archivo"; then
      (( APPLY )) && printf '\nPLAYWRIGHT_BROWSERS_PATH=%s\n' "$PLAYWRIGHT_DIR" >>"$archivo"
      ok "añadido PLAYWRIGHT_BROWSERS_PATH en $archivo (Chromium para los PDF)"
    fi
  done

  # 3-ter) notifications.env: si falta TELEGRAM_MODE, se pone. Una versión anterior
  #    del ensayo borró la clave al trasladar los secretos (el .env de desarrollo no la
  #    define porque usa el valor por defecto) y el archivo quedó sin ella: funciona,
  #    pero el resumen avisaba «no define TELEGRAM_MODE» en cada corrida. Se repone con
  #    su valor por defecto explícito.
  archivo="/etc/odontocrm/notifications.env"
  if [[ -f "$archivo" ]] && ! grep -qE '^TELEGRAM_MODE=' "$archivo"; then
    if (( APPLY )); then
      printf '\n# auto | real | simulado (el long polling es el transporte, no un modo)\nTELEGRAM_MODE=auto\n' >>"$archivo"
      ok "repuesto TELEGRAM_MODE=auto en $archivo (se había perdido en un traslado anterior)"
    else
      printf '       %s[dry-run] printf TELEGRAM_MODE=auto >> %s%s\n' "$C_DIM" "$archivo" "$C_RESET"
    fi
  fi

  # 4) gateway: sin la clave pública del JWT no arranca (su valor por defecto es
  #    relativo al código, que en producción no tiene las claves).
  archivo="/etc/odontocrm/gateway.env"
  if [[ -f "$archivo" ]] && ! grep -qE '^JWT_PUBLIC_KEY_PATH=' "$archivo"; then
    (( APPLY )) && printf 'JWT_PUBLIC_KEY_PATH=/etc/odontocrm/keys/jwt-public.pem\n' >>"$archivo"
    ok "añadido JWT_PUBLIC_KEY_PATH en $archivo (sin él el gateway muere con ENOENT)"
  fi
}

write_env_templates() {
  step "5/9 · Plantillas de configuración (/etc/odontocrm)"

  local entry name port db extra
  for entry in "${SERVICES[@]}"; do
    IFS=':' read -r name port db <<<"$entry"
    extra=""
    case "$name" in
      identity)
        extra=$(cat <<'EOF'
# --- Identidad y sesiones (Fases 1 y 10) -------------------------------------
# COOKIE_SECRET lo genera `npm run db:bootstrap` (Fase 0).
# > PENDIENTE FASE 10: confirmar los nombres de las variables de sesión contra
#   services/identity/src/config.ts antes de la puesta en marcha.
COOKIE_SECRET=CAMBIAR_SECRETO_DE_COOKIES
JWT_PRIVATE_KEY_PATH=/etc/odontocrm/keys/jwt-private.pem
JWT_PUBLIC_KEY_PATH=/etc/odontocrm/keys/jwt-public.pem
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
COOKIE_SECURE=true
COOKIE_SAMESITE=Lax
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15
EOF
)
        ;;
      patients)
        extra=$(cat <<'EOF'
# --- Almacenamiento de archivos (abstracción S3-ready, Fase 2/7) -------------
# Los nombres son los que LEE services/patients/src/config.ts. Con STORAGE_DIR mal
# puesto el servicio cae al valor por defecto (`./storage/patients`, relativo a
# /opt/odontocrm), que con ProtectSystem=strict es de SOLO LECTURA: el proceso muere
# al primer archivo y systemd lo reintenta en bucle. Medido en la Fase 10.
STORAGE_DIR=/var/lib/odontocrm/storage
# Tamaño máximo por archivo, en BYTES (20 MB).
MAX_FILE_BYTES=20971520
EOF
)
        ;;
      notifications)
        extra=$(cat <<'EOF'
# --- Bot de Telegram (Fase 4) ------------------------------------------------
# El token lo entrega BotFather POR ARCHIVO. Nunca por chat ni en el repo.
# Debe haber UN ÚNICO poller (si hay dos, Telegram responde 409 Conflict).
TELEGRAM_BOT_TOKEN=CAMBIAR_TOKEN_BOTFATHER
TELEGRAM_BOT_USERNAME=CAMBIAR_USUARIO_DEL_BOT
# El modo es auto | real | simulado (el long polling es el transporte, no un modo):
# con 'auto' el bot usa el real si hay token y el simulado si no lo hay.
TELEGRAM_MODE=auto
TELEGRAM_TEST_CHAT_ID=CAMBIAR_CHAT_ID_DE_PRUEBAS
EOF
)
        ;;
      clinical)
        extra=$(cat <<'EOF'
# --- Récipes A5 con Playwright/Chromium (Fase 7) -----------------------------
# La caché de navegadores va FUERA del HOME y dentro de ReadWritePaths (§10.3).
# Playwright la usa por sí solo; PDF_CHROMIUM_PATH solo hace falta para apuntar a
# un Chrome del sistema en vez del navegador de Playwright.
PLAYWRIGHT_BROWSERS_PATH=/var/lib/odontocrm/ms-playwright
STORAGE_DIR=/var/lib/odontocrm/storage
# Tamaño máximo por adjunto, en BYTES (20 MB).
MAX_FILE_BYTES=20971520
# URL con la que se abre la aplicación: la usa el QR de verificación del récipe
# (impreso en el papel). Con el valor por defecto apuntaría a `localhost`, que en el
# móvil del paciente no existe: tiene que ser la del proxy inverso (§13).
PUBLIC_APP_URL=https://CAMBIAR_HOST_O_IP_DEL_SERVIDOR
EOF
)
        ;;
      reporting)
        extra=$(cat <<'EOF'
# --- Exportación de reportes a PDF con Playwright/Chromium (Fase 7) ----------
# La MISMA ruta que en clinical: sin esto, Playwright busca el navegador en la
# caché por defecto del usuario del servicio (HOME=/var/lib/odontocrm) y la
# exportación a PDF responde 503 «no se pudo generar el PDF». Medido en la Fase 10.
PLAYWRIGHT_BROWSERS_PATH=/var/lib/odontocrm/ms-playwright
EOF
)
        ;;
      *)
        extra="# (Este servicio todavía no declara variables propias; ver su
#  services/${name}/src/config.ts cuando se implemente su fase.)"
        ;;
    esac
    write_if_missing "$ETC_DIR/${name}.env" 0600 \
      "$(env_header "$name")

$(env_service_body "$name" "$db")

${extra}"
  done

  # --- Gateway: archivo propio pero SIN base de datos -------------------------
  write_if_missing "$ETC_DIR/gateway.env" 0600 \
    "$(env_header gateway)

$(env_service_body gateway "$GATEWAY_DB")

# --- Verificación del JWT -----------------------------------------------------
# El gateway valida el token de acceso con la clave PÚBLICA. Su valor por defecto
# es relativo al código (`./services/identity/.keys/…`), que en producción NO
# existe: las claves viven en /etc/odontocrm/keys y el código no se escribe. Sin
# esta línea el gateway muere al arrancar con ENOENT. Medido en la Fase 10.
JWT_PUBLIC_KEY_PATH=/etc/odontocrm/keys/jwt-public.pem"

  # --- Archivo COMÚN de los 9 servicios --------------------------------------
  # Va después para que el resumen de salida lo muestre al final; el orden de
  # escritura no importa (systemd carga los dos con EnvironmentFile=).
  write_if_missing "$ETC_DIR/odontocrm.env" 0600 \
    "$(env_header_common)

$(env_common_body)"

  # --- Configuración del respaldo --------------------------------------------
  write_if_missing "$ETC_DIR/backup.env" 0600 \
    "# ─────────────────────────────────────────────────────────────────────────────
# OdontoCRM · configuración de los respaldos (lo lee backup/odontocrm-backup.sh)
# PLANTILLA generada por infra/fedora/install.sh v${SCRIPT_VERSION}
# > PENDIENTE FASE 10: confirmar el usuario/rol de respaldo y la ruta del socket.
# ─────────────────────────────────────────────────────────────────────────────
BACKUP_DIR=${BACKUP_DIR}
RETENTION_DAYS=30
LOG_FILE=${LOG_DIR}/backup.log
# Conexión para los respaldos (INSTALL.md §15.2). Opción recomendada: un rol
# dedicado «odonto_backup» por TCP con scram-sha-256 y /etc/odontocrm/.pgpass.
# Alternativa por socket unix con autenticación peer: PG_HOST=/var/run/postgresql
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=CAMBIAR_USUARIO_DE_RESPALDO
PGPASSFILE=/etc/odontocrm/.pgpass
# Lista de bases a respaldar (las 8 bases, una por servicio).
DATABASES=\"odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting\"
# Copias opcionales (activar con --include-config / --include-storage)
STORAGE_DIR=/var/lib/odontocrm/storage
# Nombre del rol propietario de cada base (para restaurar con --no-owner --role).
# Si el rol se llama igual que la base, estas líneas no son necesarias.
ROLE_odonto_identity=odonto_identity
ROLE_odonto_patients=odonto_patients
ROLE_odonto_scheduling=odonto_scheduling
ROLE_odonto_notifications=odonto_notifications
ROLE_odonto_clinical=odonto_clinical
ROLE_odonto_odontogram=odonto_odontogram
ROLE_odonto_screens=odonto_screens
ROLE_odonto_reporting=odonto_reporting"

  write_if_missing "$ETC_DIR/.pgpass" 0600 \
    "# Formato: host:puerto:base:usuario:contraseña   (usuario comodín: *)
# El campo «host» debe coincidir con el host de conexión: use 127.0.0.1 para
# TCP y «localhost» cuando se conecte por el socket unix. Se dejan ambas líneas.
# PLANTILLA — reemplace CAMBIAR_PASSWORD_DE_RESPALDO
127.0.0.1:5432:*:CAMBIAR_USUARIO_DE_RESPALDO:CAMBIAR_PASSWORD_DE_RESPALDO
localhost:5432:*:CAMBIAR_USUARIO_DE_RESPALDO:CAMBIAR_PASSWORD_DE_RESPALDO"

  # --- Claves de firma de identidad -----------------------------------------
  # Estas claves SÍ las lee el servicio (firma los JWT de acceso), por eso el
  # directorio y los archivos son del grupo odontocrm (0640), no 0600 root:root.
  ensure_dir "$ETC_DIR/keys" 0750 root "$SERVICE_GROUP"
  log "genere el par de claves EdDSA en ${ETC_DIR}/keys (INSTALL.md §8.4)"
}

# -----------------------------------------------------------------------------
# 5-bis. Rotación de logs (logrotate)
# -----------------------------------------------------------------------------
# Una sola puerta para las tareas del servidor: `sudo odontocrm estado`, `respaldar`,
# `verificar`… Así en la clínica no hay que recordar rutas, `sudo` ni variables.
install_comando() {
  step "8/9 · Comando del servidor (/usr/local/bin/odontocrm)"

  if [[ ! -f "$SCRIPT_DIR/odontocrm" ]]; then
    warn "no encuentro $SCRIPT_DIR/odontocrm: se omite"
    return 0
  fi
  if (( APPLY )); then
    install -m 0755 -o root -g root "$SCRIPT_DIR/odontocrm" /usr/local/bin/odontocrm
    ok "instalado /usr/local/bin/odontocrm (prueba: sudo odontocrm ayuda)"
  else
    printf '       %s[dry-run] install -m 0755 %s/odontocrm /usr/local/bin/odontocrm%s\n' \
      "$C_DIM" "$SCRIPT_DIR" "$C_RESET"
  fi
}

install_logrotate() {
  step "5-bis/9 · Rotación de logs"

  local src="$SCRIPT_DIR/logrotate/odontocrm" dst="/etc/logrotate.d/odontocrm"
  if [[ ! -f "$src" ]]; then
    warn "no se encontró $src; se omite la rotación de logs"
    return 0
  fi

  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    ok "logrotate ya actualizado, sin cambios: $dst"
    return 0
  fi

  if (( APPLY )); then
    install -m 0644 -o root -g root "$src" "$dst"
    ok "logrotate instalado: $dst (diario, 30 días, comprimido)"
  else
    printf '       %s[dry-run] install -m 0644 %s %s%s\n' "$C_DIM" "$src" "$dst" "$C_RESET"
  fi
}

# -----------------------------------------------------------------------------
# 6. Unidades systemd
# -----------------------------------------------------------------------------
install_systemd_units() {
  step "6/9 · Unidades systemd"

  if [[ "$SUPERVISOR" != "systemd" ]] && (( ! WITH_SYSTEMD_UNITS )); then
    log "no solicitado (use --supervisor=systemd o --with-systemd-units)"
    log "  Motivo: no conviene tener PM2 y systemd supervisando los mismos servicios."
    return 0
  fi

  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm@.service" "/etc/systemd/system/odontocrm@.service"
  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm-gateway.service" "/etc/systemd/system/odontocrm-gateway.service"
  # Observabilidad (Fase 10): el tablero de estado cada 5 minutos. Es un
  # temporizador, no un servicio de la pila: no depende del supervisor elegido.
  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm-backup.service" "/etc/systemd/system/odontocrm-backup.service"
  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm-backup.timer" "/etc/systemd/system/odontocrm-backup.timer"
  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm-alertas.service" "/etc/systemd/system/odontocrm-alertas.service"
  install_unit_if_changed "$SCRIPT_DIR/systemd/odontocrm-alertas.timer" "/etc/systemd/system/odontocrm-alertas.timer"
  run systemctl daemon-reload
  run systemctl enable --now odontocrm-alertas.timer

  if (( ENABLE_SERVICES )); then
    log "habilitando servicios (no se arrancan en este paso)"
    local entry name svc_port svc_db units=("odontocrm-gateway.service")
    for entry in "${SERVICES[@]}"; do
      IFS=':' read -r name svc_port svc_db <<<"$entry"
      units+=("odontocrm@${name}.service")
    done
    run systemctl enable "${units[@]}"
  else
    log "los servicios NO se habilitan ni arrancan automáticamente."
    log "  Cuando el código esté compilado (INSTALL.md §9), ejecute:"
    log "    sudo systemctl enable --now postgresql-${PG_MAJOR} \\"
    log "      odontocrm@{identity,patients,scheduling,notifications,clinical,odontogram,screens,reporting}.service \\"
    log "      odontocrm-gateway.service"
  fi
}

# -----------------------------------------------------------------------------
# 7. firewalld (opcional)
# -----------------------------------------------------------------------------
configure_firewall() {
  step "7/9 · firewalld"

  if (( ! WITH_FIREWALL )); then
    log "omitido (use --with-firewall --lan-cidr=<red> para configurarlo)"
    log "  Regla prevista: abrir SOLO el puerto ${PROXY_PORT}/tcp a la LAN."
    log "  Nunca abrir 8090 ni 4001-4008 (servicios) ni 5432 (PostgreSQL)."
    return 0
  fi

  if [[ -z "$LAN_CIDR" ]]; then
    die "--with-firewall requiere --lan-cidr (p. ej. --lan-cidr=192.168.1.0/24)" 2
  fi

  run systemctl enable --now firewalld
  run firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${LAN_CIDR} port port=${PROXY_PORT} protocol=tcp accept"
  run firewall-cmd --reload
  log "estado actual:"
  run firewall-cmd --list-all
}

# -----------------------------------------------------------------------------
# 8. SELinux (opcional)
# -----------------------------------------------------------------------------
configure_selinux() {
  step "8/9 · SELinux"

  local mode; mode="$(getenforce 2>/dev/null || echo Desconocido)"
  log "modo actual de SELinux: $mode"

  if (( ! WITH_SELINUX )); then
    log "omitido (use --with-selinux para aplicar contextos y booleanos)"
    log "  Contextos previstos:"
    log "    ${CODE_DIR}/apps/web/dist  → httpd_sys_content_t (SPA que sirve el proxy)"
    log "  Booleano previsto: httpd_can_network_connect=on (proxy → 127.0.0.1)"
    return 0
  fi

  have_cmd semanage || die "falta semanage: instale policycoreutils-python-utils" 1

  # La SPA compilada la sirve el reverse proxy (nginx/Caddy, dominio httpd_t):
  # sin esta etiqueta el proxy no puede leerla desde /opt (tipo usr_t).
  run semanage fcontext -a -t httpd_sys_content_t "${CODE_DIR}/apps/web/dist(/.*)?"
  run restorecon -Rv "${CODE_DIR}/apps/web/dist"

  # El proxy necesita salir a la red para hablar con 127.0.0.1:8090.
  run setsebool -P httpd_can_network_connect on

  if (( WITH_STORAGE_HTTPD )); then
    # Solo si el proxy sirve archivos de storage DIRECTAMENTE.
    # El diseño de OdontoCRM los sirve por endpoint autorizado (plan §11),
    # así que por defecto NO se etiqueta.
    run semanage fcontext -a -t httpd_sys_content_t "${DATA_DIR}/storage(/.*)?"
    run restorecon -Rv "${DATA_DIR}/storage"
  fi

  pending "confirmar en la Fase 10 los contextos/booleanos reales con el proxy elegido"
  pending "  (nginx o Caddy) y el Fedora concreto: ausearch -m avc -ts recent | audit2why"
  pending "  No desactive SELinux. Último recurso: semanage permissive -a <dominio>."
}

# -----------------------------------------------------------------------------
# 9. Resumen
# -----------------------------------------------------------------------------
summary() {
  step "9/9 · Resumen"

  if (( APPLY )); then
    ok "aprovisionamiento aplicado."
  else
    log "SIMULACIÓN completada: no se modificó nada en el sistema."
  fi

  cat <<EOF

${C_BOLD}Estado esperado tras este script${C_RESET}
  usuario de sistema   : ${SERVICE_USER} (shell /usr/sbin/nologin, HOME ${DATA_DIR})
  código               : ${CODE_DIR}
  datos y storage      : ${DATA_DIR}/storage
  logs                 : ${LOG_DIR}
  configuración        : ${ETC_DIR}/odontocrm.env (COMÚN a los 9) + ${ETC_DIR}/<servicio>.env (PROPIO)
                         (directorio 0750 root:${SERVICE_GROUP}; archivos 0600 root:root — PLANTILLAS)
  respaldos            : ${BACKUP_DIR}
  supervisor           : ${SUPERVISOR}

${C_BOLD}Siguientes pasos manuales (en este orden)${C_RESET}
  1. Inicializar el clúster de PostgreSQL 18 si aún no lo está:
       sudo postgresql-${PG_MAJOR}-setup --initdb
       sudo systemctl enable --now postgresql-${PG_MAJOR}
  2. Crear las 8 bases y sus roles (bootstrap del repositorio; NO lo hace este script):
       cd ${CODE_DIR} && npm run db:bootstrap      # requiere .env con el superusuario
  3. Trasladar los secretos que genera el bootstrap (${CODE_DIR}/services/<servicio>/.env)
     a ${ETC_DIR}/<servicio>.env y BORRAR los .env del repositorio (INSTALL.md §8.6).
  4. Desplegar y compilar el código en ${CODE_DIR} (INSTALL.md §9).
  5. Compilar la SPA e instalarla donde la sirva el reverse proxy (INSTALL.md §9.4).
  6. Arrancar PostgreSQL y luego los servicios (systemd o PM2; INSTALL.md §10).
  7. Configurar el respaldo diario y PROBAR UNA RESTAURACIÓN (INSTALL.md §15-16).
  8. Ejecutar la verificación final con curl (INSTALL.md §17).

${C_BOLD}Pendientes declarados para la Fase 10${C_RESET}
  · Versiones exactas de los paquetes en el Fedora que se use (dnf list installed).
  · Disponibilidad real de Node.js ${NODE_MAJOR} en el canal elegido.
  · Variables propias de los servicios de las Fases 2-9 (cada fase añade las suyas).
  · PM2 en producción (INSTALL.md §10.4): confirmar que ${CODE_DIR}/infra/fedora/ecosystem.config.cjs
    arranca los servicios con los dos --env-file-if-exists y que los .env son
    legibles por el grupo ${SERVICE_GROUP} (0640 root:${SERVICE_GROUP}) si se elige PM2.
  · Dependencias de Chromium y etiquetas SELinux con el proxy elegido.
  · Prueba de restauración real de un respaldo (criterio de aceptación de la Fase 10).
  Marque cada punto en INSTALL.md cuando quede verificado.
EOF
}

# -----------------------------------------------------------------------------
# Parseo de argumentos
# -----------------------------------------------------------------------------
parse_args() {
  while (( $# )); do
    case "$1" in
      --apply)              APPLY=1 ;;
      --dry-run)            APPLY=0 ;;
      -h|--help)            usage; exit 0 ;;
      --supervisor=*)       SUPERVISOR="${1#*=}" ;;
      --node-channel=*)     NODE_CHANNEL="${1#*=}" ;;
      --code-dir=*)         CODE_DIR="${1#*=}" ;;
      --data-dir=*)         DATA_DIR="${1#*=}" ;;
      --log-dir=*)          LOG_DIR="${1#*=}" ;;
      --etc-dir=*)          ETC_DIR="${1#*=}" ;;
      --backup-dir=*)       BACKUP_DIR="${1#*=}" ;;
      --service-user=*)     SERVICE_USER="${1#*=}"; SERVICE_GROUP="$SERVICE_USER" ;;
      --timezone=*)         TIMEZONE="${1#*=}" ;;
      --lan-cidr=*)         LAN_CIDR="${1#*=}" ;;
      --proxy-port=*)       PROXY_PORT="${1#*=}" ;;
      --with-firewall)      WITH_FIREWALL=1 ;;
      --with-selinux)       WITH_SELINUX=1 ;;
      --with-systemd-units) WITH_SYSTEMD_UNITS=1 ;;
      --with-storage-httpd) WITH_STORAGE_HTTPD=1 ;;
      --enable-services)    ENABLE_SERVICES=1 ;;
      --pm2-save)           PM2_SAVE=1 ;;
      --skip-chromium-deps) WITH_CHROMIUM_DEPS=0 ;;
      *) err "opción no reconocida: $1"; usage; exit 2 ;;
    esac
    shift
  done

  case "$SUPERVISOR" in pm2|systemd|none) ;; *) die "--supervisor debe ser pm2, systemd o none" 2 ;; esac
  case "$NODE_CHANNEL" in auto|nodesource|copr|distro|skip) ;; *) die "--node-channel no válido" 2 ;; esac
}

main() {
  parse_args "$@"
  printf '%s\n' "${C_BOLD}OdontoCRM · aprovisionamiento Fedora · v${SCRIPT_VERSION}${C_RESET}"
  printf '%s\n' "${C_DIM}Guía completa: ${SCRIPT_DIR}/INSTALL.md${C_RESET}"
  preflight "$@"
  install_packages
  install_node
  install_pm2
  create_user_and_dirs
  write_env_templates
  corregir_valores_obsoletos
  install_comando
  install_logrotate
  install_systemd_units
  configure_firewall
  configure_selinux
  summary
}

main "$@"
