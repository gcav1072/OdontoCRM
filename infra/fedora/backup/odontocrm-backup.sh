#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# OdontoCRM · Respaldo diario de las 8 bases + copias opcionales
# -----------------------------------------------------------------------------
# Archivo : infra/fedora/backup/odontocrm-backup.sh
# Versión : 0.1.0-draft (borrador Fase 0 — se prueba y completa en la Fase 10)
# Guía    : infra/fedora/INSTALL.md §12 (respaldos) y §13 (restauración probada)
#
# QUÉ HACE
#   1. Toma un candado para no solaparse con otra ejecución.
#   2. Ejecuta `pg_dump --format=custom` (-Fc) por CADA base de la lista, en un
#      directorio con la fecha del día:  <destino>/AAAA-MM-DD/
#   3. Comprime el volcado (gzip nivel 6, integrado en el formato custom).
#   4. Verifica la integridad de cada archivo:
#        · primeros 5 bytes == "PGDMP"
#        · `pg_restore --list` recorre el catálogo sin errores
#        · suma SHA-256 registrada en SHA256SUMS
#   5. Opcionalmente respalda /etc/odontocrm (--include-config) y el directorio
#      de almacenamiento (--include-storage).
#   6. Escribe manifest.txt (metadatos) y backup.log (registro).
#   7. Aplica la retención: borra los directorios con fecha de más de N días
#      (por defecto 30). Solo toca directorios con nombre AAAA-MM-DD.
#
# USO
#   sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh --dry-run
#   sudo /opt/odontocrm/infra/fedora/backup/odontocrm-backup.sh
#   sudo .../odontocrm-backup.sh --include-config --retention 30
#   sudo .../odontocrm-backup.sh --db odonto_identity        # una sola base
#   (normalmente lo invoca el temporizador systemd: INSTALL.md §12.4)
#
# NO HACE
#   · No toca ni modifica datos: solo lee. No restaura nada (use odontocrm-restore.sh).
#   · No borra la base de datos ni el clúster.
#   · No cifra los respaldos: los respaldos CONTIENEN DATOS CLÍNICOS y, con
#     --include-config, también secretos. Custódielos en un medio protegido.
#     > PENDIENTE FASE 10: decidir el cifrado en reposo (age/gpg) y la copia
#       externa (otro equipo de la LAN o el tailnet).
#
# CÓDIGOS DE SALIDA
#   0 = respaldo correcto (incluye «ya había otro en curso» y --dry-run)
#   1 = error de configuración o de precondiciones (nada se respaldó)
#   2 = falló el volcado de una o más bases
#   3 = falló la verificación de integridad de uno o más archivos
#   4 = falló una copia opcional (--include-config / --include-storage)
#   5 = falló la retención (no se pudieron borrar respaldos antiguos)
# =============================================================================

set -euo pipefail

readonly SCRIPT_NAME="${0##*/}"
readonly SCRIPT_VERSION="0.1.0-draft"

# -----------------------------------------------------------------------------
# Valores por defecto (los sobrescribe /etc/odontocrm/backup.env y los flags)
# -----------------------------------------------------------------------------
BACKUP_DIR="/var/backups/odontocrm"
RETENTION_DAYS="30"
LOG_FILE="/var/log/odontocrm/backup.log"
PG_HOST="/var/run/postgresql"
PG_PORT="5432"
PG_USER="postgres"
PGPASSFILE="/etc/odontocrm/.pgpass"
DATABASES="odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting"
STORAGE_DIR="/var/lib/odontocrm/storage"
CONFIG_DIR="/etc/odontocrm"
CONFIG_FILE="/etc/odontocrm/backup.env"

INCLUDE_CONFIG=0
INCLUDE_STORAGE=0
DRY_RUN=0
VERIFY=1
PGBIN_DIR=""          # p. ej. /usr/pgsql-18/bin si los binarios no están en PATH

# -----------------------------------------------------------------------------
# Utilidades
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''
fi

ts() { date '+%Y-%m-%d %H:%M:%S%z'; }

