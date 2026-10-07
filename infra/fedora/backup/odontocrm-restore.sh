#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# OdontoCRM · Restauración de una base o de todas, desde un respaldo
# -----------------------------------------------------------------------------
# Archivo : infra/fedora/backup/odontocrm-restore.sh
# Versión : 0.1.0-draft (borrador Fase 0 — se prueba y completa en la Fase 10)
# Guía    : infra/fedora/INSTALL.md §13 (incluye la PRUEBA DE RESTAURACIÓN que
#           exige el criterio de aceptación de la Fase 10)
#
# QUÉ HACE (por cada base)
#   1. Localiza el volcado (--from acepta un directorio de respaldo o un
#      archivo .dump concreto) y valida la cabecera PGDMP y el catálogo.
#   2. Comprueba la suma SHA-256 si el respaldo incluye SHA256SUMS.
#   3. RESTAURA A UNA BASE TEMPORAL  <base>__verif  para comprobar que el
#      respaldo sirve, SIN tocar la base real.
#   4. Solo si la verificación pasa, restaura sobre la base definitiva:
#        · cierra las conexiones abiertas,
#        · con --keep-old RENOMBRA la base actual a <base>__antes_de_restaurar_<fecha>
#          (si no se usa, la elimina: los datos actuales se pierden),
#        · la recrea con el rol del servicio como propietario,
#        · restaura con --no-owner --role=<rol>,
#        · ejecuta ANALYZE y comprueba tablas y propiedad.
#   5. Informa con mensajes claros qué se hizo y con qué código termina.
#
# USO
#   # Ver qué respaldos hay:
#   sudo .../odontocrm-restore.sh --list
#
#   # Simulación: dice exactamente qué haría, sin tocar nada:
#   sudo .../odontocrm-restore.sh --from /var/backups/odontocrm/2026-10-02 --all --dry-run
#
#   # PRUEBA DE RESTAURACIÓN (no destructiva; conserva la base temporal):
#   sudo .../odontocrm-restore.sh --from /var/backups/odontocrm/2026-10-02 \
#        --db odonto_identity --keep-verify-db --yes
#
#   # Restauración real de una base (DESTRUCTIVA; conserva la anterior):
#   sudo .../odontocrm-restore.sh --from .../2026-10-02 --db odonto_identity \
#        --keep-old --yes
#
# NO HACE
#   · No ejecuta migraciones: si el respaldo es de un esquema anterior, hay que
#     aplicar las migraciones del servicio después (INSTALL.md §13.5).
#   · No restaura los archivos de --include-config / --include-storage:
#     son tar.gz y se extraen a mano (INSTALL.md §13.4).
#   · No arranca ni detiene servicios: reinícielos al terminar (INSTALL.md §13.6).
#
# CÓDIGOS DE SALIDA
#   0  = restauración (o simulación) correcta
#   1  = error de configuración o de precondiciones
#   2  = respaldo no encontrado, ilegible o corrupto
#   3  = falló la verificación en la base temporal (NO se tocó la base real)
#   4  = falló la restauración sobre la base definitiva
#   5  = la restauración terminó pero la comprobación posterior no pasó
#   10 = falta --yes (no se ejecutó nada)
#
# > PENDIENTE FASE 10: el flujo completo (base temporal → restauración definitiva,
#   `--no-owner --role=<rol>`, `DROP DATABASE ... WITH (FORCE)` y la comprobación
#   de propiedad) debe validarse con las 8 bases en el servidor Fedora, siguiendo
#   la prueba documentada de INSTALL.md §16.2. Hasta entonces, este script es un
#   borrador no probado.
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
trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR

# Y un aviso de SALIDA: se ejecuta siempre, incluso cuando bash aborta por `set -u` (ese
# caso **no** pasa por el trap de ERR). Es el que habría dicho «el ensayo terminó con
# error en la línea X» en vez de dejar una salida truncada que parecía un reinicio roto.
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT


readonly SCRIPT_NAME="${0##*/}"
readonly SCRIPT_VERSION="0.1.0-draft"

# -----------------------------------------------------------------------------
# Valores por defecto (los sobrescribe /etc/odontocrm/backup.env y los flags)
# -----------------------------------------------------------------------------
BACKUP_DIR="/var/backups/odontocrm"
LOG_FILE="/var/log/odontocrm/restore.log"
PG_HOST="/var/run/postgresql"
PG_PORT="5432"
# La lista de bases se DERIVADA del repositorio (infra/fedora/lib/servicios.sh): una por
# servicio + la cola. Estaba escrita a mano aquí y con `billing` la copia diaria se quedó sin
# las facturas **diciendo «respaldo completado sin errores»**.
LIB_SERVICIOS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/servicios.sh"
if [[ -f "$LIB_SERVICIOS" ]]; then
  # shellcheck source=../lib/servicios.sh
  source "$LIB_SERVICIOS"
  BASES_DERIVADAS="$(bases_del_respaldo)"
