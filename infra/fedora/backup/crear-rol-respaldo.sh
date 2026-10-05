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
# `--sin-admin` deja el .pgpass solo con el rol de respaldo.

[[ $EUID -eq 0 ]] || morir 'hay que ejecutarlo como root (sudo)'

ADMIN_URL="${ADMIN_URL:-postgres:///postgres?host=/var/run/postgresql}"
ETC_DIR="/etc/odontocrm"
backup_env="$ETC_DIR/backup.env"
pgpass="$ETC_DIR/.pgpass"
rol="odonto_backup"
password=""
rotar=0
bypassrls=0
admin_role="${SUDO_USER:-}"   # rol con permiso para DROP/CREATE (restauración)
bases=(odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting)

for arg in "$@"; do
  case "$arg" in
    --password=*) password="${arg#*=}" ;;
    --rotar) rotar=1 ;;
    --bypassrls) bypassrls=1 ;;
    --admin-role=*) admin_role="${arg#*=}" ;;
    --sin-admin) admin_role="" ;;
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
#
# **Nada de `NOINHERIT` en este rol.** Medido en la Fase 10: `CREATE ROLE ... NOINHERIT`
# hace que PostgreSQL registre la pertenencia a `pg_read_all_data` con
# `inherit_option = false` (PG 16+), así que el rol **no recibe** ninguno de esos
# permisos y `pg_dump` muere con «permiso denegado a la tabla __drizzle_migrations».
# No es un aviso teórico: el respaldo falló dos veces por esto. El rol sigue siendo de
# mínimo privilegio (sin superusuario, sin crear bases ni roles) y aquí abajo se le da
# además lectura explícita tabla por tabla, que funciona en cualquier versión.
if [[ "$existe" == "1" ]]; then
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "alter role $rol with login inherit password '$password'" >/dev/null ||
    morir "no pude actualizar el rol $rol"
  ok "rol $rol actualizado (sin superusuario, con herencia activada)"
else
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "create role $rol login password '$password' nosuperuser nocreatedb nocreaterole" >/dev/null ||
    morir "no pude crear el rol $rol"
  ok "rol $rol creado (sin superusuario; la herencia queda activada a propósito)"
fi

# La pertenencia, con herencia explícita: en PG 16+ el permiso de la pertenencia manda.
if psql "$ADMIN_URL" -q -c "grant pg_read_all_data to $rol with inherit true" >/dev/null 2>&1; then
  ok 'pertenencia a pg_read_all_data concedida con herencia (PG 16+)'
else
  psql "$ADMIN_URL" -q -c "grant pg_read_all_data to $rol" >/dev/null ||
    av 'no pude conceder pg_read_all_data (seguirá con los permisos explícitos)'
  av 'servidor anterior a PG 16: la pertenencia va sin opción de herencia; los permisos explícitos son los que valen'
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
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, '$rol');
    -- Lectura explícita: no depende de la herencia ni de pg_read_all_data, y es lo
    -- que hace que pg_dump pueda bloquear las tablas (incluidas drizzle y pgboss).
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', s, '$rol');
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, '$rol');
  END LOOP;
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

# ── 3-bis. Credencial de administración (solo para RESTAURAR) ────────────────
#
# DROP/CREATE DATABASE necesita un rol administrador. El respaldo no lo usa, pero la
# restauración sí, y sin él el script se quedaba esperando la contraseña (ya no:
# ahora falla y lo dice). Se le pone contraseña al rol del sistema que va a restaurar
# y se añade su línea al .pgpass.
if [[ -n "$admin_role" ]]; then
  es_super="$(psql "$ADMIN_URL" -tAc "select coalesce((select rolsuper from pg_roles where rolname='$admin_role')::text, 'no-existe')" | tr -d ' ')"
  case "$es_super" in
    true)
      admin_pass="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
      if psql "$ADMIN_URL" -q -c "alter role $admin_role password '$admin_pass'" >/dev/null 2>&1; then
        printf '127.0.0.1:5432:*:%s:%s\n' "$admin_role" "$admin_pass" >>"$pgpass"
        ok "credencial de administración añadida a .pgpass para el rol $admin_role (solo la usa la restauración)"
      else
        av "no pude poner contraseña al rol $admin_role: la restauración pedirá credenciales a mano"
      fi
      ;;
    no-existe) av "el rol $admin_role no existe: la restauración necesitará --admin-user" ;;
    *) av "el rol $admin_role no es superusuario: la restauración puede fallar al crear bases" ;;
  esac
  if grep -qE '^PG_ADMIN_USER=' "$backup_env"; then
    sed -i "s|^PG_ADMIN_USER=.*|PG_ADMIN_USER=${admin_role}|" "$backup_env"
  else
    printf 'PG_ADMIN_USER=%s\n' "$admin_role" >>"$backup_env"
  fi
fi

# ── 4. Comprobación: que el rol pueda leer de verdad ─────────────────────────
fallos=0
for base in "${bases[@]}"; do
  psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname='$base'" | grep -q 1 || continue
  # No basta con `public`: se lee a propósito el esquema de migraciones, que es el
  # que rompía el respaldo, y se comprueba el USAGE de todos los esquemas.
  # Solo se prueban los esquemas que EXISTEN en esa base: `pgboss` lo crea quien
  # consume la cola, así que en patients y clinical no está y preguntar por él daba
  # un falso «no puede leer» (visto en el ensayo).
  esquemas="$(PGPASSFILE="$pgpass" psql -h 127.0.0.1 -p 5432 -U "$rol" -d "$base" -tAc \
    "select coalesce(string_agg(nspname, ' '), '') from pg_namespace
      where nspname in ('drizzle', 'pgboss')" 2>/dev/null)"
  if [[ "$esquemas" == *drizzle* ]] &&
     ! PGPASSFILE="$pgpass" psql -h 127.0.0.1 -p 5432 -U "$rol" -d "$base" -tAc \
       "select count(*) from drizzle.__drizzle_migrations" >/dev/null 2>&1; then
    av "el rol no puede leer drizzle.__drizzle_migrations en $base (¿rol NOINHERIT?)"
    fallos=$((fallos+1)); continue
  fi
  if [[ "$esquemas" == *pgboss* ]] &&
     ! PGPASSFILE="$pgpass" psql -h 127.0.0.1 -p 5432 -U "$rol" -d "$base" -tAc \
       "select count(*) from pgboss.job" >/dev/null 2>&1; then
    av "el rol no puede leer pgboss.job en $base"; fallos=$((fallos+1)); continue
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