# Registra en stdout (journal) y, si se puede, en el archivo de log.
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
    # Si el log no se puede escribir, no se interrumpe el respaldo: se avisa
    # solo por stdout/journal (el grupo evita el ruido del redirect fallido).
    { printf '%s\n' "$msg" >>"$LOG_FILE"; } 2>/dev/null || true
  fi
}
log()  { log_line INFO  "$@"; }
ok()   { log_line OK    "$@"; }
warn() { log_line WARN  "$@"; }
err()  { log_line ERROR "$@"; }

# die "<mensaje>" [codigo_de_salida]
die() { local code="${2:-1}"; err "${1:-error inesperado}"; exit "$code"; }

usage() {
  cat <<EOF
${SCRIPT_NAME} v${SCRIPT_VERSION} — respaldo de OdontoCRM (8 bases + copias opcionales)

USO
  sudo ./${SCRIPT_NAME} [opciones]

OPCIONES
  --dest DIR              Directorio destino (por defecto: ${BACKUP_DIR}).
  --retention N           Días de retención (por defecto: 30; 0 = no borrar nada).
  --db NAME               Respalda solo esa base (se puede repetir).
  --all                   Respalda todas las bases de la lista (predeterminado).
  --include-config        Incluye ${CONFIG_DIR} (contiene SECRETOS: custodiar).
  --include-storage       Incluye ${STORAGE_DIR} (radiografías y PDFs).
  --config FILE           Archivo de configuración (por defecto: ${CONFIG_FILE}).
  --pg-host HOST          Host o ruta del socket («/var/run/postgresql» o 127.0.0.1).
  --pg-port N             Puerto de PostgreSQL (por defecto: 5432).
  --pg-user USER          Usuario de respaldo (debe poder leer todas las bases).
  --pgbin DIR             Directorio de binarios de PostgreSQL 18.
  --no-verify             Omite `pg_restore --list` (solo para diagnóstico).
  --dry-run               Muestra lo que haría: no toma respaldos ni toca datos
                          (sí prepara el directorio destino, el log y el candado).
  -h, --help              Esta ayuda.

CÓDIGOS DE SALIDA
  0 correcto · 1 configuración · 2 falló un volcado · 3 falló la verificación
  4 falló una copia opcional · 5 falló la retención
EOF
}

# -----------------------------------------------------------------------------
# Argumentos y configuración
# -----------------------------------------------------------------------------
DB_LIST=()

parse_args() {
  while (( $# )); do
    case "$1" in
      --dest)            BACKUP_DIR="${2:?--dest requiere un valor}"; shift ;;
      --dest=*)          BACKUP_DIR="${1#*=}" ;;
      --retention)       RETENTION_DAYS="${2:?--retention requiere un valor}"; shift ;;
      --retention=*)     RETENTION_DAYS="${1#*=}" ;;
      --db)              DB_LIST+=("${2:?--db requiere un valor}"); shift ;;
      --db=*)            DB_LIST+=("${1#*=}") ;;
      --all)             DB_LIST=() ;;
      --include-config)  INCLUDE_CONFIG=1 ;;
      --include-storage) INCLUDE_STORAGE=1 ;;
      --config)          CONFIG_FILE="${2:?--config requiere un valor}"; shift ;;
      --config=*)        CONFIG_FILE="${1#*=}" ;;
      --pg-host)         PG_HOST="${2:?}"; shift ;;
      --pg-host=*)       PG_HOST="${1#*=}" ;;
      --pg-port)         PG_PORT="${2:?}"; shift ;;
      --pg-port=*)       PG_PORT="${1#*=}" ;;
      --pg-user)         PG_USER="${2:?}"; shift ;;
      --pg-user=*)       PG_USER="${1#*=}" ;;
      --pgbin)           PGBIN_DIR="${2:?}"; shift ;;
      --pgbin=*)         PGBIN_DIR="${1#*=}" ;;
      --no-verify)       VERIFY=0 ;;
      --dry-run)         DRY_RUN=1 ;;
      -h|--help)         usage; exit 0 ;;
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
  elif [[ -n "$CONFIG_FILE" && "$CONFIG_FILE" != "none" ]]; then
    warn "no se pudo leer $CONFIG_FILE; se usan los valores predeterminados"
  fi
}