else
  BASES_DERIVADAS=""
fi
PG_ADMIN_USER="postgres"          # usuario con permiso para DROP/CREATE DATABASE
PGPASSFILE="/etc/odontocrm/.pgpass"
DATABASES="${BASES_DERIVADAS}"
CONFIG_FILE="/etc/odontocrm/backup.env"
PGBIN_DIR=""
VERIFY_SUFFIX="__verif"
OLD_SUFFIX="__antes_de_restaurar"

FROM=""
DB_LIST=()
ALL=0
ASSUME_YES=0
DRY_RUN=0
LIST_ONLY=0
LIMPIAR_VERIF=0
KEEP_VERIFY_DB=0
KEEP_OLD=0
SKIP_VERIFY=0
ALLOW_UNKNOWN_DB=0
NO_ANALYZE=0
MIN_TABLES=1
EVIDENCE_LOG=""

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

ts() { date '+%Y-%m-%d %H:%M:%S%z'; }

log_line() {
  local level="$1"; shift
  local msg="$(ts) [${level}] $*"
  case "$level" in
    ERROR) printf '%s%s%s\n' "$C_RED" "$msg" "$C_RESET" >&2 ;;
    WARN)  printf '%s%s%s\n' "$C_YELLOW" "$msg" "$C_RESET" >&2 ;;
    OK)    printf '%s%s%s\n' "$C_GREEN" "$msg" "$C_RESET" ;;
    *)     printf '%s\n' "$msg" ;;
  esac
  if [[ -n "${LOG_FILE:-}" ]]; then
    local dir; dir="$(dirname -- "$LOG_FILE")"
    [[ -d "$dir" ]] || mkdir -p "$dir" 2>/dev/null || true
    { printf '%s\n' "$msg" >>"$LOG_FILE"; } 2>/dev/null || true
  fi
}
log()  { log_line INFO  "$@"; }
ok()   { log_line OK    "$@"; }
warn() { log_line WARN  "$@"; }
err()  { log_line ERROR "$@"; }
step() { printf '\n%s\n' "${C_BOLD}${C_BLUE}▸ $*${C_RESET}"; log "── $*"; }

die() { local code="${2:-1}"; err "${1:-error inesperado}"; exit "$code"; }

usage() {
  cat <<EOF
${SCRIPT_NAME} v${SCRIPT_VERSION} — restaura bases de OdontoCRM desde un respaldo

USO
  sudo ./${SCRIPT_NAME} --from <DIR|ARCHIVO.dump> (--db NAME ... | --all) --yes [opciones]

OBLIGATORIO
  --from RUTA             Directorio de respaldo (AAAA-MM-DD) o archivo .dump.
  --db NAME               Base a restaurar (repetible).
  --all                   Todas las bases halladas en el respaldo.
  --yes                   Confirma la operación. SIN ESTE FLAG NO SE TOCA NADA.

VERIFICACIÓN
  --keep-verify-db        No borra la base temporal <base>${VERIFY_SUFFIX} (evidencia).
  --skip-verify           Omite el paso por la base temporal (NO recomendado).
  --min-tables N          Mínimo de tablas esperadas (def. ${MIN_TABLES}).
  --no-analyze            No ejecuta ANALYZE al terminar.

SEGURIDAD DE LOS DATOS ACTUALES
  --keep-old              Renombra la base actual a <base>${OLD_SUFFIX}_<fecha>
                          en lugar de eliminarla (necesita espacio en disco).
  --allow-unknown-db      Permite restaurar bases fuera de la lista conocida.

CONEXIÓN Y RUTAS
  --admin-user USER       Usuario administrador para DROP/CREATE (def. ${PG_ADMIN_USER}).
  --pg-host HOST          Socket (/var/run/postgresql) o 127.0.0.1.
  --pg-port N             Puerto (def. 5432).
  --pgbin DIR             Directorio de binarios de PostgreSQL 18.
  --config FILE           Configuración (def. ${CONFIG_FILE}).
  --log FILE              Log de la restauración (def. ${LOG_FILE}).
  --dest DIR              Directorio base de respaldos (def. ${BACKUP_DIR}).

DIAGNÓSTICO
  --list                  Lista los respaldos disponibles y termina.
  --limpiar-verif         Borra las bases temporales <base>${VERIFY_SUFFIX} que deja la
                          verificación (con --keep-verify-db se conservan a propósito
                          como evidencia; este flag las retira cuando ya no hacen
                          falta). Requiere --yes.
  --dry-run               Explica lo que haría sin modificar ninguna base
                          (deja el registro de la corrida en el log).
  -h, --help              Esta ayuda.

CÓDIGOS DE SALIDA
  0 correcto · 1 configuración · 2 respaldo inválido · 3 falló la verificación
  4 falló la restauración · 5 falló la comprobación posterior · 10 falta --yes
EOF
}

