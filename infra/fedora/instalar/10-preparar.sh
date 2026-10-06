#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · 1/4 · Preparar la máquina
#
# Deja la PC lista para que el resto del instalador pueda trabajar:
#   · los paquetes del sistema (PostgreSQL, nginx, mkcert, firewalld, SELinux…)
#   · PostgreSQL con el clúster arrancado y `pg_hba` en scram-sha-256 para TCP
#   · Node.js 26, las dependencias de Chromium que Playwright no trae en Fedora
#   · el usuario de sistema `odontocrm` y los directorios con sus permisos
#
# NO instala nada de la aplicación y NO crea credenciales: eso es la pieza 2.
# Es idempotente: lo que ya está, se salta.
#
#   sudo bash infra/fedora/instalar/10-preparar.sh
#   sudo bash infra/fedora/instalar/10-preparar.sh --nombre-mdns=odontocrm
#   sudo bash infra/fedora/instalar/10-preparar.sh --dry-run
# =============================================================================
set -uo pipefail

# Un guion que se corta EN SILENCIO es el peor fallo posible: pasó en el ensayo de la
# Fase 10, que moría antes de imprimir el resumen y parecía que «el reinicio no funciona».
trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS="$NOMBRE_MDNS_POR_DEFECTO"
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"
export DRY_RUN

# `--dry-run` no toca nada, así que se puede ejecutar sin sudo: es la forma de
# revisar el plan completo en una máquina que todavía no es el servidor.
(( DRY_RUN )) || exigir_root

printf '%sOdontoCRM · 1/4 · Preparar la máquina%s\n' "$C_TI" "$C_RE"

# ── 1. Paquetes, PostgreSQL, Node, pg_hba y el nombre de red ────────────────
# Esto ya existe, está probado y se encarga de los detalles que costaron caro
# (pg_hba en scram para TCP, el rol superusuario por socket, avahi tras cambiar
# el nombre). No se reimplementa: se invoca.
paso 'Máquina: paquetes, PostgreSQL, Node, pg_hba y nombre'
if (( DRY_RUN )); then
  detalle "[dry-run] bash infra/fedora/instalar-base-fedora.sh --nombre-mdns=$NOMBRE_MDNS"
  detalle "[dry-run] (ese guion tiene su propio --dry-run)"
else
  bash "$ORIGEN/infra/fedora/instalar-base-fedora.sh" --nombre-mdns="$NOMBRE_MDNS" || morir 'la preparación de la máquina falló'
fi

# ── 2. Usuario de sistema ───────────────────────────────────────────────────
# Los servicios corren como `odontocrm`, NO como root: si uno se compromete, el
# daño se queda dentro de sus directorios. Sin shell y sin home de verdad.
paso 'Usuario de sistema'
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "el usuario «$SERVICE_USER» ya existe"
else
  ejecutar useradd --system --home-dir "$DATA_DIR" --create-home \
    --shell /sbin/nologin --comment 'OdontoCRM (servicios)' "$SERVICE_USER" ||
    morir "no pude crear el usuario $SERVICE_USER"
  if (( DRY_RUN )); then
    detalle "(dry-run: el usuario se crearía ahora)"
  else
    ok "creado el usuario de sistema «$SERVICE_USER» (sin shell, sin login)"
  fi
fi

# ── 3. Directorios y permisos ───────────────────────────────────────────────
# El reparto de permisos no es decorativo:
#   /opt/odontocrm      código, de root y SOLO LECTURA para el servicio
#   /var/lib/odontocrm  datos que el servicio escribe (adjuntos, navegador)
#   /var/log/odontocrm  logs en archivo (además del journal)
#   /etc/odontocrm      configuración y SECRETOS — 0750 root:odontocrm
#   /var/backups/...    respaldos, solo root
paso 'Directorios y permisos'
crear_dir() {
  local ruta="$1" modo="$2" duenio="$3"
  if [[ -d "$ruta" ]]; then
    ok "$(printf '%-34s' "$ruta") ya existe"
  else
    ejecutar install -d -m "$modo" -o "${duenio%%:*}" -g "${duenio##*:}" "$ruta" ||
      morir "no pude crear $ruta"
    if (( DRY_RUN )); then
      detalle "$(printf '%-34s' "$ruta") se creará ($modo ${duenio})"
    else
      ok "$(printf '%-34s' "$ruta") creado ($modo ${duenio})"
    fi
  fi
}

crear_dir "$CODE_DIR" 0755 root:root
crear_dir "$DATA_DIR" 0750 "$SERVICE_USER:$SERVICE_GROUP"
crear_dir "$DATA_DIR/storage" 0750 "$SERVICE_USER:$SERVICE_GROUP"
crear_dir "$DATA_DIR/ms-playwright" 0750 "$SERVICE_USER:$SERVICE_GROUP"
crear_dir "$LOG_DIR" 0750 "$SERVICE_USER:$SERVICE_GROUP"
crear_dir "$BACKUP_DIR" 0700 root:root
# Las claves viven aquí dentro y las lee el servicio: el grupo es el que da acceso.
crear_dir "$ETC_DIR" 0750 "root:$SERVICE_GROUP"
crear_dir "$ETC_DIR/keys" 0750 "root:$SERVICE_GROUP"

# ── 4. Comprobar que PostgreSQL responde ────────────────────────────────────
# Sin esto, la pieza 2 falla con un error de conexión que parece otra cosa.
paso 'Comprobar PostgreSQL'
if (( DRY_RUN )); then
  detalle '[dry-run] systemctl is-active postgresql'
elif systemctl is-active --quiet postgresql; then
  ok 'PostgreSQL está arrancado'
elif systemctl enable --now postgresql >/dev/null 2>&1; then
  ok 'PostgreSQL arrancado y habilitado al inicio'
else
  morir 'PostgreSQL no arranca: mira «systemctl status postgresql» y «journalctl -u postgresql»'
fi

if command -v psql >/dev/null 2>&1; then
  version="$(psql --version 2>/dev/null || true)"
  ok "${version:-psql disponible}"
else
  morir 'no encuentro `psql`: no se instaló el cliente de PostgreSQL'
fi

printf '\n%s1/4 listo.%s La máquina está preparada.\n' "$C_TI" "$C_RE"
detalle "siguiente:  sudo bash $INSTALADOR_DIR/20-aprovisionar.sh"