# -----------------------------------------------------------------------------
# Precondiciones
# -----------------------------------------------------------------------------
pg_bin() { # resuelve el ejecutable de PostgreSQL 18
  local tool="$1"
  if [[ -n "$PGBIN_DIR" && -x "$PGBIN_DIR/$tool" ]]; then
    printf '%s\n' "$PGBIN_DIR/$tool"
  elif command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
  else
    return 1
  fi
}

preflight() {
  command -v flock >/dev/null 2>&1 || warn "no se encontró flock: sin protección contra solapamientos"

  local missing=() t
  for t in pg_dump pg_restore psql; do
    pg_bin "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  (( ${#missing[@]} == 0 )) || die "faltan binarios de PostgreSQL: ${missing[*]} (use --pgbin /usr/pgsql-18/bin)" 1

  local ver; ver="$("$(pg_bin pg_dump)" --version)"
  log "cliente de respaldo: $ver"
  case "$ver" in
    *" 18."*|*" 19."*|*" 20."*) : ;;
    *) warn "pg_dump no es de la versión 18: $ver"
       warn "  El plan exige la MISMA versión mayor que el servidor (18). Ajuste --pgbin." ;;
  esac

  [[ -n "${DATABASES:-}" ]] || die "la lista DATABASES está vacía" 1

  case "$RETENTION_DAYS" in
    ''|*[!0-9]*) die "--retention debe ser un número entero de días" 1 ;;
  esac

  if [[ "$PG_HOST" == /* ]]; then
    [[ -d "$PG_HOST" ]] || warn "el socket $PG_HOST no existe todavía (¿está PostgreSQL arrancado?)"
  fi
  if [[ -n "${PGPASSFILE:-}" ]]; then
    if [[ -r "$PGPASSFILE" ]]; then
      local mode; mode="$(stat -c '%a' "$PGPASSFILE" 2>/dev/null || echo '???')"
      [[ "$mode" == "600" || "$mode" == "400" ]] || warn "$PGPASSFILE tiene permisos $mode; PostgreSQL los exige 0600"
    else
      warn "PGPASSFILE=$PGPASSFILE no es legible; se asume autenticación peer/trust"
    fi
  fi

  if (( INCLUDE_STORAGE )) && [[ ! -d "$STORAGE_DIR" ]]; then
    die "--include-storage: no existe el directorio $STORAGE_DIR" 1
  fi
  if (( INCLUDE_CONFIG )) && [[ ! -d "$CONFIG_DIR" ]]; then
    die "--include-config: no existe el directorio $CONFIG_DIR" 1
  fi
}

# -----------------------------------------------------------------------------
# Verificación de integridad de un volcado
# -----------------------------------------------------------------------------
verify_dump() {
  local file="$1"
  local label="$2"

  [[ -s "$file" ]] || { err "$label: el archivo está vacío o no existe"; return 1; }

  local magic
  magic="$(head -c 5 "$file" 2>/dev/null || true)"
  if [[ "$magic" != "PGDMP" ]]; then
    err "$label: la cabecera no es PGDMP (archivo corrupto o incompleto)"
    return 1
  fi

  if (( VERIFY )); then
    local tmplist="$RUN_DIR/.pg_restore-list.txt"
    if ! "$(pg_bin pg_restore)" --no-password --list "$file" >"$tmplist" 2>"$RUN_DIR/.pg_restore-list.err"; then
      err "$label: pg_restore --list falló (ver $RUN_DIR/.pg_restore-list.err)"
      return 1
    fi
    local entries; entries="$(wc -l <"$tmplist")"
    (( entries > 3 )) || { err "$label: el catálogo tiene $entries líneas (sospechoso)"; return 1; }
    rm -f "$tmplist" "$RUN_DIR/.pg_restore-list.err"
    log "  $label: catálogo verificado ($entries líneas)"
  else
    warn "$label: --no-verify activo, no se valida el catálogo con pg_restore"
  fi

  return 0
}

# -----------------------------------------------------------------------------
# Respaldos
# -----------------------------------------------------------------------------
dump_databases() {
  local dbs=("$@")
  local checksum_list=()
  local failed_dump=0 failed_verify=0 total_bytes=0

  local db file start end bytes
  for db in "${dbs[@]}"; do
    file="$RUN_DIR/${db}_${STAMP}.dump"
    log "respaldando $db → $file"
    start="$(date +%s)"

    if (( DRY_RUN )); then
      printf '       %s[dry-run]$ PGHOST=%s PGPORT=%s PGUSER=%s pg_dump -Fc --compress=gzip:6 -f %s %s%s\n' \
        "$C_DIM" "$PG_HOST" "$PG_PORT" "$PG_USER" "$file" "$db" "$C_RESET"
      continue
    fi

    # Entorno de conexión explícito (PGPASSFILE solo si está definido).
    # > PENDIENTE FASE 10: confirmar que el cliente empaquetado en Fedora acepta
    #   `--compress=gzip:6` (PG16+). Equivalente clásico: `-Z 6`.
    local -a pgenv=(PGHOST="$PG_HOST" PGPORT="$PG_PORT" PGUSER="$PG_USER" PGCONNECT_TIMEOUT=15)
    [[ -n "${PGPASSFILE:-}" ]] && pgenv+=(PGPASSFILE="$PGPASSFILE")

    # `--no-password`: si falta la credencial, pg_dump falla en el acto. Un respaldo
    # desatendido (temporizador de las 03:30) no puede quedarse esperando a que
    # alguien teclee una contraseña: se quedaría mudo toda la noche. Medido en la
    # Fase 10 con el restablecimiento, que sí se quedó esperando.
    if ! env "${pgenv[@]}" "$(pg_bin pg_dump)" --no-password --format=custom --compress=gzip:6 \
        --file="$file" --dbname="$db" 2>"$RUN_DIR/${db}.dump.err"; then
      err "falló el volcado de $db:"
      sed 's/^/       /' "$RUN_DIR/${db}.dump.err" >&2 || true
      failed_dump=$((failed_dump + 1))
      continue
    fi
    rm -f "$RUN_DIR/${db}.dump.err"

    end="$(date +%s)"
    bytes="$(stat -c '%s' "$file")"
    total_bytes=$((total_bytes + bytes))
    ok "  $db: $(numfmt --to=iec --suffix=B "$bytes" 2>/dev/null || echo "$bytes B") en $((end - start)) s"

    if verify_dump "$file" "$db"; then
      checksum_list+=("$file")
    else
      failed_verify=$((failed_verify + 1))
    fi
  done

  # Sumas SHA-256 de todos los archivos del día (para la restauración).
  if (( ! DRY_RUN )) && (( ${#checksum_list[@]} > 0 )); then
    if ( cd "$RUN_DIR" && sha256sum "${checksum_list[@]##*/}" >SHA256SUMS ); then
      log "sumas SHA-256 escritas en $RUN_DIR/SHA256SUMS"
    else
      err "no se pudieron calcular las sumas SHA-256"
      if (( failed_verify == 0 )); then failed_verify=1; fi
    fi
  fi

  LAST_TOTAL_BYTES="$total_bytes"
  (( failed_dump == 0 ))   || return 2
  (( failed_verify == 0 )) || return 3
  return 0
}