# -----------------------------------------------------------------------------
# Argumentos y configuración
# -----------------------------------------------------------------------------
parse_args() {
  while (( $# )); do
    case "$1" in
      --from)             FROM="${2:?--from requiere una ruta}"; shift ;;
      --from=*)           FROM="${1#*=}" ;;
      --db)               DB_LIST+=("${2:?--db requiere un nombre}"); shift ;;
      --db=*)             DB_LIST+=("${1#*=}") ;;
      --all)              ALL=1 ;;
      --yes|-y)           ASSUME_YES=1 ;;
      --dry-run)          DRY_RUN=1 ;;
      --keep-verify-db)   KEEP_VERIFY_DB=1 ;;
      --skip-verify)      SKIP_VERIFY=1 ;;
      --keep-old)         KEEP_OLD=1 ;;
      --allow-unknown-db) ALLOW_UNKNOWN_DB=1 ;;
      --no-analyze)       NO_ANALYZE=1 ;;
      --min-tables)       MIN_TABLES="${2:?--min-tables requiere un número}"; shift ;;
      --min-tables=*)     MIN_TABLES="${1#*=}" ;;
      --admin-user)       PG_ADMIN_USER="${2:?}"; shift ;;
      --admin-user=*)     PG_ADMIN_USER="${1#*=}" ;;
      --pg-host)          PG_HOST="${2:?}"; shift ;;
      --pg-host=*)        PG_HOST="${1#*=}" ;;
      --pg-port)          PG_PORT="${2:?}"; shift ;;
      --pg-port=*)        PG_PORT="${1#*=}" ;;
      --pgbin)            PGBIN_DIR="${2:?}"; shift ;;
      --pgbin=*)          PGBIN_DIR="${1#*=}" ;;
      --config)           CONFIG_FILE="${2:?}"; shift ;;
      --config=*)         CONFIG_FILE="${1#*=}" ;;
      --log)              LOG_FILE="${2:?}"; shift ;;
      --log=*)            LOG_FILE="${1#*=}" ;;
      --dest)             BACKUP_DIR="${2:?}"; shift ;;
      --dest=*)           BACKUP_DIR="${1#*=}" ;;
      --list)             LIST_ONLY=1 ;;
      --limpiar-verif)    LIMPIAR_VERIF=1 ;;
      -h|--help)          usage; exit 0 ;;
      *) err "opción no reconocida: $1"; usage; exit 1 ;;
    esac
    shift
  done
}

