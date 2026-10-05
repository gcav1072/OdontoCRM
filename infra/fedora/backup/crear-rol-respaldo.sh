#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · crear el rol de respaldo y dejar lista la conexión
#
#   sudo bash infra/fedora/backup/crear-rol-respaldo.sh
#   sudo bash infra/fedora/backup/crear-rol-respaldo.sh --password='...'   # si la eliges tú
#   sudo bash infra/fedora/backup/crear-rol-respaldo.sh --rotar          # cambia la contraseña
#
# Deja el respaldo funcionando de una pasada, que es lo que la guía pedía a mano
# (INSTALL.md §15.2): rol dedicado `odonto_backup` —sin superusuario— con permiso de
# lectura sobre las 8 bases, `/etc/odontocrm/.pgpass` (0600) y `backup.env` apuntando
# a esa conexión.
#
# **No imprime la contraseña**: se genera aquí, se escribe en los archivos que
# corresponden y no sale por la terminal.
#
# Sobre `BYPASSRLS`: la Fase 10 comprobó que el esquema **no usa Row Level Security**
# (ninguna migración crea políticas), así que no hace falta. Se puede añadir con
# `--bypassrls` si algún día se activa RLS, y entonces el respaldo debe volver a
# probarse (§16).
# =============================================================================
set -uo pipefail

C_OK=$'\e[32m'; C_AV=$'\e[33m'; C_ER=$'\e[31m'; C_TI=$'\e[1m'; C_RE=$'\e[0m'
ok()   { printf '  %s✔%s %s\n' "$C_OK" "$C_RE" "$1"; }
av()   { printf '  %s!%s %s\n' "$C_AV" "$C_RE" "$1"; }
err()  { printf '  %s✖%s %s\n' "$C_ER" "$C_RE" "$1"; }
morir(){ err "$1"; exit 1; }

[[ $EUID -eq 0 ]] || morir 'hay que ejecutarlo como root (sudo)'

ADMIN_URL="${ADMIN_URL:-postgres:///postgres?host=/var/run/postgresql}"
ETC_DIR="/etc/odontocrm"
backup_env="$ETC_DIR/backup.env"
pgpass="$ETC_DIR/.pgpass"
rol="odonto_backup"
password=""
rotar=0
bypassrls=0
bases=(odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting)

for arg in "$@"; do
  case "$arg" in
    --password=*) password="${arg#*=}" ;;
    --rotar) rotar=1 ;;
    --bypassrls) bypassrls=1 ;;
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    *) morir "argumento no reconocido: $arg" ;;
  esac
done

printf '%sOdontoCRM · rol de respaldo%s\n' "$C_TI" "$C_RE"

command -v psql >/dev/null || morir 'falta el cliente psql'
psql "$ADMIN_URL" -tAc 'select 1' >/dev/null 2>&1 ||
  morir "no puedo entrar como administrador ($ADMIN_URL): crea tu rol superusuario (INSTALL.md §6.4)"

[[ -f "$backup_env" ]] || morir "falta $backup_env: ejecuta antes infra/fedora/install.sh --apply"

# ── Contraseña: la que te den o una nueva; nunca sale por pantalla ───────────
if [[ "$rotar" == "1" || -z "$password" ]]; then
  password="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
fi

existe="$(psql "$ADMIN_URL" -tAc "select 1 from pg_roles where rolname = '$rol'" | tr -d ' ')"
if [[ "$existe" == "1" && "$rotar" != "1" && -z "${1:-}" ]]; then
  # El rol ya está: se reutiliza la contraseña que haya en .pgpass para no dejarlo fuera.
  if [[ -r "$pgpass" ]] && grep -q "^127.0.0.1:5432:\*:$rol:" "$pgpass"; then
    av "el rol $rol ya existe: reutilizo su contraseña de $pgpass (usa --rotar para cambiarla)"
    password="$(grep "^127.0.0.1:5432:\*:$rol:" "$pgpass" | head -1 | awk -F: '{print $5}')"
  else
    av "el rol $rol ya existe y no hay .pgpass: se le pone una contraseña nueva"
  fi
fi

# ── 1. El rol ────────────────────────────────────────────────────────────────
if [[ "$existe" == "1" ]]; then
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "alter role $rol with login password '$password'" \
    -c "grant pg_read_all_data to $rol" >/dev/null || morir "no pude actualizar el rol $rol"
  ok "rol $rol actualizado (sin superusuario, con lectura de todas las tablas)"
else
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "create role $rol login password '$password' nosuperuser nocreatedb nocreaterole noinherit" \
    -c "grant pg_read_all_data to $rol" >/dev/null || morir "no pude crear el rol $rol"
  ok "rol $rol creado (sin superusuario, con lectura de todas las tablas)"