copy_config() {
  local out="$RUN_DIR/etc-odontocrm_${STAMP}.tar.gz"
  log "respaldando la configuración y los secretos ($CONFIG_DIR) → $out"
  if (( DRY_RUN )); then
    printf '       %s[dry-run]$ tar -czf %s -C %s %s%s\n' \
      "$C_DIM" "$out" "$(dirname "$CONFIG_DIR")" "$(basename "$CONFIG_DIR")" "$C_RESET"
    return 0
  fi
  if tar --create --gzip --file="$out" --directory="$(dirname "$CONFIG_DIR")" "$(basename "$CONFIG_DIR")" 2>"$RUN_DIR/etc.tar.err"; then
    chmod 0600 "$out"
    warn "  el archivo $out CONTIENE SECRETOS (0600). Guárdelo cifrado y fuera del alcance de terceros."
    ( cd "$RUN_DIR" && sha256sum "$(basename "$out")" >>SHA256SUMS )
    return 0
  fi
  err "falló el respaldo de $CONFIG_DIR:"; sed 's/^/       /' "$RUN_DIR/etc.tar.err" >&2 || true
  return 4
}

copy_storage() {
  local out="$RUN_DIR/storage_${STAMP}.tar.gz"
  log "respaldando el almacenamiento ($STORAGE_DIR) → $out"
  if (( DRY_RUN )); then
    printf '       %s[dry-run]$ tar -czf %s -C %s .%s\n' "$C_DIM" "$out" "$STORAGE_DIR" "$C_RESET"
    return 0
  fi
  local rc=0
  tar --create --gzip --file="$out" --directory="$STORAGE_DIR" . 2>"$RUN_DIR/storage.tar.err" || rc=$?
  if (( rc == 0 )); then
    ( cd "$RUN_DIR" && sha256sum "$(basename "$out")" >>SHA256SUMS )
    return 0
  elif (( rc == 1 )); then
    warn "tar avisó que algún archivo cambió mientras se leía (rc=1): el respaldo probablemente sirve,"
    warn "  pero conviene repetirlo en una ventana de baja actividad."
    ( cd "$RUN_DIR" && sha256sum "$(basename "$out")" >>SHA256SUMS )
    return 0
  fi
  err "falló el respaldo de $STORAGE_DIR (rc=$rc):"
  sed 's/^/       /' "$RUN_DIR/storage.tar.err" >&2 || true
  return 4
}