load_config() {
  if [[ -n "$CONFIG_FILE" && -r "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    log "configuración cargada de $CONFIG_FILE"
  fi
  if (( ${#DB_LIST[@]} == 0 )); then
    ALL=1   # sin --db se restauran todas las bases halladas en el respaldo
  fi
}

pg_bin() {
  local tool="$1"
  if [[ -n "$PGBIN_DIR" && -x "$PGBIN_DIR/$tool" ]]; then
    printf '%s\n' "$PGBIN_DIR/$tool"
  elif command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
  else
    return 1
  fi
}

# Entorno de conexión común (PGPASSFILE solo si está definido).
PGENV=()
build_pgenv() {
  PGENV=(PGHOST="$PG_HOST" PGPORT="$PG_PORT" PGCONNECT_TIMEOUT=15)
  if [[ -n "${PGPASSFILE:-}" ]]; then
    PGENV+=(PGPASSFILE="$PGPASSFILE")
  fi
}

# `-w` (--no-password): si falta la credencial, psql FALLA en el acto en vez de
# quedarse esperando a que alguien teclee la contraseña. Un restablecimiento en la
# clínica puede correr sin nadie delante: es preferible un error claro a un proceso
# colgado que parece estar trabajando. Medido en el ensayo de la Fase 10: el
# restablecimiento se quedó 1 minuto mudo esperando la contraseña del rol
# administrador porque no estaba en /etc/odontocrm/.pgpass.
psql_q() { # psql_q <usuario> <base> <consulta>  → valor sin formato
  local user="$1" db="$2" sql="$3"
  env "${PGENV[@]}" "$(pg_bin psql)" -X -q -t -A -w -v ON_ERROR_STOP=1 \
    -U "$user" -d "$db" -c "$sql"
}
psql_c() { # psql_c <usuario> <comando>  → se ejecuta contra la base «postgres»
  local user="$1" sql="$2"
  env "${PGENV[@]}" "$(pg_bin psql)" -X -q -w -v ON_ERROR_STOP=1 \
    -U "$user" -d postgres -c "$sql" >/dev/null
}

SQL_TABLE_COUNT="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema')"

# -----------------------------------------------------------------------------
# Utilidades de respaldo
# -----------------------------------------------------------------------------
# Devuelve la ruta del volcado de una base dentro de un directorio de respaldo.
find_dump_for_db() {
  local dir="$1" db="$2" f
  for f in "$dir/${db}"_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_*.dump; do
    if [[ -f "$f" ]]; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

# Deriva el nombre de la base a partir del nombre del archivo <base>_<fecha>.dump
db_from_dump() {
  local base; base="$(basename "$1")"
  printf '%s\n' "${base%%_2[0-9][0-9][0-9]-*}"
}

# Rol propietario de una base: ROLE_<base> en backup.env, o el nombre de la base.
role_for_db() {
  local var="ROLE_${1}"
  printf '%s\n' "${!var:-$1}"
}

list_backups() {
  printf '%s\n' "${C_BOLD}Respaldos en ${BACKUP_DIR}:${C_RESET}"
  if [[ ! -d "$BACKUP_DIR" ]]; then
    warn "el directorio $BACKUP_DIR no existe"
    return 0
  fi
  local d f n=0
  while IFS= read -r d; do
    n=$((n + 1))
    printf '\n  %s%s%s\n' "$C_BOLD" "$(basename "$d")" "$C_RESET"
    find "$d" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.tar.gz' -o -name 'manifest.txt' -o -name 'SHA256SUMS' \) \
      -printf '    %-46f %12s bytes  %TY-%Tm-%Td %TH:%TM\n' 2>/dev/null | sort || true
    for f in "$d"/*.dump; do
      [[ -f "$f" ]] || continue
      if [[ "$(head -c 5 "$f" 2>/dev/null || true)" == "PGDMP" ]]; then
        printf '    %s✔%s cabecera PGDMP válida en %s\n' "$C_GREEN" "$C_RESET" "$(basename "$f")"
      else
        printf '    %s✖%s cabecera NO válida en %s\n' "$C_RED" "$C_RESET" "$(basename "$f")"
      fi
    done
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
  if (( n == 0 )); then
    warn "no se encontraron directorios de respaldo en $BACKUP_DIR"
  fi
}

# -----------------------------------------------------------------------------
# Comprobación de un volcado antes de usarlo
# -----------------------------------------------------------------------------
validate_dump() {
  local file="$1"
  [[ -f "$file" ]] || { err "no existe el archivo $file"; return 2; }
  [[ -s "$file" ]] || { err "el archivo $file está vacío"; return 2; }

  local magic; magic="$(head -c 5 "$file" || true)"
  [[ "$magic" == "PGDMP" ]] || { err "$file no parece un volcado de pg_dump (cabecera: '$magic')"; return 2; }

  if ! "$(pg_bin pg_restore)" --list "$file" >/dev/null 2>&1; then
    err "pg_restore --list no pudo leer $file (¿pg_restore de otra versión mayor?)"
    return 2
  fi
  log "volcado válido: $file ($(stat -c '%s' "$file") bytes)"

  # Suma SHA-256, si el respaldo la trae.
  # Se parsea de forma tolerante: sha256sum escribe «hash  archivo» (texto) o
  # «hash *archivo» (binario) según la plataforma, y ambas formas son válidas.
  local dir sums expected actual name
  dir="$(dirname "$file")"; sums="$dir/SHA256SUMS"; name="$(basename "$file")"
  if [[ -f "$sums" ]]; then
    expected="$(awk -v f="$name" '{ n=$2; sub(/^\*/, "", n); if (n == f) { print $1; exit } }' "$sums" || true)"
    if [[ -n "$expected" ]]; then
      actual="$(sha256sum "$file" | awk '{print $1}' || true)"
      if [[ "$expected" == "$actual" ]]; then
        log "suma SHA-256 correcta"
      else
        err "la suma SHA-256 NO coincide: el respaldo está alterado o incompleto"
        err "  esperado: $expected"
        err "  obtenido: $actual"
        return 2
      fi
    else
      warn "SHA256SUMS no incluye $name; se omite la comprobación de suma"
    fi
  else
    warn "no hay SHA256SUMS junto al volcado; se omite la comprobación de suma"
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Paso A: restaurar en la base temporal de verificación
# -----------------------------------------------------------------------------
verify_into_temp_db() {
  local db="$1" file="$2" role="$3"
  local tmpdb="${db}${VERIFY_SUFFIX}"

  step "Verificación: restaurando en la base temporal «${tmpdb}»"
  if (( DRY_RUN )); then
    printf '       %s[dry-run]$ DROP DATABASE IF EXISTS %s; CREATE DATABASE %s OWNER %s%s\n' \
      "$C_DIM" "$tmpdb" "$tmpdb" "$role" "$C_RESET"
    printf '       %s[dry-run]$ pg_restore -d %s --no-owner --role=%s --exit-on-error --verbose %s%s\n' \
      "$C_DIM" "$tmpdb" "$role" "$file" "$C_RESET"
    printf '       %s[dry-run]$ psql -d %s -c "%s"   # comprobar tablas y propiedad%s\n' \
      "$C_DIM" "$tmpdb" "${SQL_TABLE_COUNT//$'\n'/ }" "$C_RESET"
    return 0
  fi

  psql_c "$PG_ADMIN_USER" "DROP DATABASE IF EXISTS \"${tmpdb}\" WITH (FORCE);"
  psql_c "$PG_ADMIN_USER" "CREATE DATABASE \"${tmpdb}\" OWNER \"${role}\";"

  if ! env "${PGENV[@]}" "$(pg_bin pg_restore)" \
        --dbname="$tmpdb" --username="$PG_ADMIN_USER" \
        --no-owner --role="$role" --exit-on-error --verbose "$file" \
        >"$EVIDENCE_LOG" 2>&1; then
    err "la restauración de verificación FALLÓ (detalle en $EVIDENCE_LOG)."
    err "La base «${db}» NO se ha tocado."
    tail -n 20 "$EVIDENCE_LOG" | sed 's/^/       /' >&2 || true
    return 3
  fi

  local tables owned
  tables="$(psql_q "$PG_ADMIN_USER" "$tmpdb" "$SQL_TABLE_COUNT")"
  log "tablas restauradas en ${tmpdb}: ${tables} (registro completo: $EVIDENCE_LOG)"

  if (( tables < MIN_TABLES )); then
    err "se esperaban al menos ${MIN_TABLES} tabla(s) y se encontraron ${tables}"
    return 3
  fi

  owned="$(psql_q "$PG_ADMIN_USER" "$tmpdb" \
    "$SQL_TABLE_COUNT AND pg_get_userbyid(c.relowner) = '${role}'")"
  if (( owned < tables )); then
    warn "propiedad: ${owned} de ${tables} tablas pertenecen a «${role}»."
    warn "  Revise ROLE_${db} en ${CONFIG_FILE} (¿el rol del servicio se llama distinto?)."
  else
    ok "propiedad verificada: las ${tables} tablas pertenecen a «${role}»"
  fi

  if (( KEEP_VERIFY_DB )); then
    ok "la base temporal «${tmpdb}» se conserva como evidencia (--keep-verify-db)"
  else
    psql_c "$PG_ADMIN_USER" "DROP DATABASE IF EXISTS \"${tmpdb}\" WITH (FORCE);"
    log "base temporal «${tmpdb}» eliminada"
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Paso B: restaurar sobre la base definitiva
# -----------------------------------------------------------------------------
restore_in_place() {
  local db="$1" file="$2" role="$3"
  local olddb="${db}${OLD_SUFFIX}_$(date +%Y-%m-%d_%H%M%S)"

  step "Restauración definitiva de «${db}»"
  if (( DRY_RUN )); then
    printf '       %s[dry-run]$ SELECT pg_terminate_backend(pid) ...   # cerrar conexiones a %s%s\n' \
      "$C_DIM" "$db" "$C_RESET"
    if (( KEEP_OLD )); then
      printf '       %s[dry-run]$ ALTER DATABASE %s RENAME TO %s%s\n' "$C_DIM" "$db" "$olddb" "$C_RESET"
    else
      printf '       %s[dry-run]$ DROP DATABASE IF EXISTS %s WITH (FORCE)   # ¡los datos actuales se pierden!%s\n' \
        "$C_DIM" "$db" "$C_RESET"
    fi
    printf '       %s[dry-run]$ CREATE DATABASE %s OWNER %s%s\n' "$C_DIM" "$db" "$role" "$C_RESET"
    printf '       %s[dry-run]$ pg_restore -d %s --no-owner --role=%s --exit-on-error --verbose %s%s\n' \
      "$C_DIM" "$db" "$role" "$file" "$C_RESET"
    printf '       %s[dry-run]$ psql -d %s -c "ANALYZE;"%s\n' "$C_DIM" "$db" "$C_RESET"
    return 0
  fi

  # 1) Cerrar conexiones (los servicios deberían estar detenidos).
  psql_c "$PG_ADMIN_USER" \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${db}' AND pid <> pg_backend_pid();"
  local open_conns
  open_conns="$(psql_q "$PG_ADMIN_USER" postgres \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}';")"
  if (( open_conns > 0 )); then
    warn "quedan ${open_conns} conexión(es) a «${db}». Si la restauración falla,"
    warn "  detenga antes los servicios: sudo systemctl stop odontocrm@<servicio>.service"
  fi

  # 2) Apartar o eliminar la base actual.
  if (( KEEP_OLD )); then
    if ! psql_c "$PG_ADMIN_USER" "ALTER DATABASE \"${db}\" RENAME TO \"${olddb}\";"; then
      err "no se pudo renombrar «${db}» a «${olddb}»"
      return 4
    fi
    warn "la base anterior quedó como «${olddb}» (elimínela cuando valide la restauración)"
  else
    if ! psql_c "$PG_ADMIN_USER" "DROP DATABASE IF EXISTS \"${db}\" WITH (FORCE);"; then
      err "no se pudo eliminar «${db}»"
      return 4
    fi
    log "base «${db}» eliminada (sin --keep-old no queda copia previa)"
  fi

  # 3) Recrear con el rol del servicio como propietario.
  if ! psql_c "$PG_ADMIN_USER" "CREATE DATABASE \"${db}\" OWNER \"${role}\";"; then
    err "no se pudo crear «${db}» con propietario «${role}»"
    warn "  Compruebe que el rol existe: psql -c \"\\du\" (lo crea el bootstrap de la Fase 0)."
    return 4
  fi

  # 4) Restaurar el contenido.
  if ! env "${PGENV[@]}" "$(pg_bin pg_restore)" \
        --dbname="$db" --username="$PG_ADMIN_USER" \
        --no-owner --role="$role" --exit-on-error --verbose "$file" \
        >"$EVIDENCE_LOG" 2>&1; then
    err "la restauración de «${db}» FALLÓ (detalle en $EVIDENCE_LOG)"
    tail -n 20 "$EVIDENCE_LOG" | sed 's/^/       /' >&2 || true
    if (( KEEP_OLD )); then
      warn "la base anterior sigue disponible como «${olddb}»"
    fi
    return 4
  fi

  # 5) Estadísticas y comprobación posterior.
  if (( ! NO_ANALYZE )); then
    if ! psql_q "$PG_ADMIN_USER" "$db" "ANALYZE;" >/dev/null; then
      warn "ANALYZE falló (no es crítico)"
    fi
  fi

  local tables owned
  tables="$(psql_q "$PG_ADMIN_USER" "$db" "$SQL_TABLE_COUNT")"
  owned="$(psql_q "$PG_ADMIN_USER" "$db" \
    "$SQL_TABLE_COUNT AND pg_get_userbyid(c.relowner) = '${role}'")"
  log "«${db}» restaurada: ${tables} tabla(s), ${owned} con propietario «${role}»"

  if (( tables < MIN_TABLES )); then
    err "la base «${db}» quedó con ${tables} tabla(s) (menos de ${MIN_TABLES})"
    if (( KEEP_OLD )); then warn "puede volver atrás renombrando «${olddb}» a «${db}»"; fi
    return 5
  fi
  if (( owned < tables )); then
    warn "hay tablas que no pertenecen a «${role}»: revise ROLE_${db} en ${CONFIG_FILE}"
    return 5
  fi

  ok "«${db}» restaurada y verificada"
  return 0
}

# -----------------------------------------------------------------------------
# Programa principal
# -----------------------------------------------------------------------------
# Borra las bases temporales que deja la verificación en las 8 bases conocidas.
limpiar_verificacion() {
  if (( ! ASSUME_YES )); then
    err "--limpiar-verif borra bases: añade --yes para confirmarlo"
    exit 10
  fi
  local base borradas=0
  log "Limpiando bases temporales ${VERIFY_SUFFIX}…"
  for base in $DATABASES; do
    if [[ "$(psql_q "$PG_ADMIN_USER" postgres "SELECT 1 FROM pg_database WHERE datname='${base}${VERIFY_SUFFIX}'")" == "1" ]]; then
      psql_c "$PG_ADMIN_USER" "DROP DATABASE IF EXISTS \"${base}${VERIFY_SUFFIX}\" WITH (FORCE);" >/dev/null 2>&1 &&
        { log "  ${base}${VERIFY_SUFFIX} borrada"; borradas=$((borradas + 1)); } ||
        warn "  no pude borrar ${base}${VERIFY_SUFFIX} (¿hay conexiones abiertas?)"
    fi
  done
  log "Bases temporales borradas: ${borradas}"
}

main() {
  parse_args "$@"
  load_config
  build_pgenv

  if (( LIST_ONLY )); then
    list_backups
    exit 0
  fi

  if (( LIMPIAR_VERIF )); then
    limpiar_verificacion
    exit 0
  fi

  # --- Precondiciones -------------------------------------------------------
  local t missing=()
  for t in psql pg_restore; do
    pg_bin "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  (( ${#missing[@]} == 0 )) || die "faltan binarios de PostgreSQL: ${missing[*]} (use --pgbin)" 1

  if [[ -z "$FROM" ]]; then
    err "--from es obligatorio (use --list para ver los respaldos disponibles)"
    usage
    exit 1
  fi
  [[ -e "$FROM" ]] || die "no existe la ruta indicada en --from: $FROM" 2
  case "$MIN_TABLES" in ''|*[!0-9]*) die "--min-tables debe ser un número entero" 1 ;; esac

  # Comprobar cuanto antes que las bases pedidas son las del sistema.
  if (( ! ALLOW_UNKNOWN_DB )) && (( ${#DB_LIST[@]} > 0 )); then
    local k
    for db in "${DB_LIST[@]}"; do
      k=0
      for t in $DATABASES; do
        if [[ "$t" == "$db" ]]; then k=1; fi
      done
      if (( ! k )); then
        die "«${db}» no está en la lista DATABASES (use --allow-unknown-db si es correcto)" 1
      fi
    done
  fi

  # --- Resolver la lista de trabajo: base → archivo de volcado --------------
  local -A WORK=()   # base -> archivo .dump
  local f db
  if [[ -f "$FROM" ]]; then
    db="$(db_from_dump "$FROM")"
    WORK["$db"]="$FROM"
  elif [[ -d "$FROM" ]]; then
    if (( ${#DB_LIST[@]} > 0 )); then
      for db in "${DB_LIST[@]}"; do
        if f="$(find_dump_for_db "$FROM" "$db")"; then
          WORK["$db"]="$f"
        else
          die "no hay volcado de «${db}» en $FROM" 2
        fi
      done
    else
      for f in "$FROM"/*.dump; do
        [[ -f "$f" ]] || continue
        db="$(db_from_dump "$f")"
        WORK["$db"]="$f"
      done
      (( ${#WORK[@]} > 0 )) || die "no se encontraron archivos .dump en $FROM" 2
    fi
  else
    die "--from debe ser un directorio de respaldo o un archivo .dump" 1
  fi

  # --- Comprobar que las bases son conocidas -------------------------------
  if (( ! ALLOW_UNKNOWN_DB )); then
    local known
    for db in "${!WORK[@]}"; do
      known=0
      for t in $DATABASES; do
        if [[ "$t" == "$db" ]]; then known=1; fi
      done
      if (( ! known )); then
        die "«${db}» no está en la lista DATABASES (use --allow-unknown-db si es correcto)" 1
      fi
    done
  fi

  # --- Plan y confirmación explícita ---------------------------------------
  local SORTED_DBS=() EVIDENCE_STAMP evidence_dir
  while IFS= read -r db; do SORTED_DBS+=("$db"); done < <(printf '%s\n' "${!WORK[@]}" | sort)

  EVIDENCE_STAMP="$(date +%Y-%m-%d_%H%M%S)"
  evidence_dir="$(dirname -- "$LOG_FILE")"
  [[ -d "$evidence_dir" ]] || mkdir -p "$evidence_dir" 2>/dev/null || true
  EVIDENCE_LOG="${evidence_dir}/restore_${EVIDENCE_STAMP}.log"

  local old_desc new_desc
  if (( KEEP_OLD )); then old_desc="se renombra a <base>${OLD_SUFFIX}_<fecha>"
  else old_desc="SE ELIMINA (use --keep-old para conservarla)"; fi
  if (( KEEP_VERIFY_DB )); then new_desc="(se conserva como evidencia)"
  else new_desc="(se elimina al verificar)"; fi

  printf '\n%s\n' "${C_BOLD}Plan de restauración${C_RESET}"
  printf '  origen        : %s\n' "$FROM"
  printf '  base temporal : <base>%s %s\n' "$VERIFY_SUFFIX" "$new_desc"
  printf '  base actual   : %s\n' "$old_desc"
  printf '  evidencia     : %s\n' "$EVIDENCE_LOG"
  printf '  bases (%d):\n' "${#SORTED_DBS[@]}"
  for db in "${SORTED_DBS[@]}"; do
    printf '    · %-24s ← %-42s (rol: %s)\n' "$db" "$(basename "${WORK[$db]}")" "$(role_for_db "$db")"
  done

  if (( ! ASSUME_YES && ! DRY_RUN )); then
    printf '\n%s\n' "${C_YELLOW}No se ejecutó nada: falta --yes.${C_RESET}"
    printf 'Vuelva a ejecutar el mismo comando añadiendo %s--yes%s cuando esté seguro.\n' "$C_BOLD" "$C_RESET"
    exit 10
  fi
  if (( DRY_RUN )); then
    log "MODO SIMULACIÓN (--dry-run): no se modificará ninguna base de datos"
  else
    warn "MODO REAL: se va a modificar la base de datos (confirmado con --yes)."
    if (( ! KEEP_OLD )); then
      warn "  Sin --keep-old, la base actual se elimina. ¿Está seguro?"
    fi
  fi

  # --- Validar TODOS los volcados antes de tocar nada ----------------------
  local vrc=0
  for db in "${SORTED_DBS[@]}"; do
    validate_dump "${WORK[$db]}" && vrc=0 || vrc=$?
    if (( vrc != 0 )); then
      die "abortado: el respaldo de «${db}» no es válido. No se modificó ninguna base." 2
    fi
  done

  # --- Ejecutar -------------------------------------------------------------
  local rc=0 total_ok=0 total_fail=0 vs=0 pr=0 role
  for db in "${SORTED_DBS[@]}"; do
    role="$(role_for_db "$db")"

    if (( ! SKIP_VERIFY )); then
      verify_into_temp_db "$db" "${WORK[$db]}" "$role" && vs=0 || vs=$?
      if (( vs != 0 )); then
        err "se omite la restauración definitiva de «${db}»: falló la verificación (código $vs)"
        total_fail=$((total_fail + 1))
        if (( vs > rc )); then rc=$vs; fi
        continue
      fi
    else
      warn "--skip-verify: se restaura directamente sobre la base definitiva (sin red de seguridad)"
    fi

    restore_in_place "$db" "${WORK[$db]}" "$role" && pr=0 || pr=$?
    if (( pr == 0 )); then
      total_ok=$((total_ok + 1))
    else
      total_fail=$((total_fail + 1))
      if (( pr > rc )); then rc=$pr; fi
    fi
  done

  # --- Resumen final --------------------------------------------------------
  step "Resumen"
  printf '  bases restauradas correctamente : %d\n' "$total_ok"
  printf '  bases con problemas             : %d\n' "$total_fail"
  printf '  evidencia detallada             : %s\n' "$EVIDENCE_LOG"
  printf '  log                             : %s\n' "$LOG_FILE"

  if (( DRY_RUN )); then
    log "simulación terminada (no se modificó ninguna base de datos)"
    exit 0
  fi

  if (( total_fail == 0 )); then
    ok "restauración finalizada sin errores"
    cat <<EOF

${C_BOLD}Siguientes pasos${C_RESET}
  1. Arrancar de nuevo los servicios afectados:
       sudo systemctl start odontocrm@<servicio>.service      # o: pm2 restart <nombre>
  2. Comprobar salud:  curl -fsS http://127.0.0.1:<puerto>/health
  3. Si el respaldo era de un esquema anterior, aplique migraciones (INSTALL.md §13.5).
  4. Si usó --keep-old, borre «<base>${OLD_SUFFIX}_<fecha>» cuando valide todo.
EOF
    exit 0
  fi

  err "restauración terminada con ${total_fail} base(s) con problemas (código $rc)"
  exit "$rc"
}

main "$@"