fi

if [[ "$bypassrls" == "1" ]]; then
  psql "$ADMIN_URL" -q -c "alter role $rol bypassrls" >/dev/null || morir 'no pude activar BYPASSRLS'
  ok 'BYPASSRLS activado (el esquema usa RLS: vuelve a probar el respaldo, §16)'
else
  av 'sin BYPASSRLS: el esquema no usa Row Level Security (comprobado en la Fase 10)'
fi

# ── 2. Permiso de conexión y de ESQUEMA en cada base ─────────────────────────
#
# OJO con los esquemas: `pg_read_all_data` da lectura de tablas y USAGE en `public`,
# pero **no** en los demás esquemas. Medido en la Fase 10: el respaldo moría con
# «permiso denegado al esquema drizzle» porque `pg_dump` bloquea
# `drizzle.__drizzle_migrations` (y en otra base, las tablas de `pgboss`). Por eso
# aquí se concede USAGE sobre TODOS los esquemas no internos de cada base, presentes
# y futuros.
SQL_ESQUEMAS="DO \$\$ DECLARE s text; BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  LOOP EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, '$rol'); END LOOP;
END \$\$;"

for base in "${bases[@]}"; do
  if psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname = '$base'" | grep -q 1; then
    psql "$ADMIN_URL" -q -c "grant connect on database $base to $rol" >/dev/null || av "no pude dar CONNECT en $base"
    # `psql <url>` con `-d` interpreta la URL como USUARIO: por eso la base va
    # dentro de la URL, no en un `-d` aparte.
    psql -d "postgres:///$base?host=/var/run/postgresql" -q -c "$SQL_ESQUEMAS" >/dev/null 2>&1 ||
      av "no pude dar USAGE sobre los esquemas de $base"
  fi
done
ok "CONNECT y USAGE en todos los esquemas de las bases existentes (${#bases[@]} previstas)"

# ── 3. .pgpass y backup.env ──────────────────────────────────────────────────
cp -n "$pgpass" "$pgpass.antes" 2>/dev/null || true
printf '# OdontoCRM · credenciales de respaldo (0600 root:root, no versionar)\n127.0.0.1:5432:*:%s:%s\n' "$rol" "$password" >"$pgpass"
chown root:root "$pgpass"; chmod 0600 "$pgpass"
ok "$pgpass escrito"

# backup.env: se ajustan solo las claves de conexión (se respeta el resto).
for par in "PG_HOST:127.0.0.1" "PG_PORT:5432" "PG_USER:$rol" "PGPASSFILE:$pgpass"; do
  clave="${par%%:*}"; valor="${par#*:}"
  if grep -qE "^${clave}=" "$backup_env"; then
    sed -i "s|^${clave}=.*|${clave}=${valor}|" "$backup_env"
  else
    printf '%s=%s\n' "$clave" "$valor" >>"$backup_env"
  fi
done
chown root:root "$backup_env"; chmod 0600 "$backup_env"
ok "backup.env apunta a $rol por TCP con .pgpass"

# ── 4. Comprobación: que el rol pueda leer de verdad ─────────────────────────
fallos=0
for base in "${bases[@]}"; do
  psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname='$base'" | grep -q 1 || continue
  # No basta con `public`: se lee a propósito el esquema de migraciones, que es el
  # que rompía el respaldo, y se comprueba el USAGE de todos los esquemas.
  if ! PGPASSFILE="$pgpass" psql -h 127.0.0.1 -p 5432 -U "$rol" -d "$base" -tAc \
       "select count(*) from drizzle.__drizzle_migrations" >/dev/null 2>&1; then
    av "el rol no puede leer el esquema drizzle de $base"; fallos=$((fallos+1)); continue
  fi
  sin_usage="$(PGPASSFILE="$pgpass" psql -h 127.0.0.1 -p 5432 -U "$rol" -d "$base" -tAc \
    "select string_agg(nspname, ', ') from pg_namespace
      where nspname not like 'pg\\_%' and nspname <> 'information_schema'
        and not has_schema_privilege(current_user, nspname, 'USAGE')" 2>/dev/null)"
  if [[ -n "$sin_usage" ]]; then
    av "sin USAGE en $base: $sin_usage"; fallos=$((fallos+1))
  fi
done
if (( fallos == 0 )); then ok 'el rol lee las 8 bases (incluido el esquema de migraciones)'
else err "$fallos base(s) con problemas: revisa los GRANT"; fi

printf '\n  Siguiente paso:  sudo bash infra/fedora/backup/odontocrm-backup.sh --include-config\n'