# -----------------------------------------------------------------------------
# Retención
# -----------------------------------------------------------------------------
apply_retention() {
  (( RETENTION_DAYS > 0 )) || { log "retención desactivada (--retention 0)"; return 0; }
  [[ -d "$BACKUP_DIR" ]] || return 0

  local cutoff; cutoff="$(date -d "${RETENTION_DAYS} days ago" +%s)"
  local removed=0 kept=0 d d_epoch rc=0
  local entry

  while IFS= read -r entry; do
    d="$(basename "$entry")"
    # Solo directorios cuyo nombre sea exactamente AAAA-MM-DD (nunca otra cosa).
    [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    d_epoch="$(date -d "$d" +%s 2>/dev/null || echo "$cutoff")"
    if (( d_epoch < cutoff )); then
      if (( DRY_RUN )); then
        printf '       %s[dry-run]$ rm -rf %s%s\n' "$C_DIM" "$entry" "$C_RESET"
        removed=$((removed + 1))
      else
        if rm -rf -- "$entry"; then
          log "retención: eliminado $entry"
          removed=$((removed + 1))
        else
          err "retención: no se pudo eliminar $entry"
          rc=5
        fi
      fi
    else
      kept=$((kept + 1))
    fi
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

  log "retención: ${removed} directorio(s) $([[ $DRY_RUN == 1 ]] && echo 'a eliminar' || echo 'eliminado(s)'), ${kept} conservado(s) (límite ${RETENTION_DAYS} días)"
  return "$rc"
}

# -----------------------------------------------------------------------------
# Programa principal
# -----------------------------------------------------------------------------
main() {
  parse_args "$@"
  load_config

  # Revalidar después de cargar la configuración (backup.env puede cambiarla).
  if (( ${#DB_LIST[@]} == 0 )); then
    read -r -a DB_LIST <<<"$DATABASES"
  fi

  mkdir -p "$BACKUP_DIR" || die "no se pudo crear el directorio destino $BACKUP_DIR" 1
  chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

  # Candado: si ya hay un respaldo en curso, no se solapa.
  local lock="$BACKUP_DIR/.odontocrm-backup.lock"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock"
    if ! flock -n 9; then
      warn "ya hay otra ejecución de ${SCRIPT_NAME} en curso; se omite esta corrida"
      exit 0
    fi
  fi

  RUN_DATE="$(date +%Y-%m-%d)"
  STAMP="$(date +%Y-%m-%d_%H%M%S)"
  RUN_DIR="$BACKUP_DIR/$RUN_DATE"
  RUN_HOST="$(hostname -f 2>/dev/null || hostname)"

  log "═══════════════════════════════════════════════════════════════════"
  log "${SCRIPT_NAME} v${SCRIPT_VERSION} — inicio (pid $$, host $RUN_HOST)"
  log "destino: $RUN_DIR · bases: ${#DB_LIST[@]} · retención: ${RETENTION_DAYS} días"

  preflight
  if (( DRY_RUN )); then
    printf '       %s[dry-run]$ install -d -m 0700 %s%s\n' "$C_DIM" "$RUN_DIR" "$C_RESET"
  else
    install -d -m 0700 "$RUN_DIR" || die "no se pudo crear el directorio de respaldo $RUN_DIR" 1
    [[ -w "$RUN_DIR" ]] || die "el directorio $RUN_DIR no es escribible" 1
  fi

  local rc=0 sub=0
  dump_databases "${DB_LIST[@]}" && rc=0 || rc=$?
  if (( INCLUDE_CONFIG )); then
    copy_config && sub=0 || sub=$?
    if (( sub > rc )); then rc=$sub; fi
  fi
  if (( INCLUDE_STORAGE )); then
    copy_storage && sub=0 || sub=$?
    if (( sub > rc )); then rc=$sub; fi
  fi

  # manifest.txt: metadatos para auditoría y para la restauración.
  if (( ! DRY_RUN )) && [[ -d "$RUN_DIR" ]]; then
    {
      printf 'OdontoCRM · respaldo\n'
      printf 'fecha_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      printf 'host=%s\n' "$RUN_HOST"
      printf 'script=%s v%s\n' "$SCRIPT_NAME" "$SCRIPT_VERSION"
      printf 'pg_dump=%s\n' "$("$(pg_bin pg_dump)" --version)"
      printf 'postgres_host=%s\n' "$PG_HOST"
      printf 'postgres_user=%s\n' "$PG_USER"
      printf 'bases=%s\n' "${DB_LIST[*]}"
      printf 'include_config=%s\n' "$INCLUDE_CONFIG"
      printf 'include_storage=%s\n' "$INCLUDE_STORAGE"
      printf 'retencion_dias=%s\n' "$RETENTION_DAYS"
      printf 'resultado_codigo=%s\n' "$rc"
      printf '\narchivos:\n'
      find "$RUN_DIR" -maxdepth 1 -type f -printf '  %f  %s bytes  %TY-%Tm-%Td %TH:%TM\n' | sort
    } >"$RUN_DIR/manifest.txt"
    log "manifiesto escrito en $RUN_DIR/manifest.txt"

    # Verificación global de sumas (si el usuario quiere comprobarlas luego).
    if [[ -f "$RUN_DIR/SHA256SUMS" ]]; then
      if ( cd "$RUN_DIR" && sha256sum --check --status SHA256SUMS ); then
        log "verificación SHA-256 correcta"
      else
        warn "la verificación SHA-256 reportó diferencias"
        if (( rc == 0 )); then rc=3; fi
      fi
    fi
  fi

  local rrc=0
  apply_retention && rrc=0 || rrc=$?
  if (( rrc > rc )); then rc=$rrc; fi

  if (( rc == 0 )); then
    ok "respaldo completado sin errores"
  else
    err "respaldo terminado con errores (código $rc) — revise $LOG_FILE"
  fi
  log "fin (código $rc)"
  exit "$rc"
}

main "$@"
