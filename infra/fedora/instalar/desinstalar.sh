#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · DESINSTALAR el servidor de esta máquina
#
#   sudo bash infra/fedora/instalar/desinstalar.sh --si
#   sudo bash infra/fedora/instalar/desinstalar.sh --si --conservar-datos
#   sudo bash infra/fedora/instalar/desinstalar.sh --si --con-usuario
#
# Deja la máquina como si el instalador no hubiera pasado: unidades de systemd,
# código, secretos, bases, roles, proxy, certificado, reglas de firewall y
# contextos de SELinux. Existe porque la alternativa —«bórralo a mano»— se olvida
# siempre de algo (una unidad que sigue arrancando, un rol de PostgreSQL que
# estorba en la instalación siguiente, un contexto de SELinux que se queda).
#
# **Es destructivo y por eso exige `--si`.** Sin esa bandera NO hace nada: enseña
# lo que borraría y sale con código 10. Antes de tocar nada:
#
#   1. guarda /etc/odontocrm (los secretos) en /root/odontocrm-antes-de-desinstalar-…
#   2. vuelca las bases con pg_dump en ese mismo directorio (0600, solo root)
#
# Si un volcado falla, se **reintenta como administrador** (el rol del servicio no
# siempre puede leer toda la base) y, si tampoco así sale, **esa base NO se borra** y se
# dice por qué: el error de `pg_dump` se guarda en `<base>.error` y se enseña. Las demás
# se borran igual. La copia es la única red que hay si alguien desinstala una instalación
# con pacientes dentro.
#
# **Sal antes de lanzarlo si tu terminal está dentro de `/opt/odontocrm` o de
# `/etc/odontocrm`**: borrar el directorio donde vive la terminal la deja rota
# («getcwd: no se puede acceder a los directorios padre») y todo lo que se ejecute
# después falla de formas raras —el `git clone` de la instalación siguiente incluido—.
# El guion lo comprueba y se niega a seguir (código 11) en vez de dejarte así.
#
# Con `--conservar-datos` NO se borran /var/lib/odontocrm (adjuntos), /var/log ni
# /var/backups: solo se quita lo que impide reinstalar.
#
# Lo que este guion NO toca, a propósito:
#   · los paquetes de dnf (PostgreSQL, nginx, Node…): puede haber otros usos
#   · la base, los roles y el usuario de «postgres»
#   · el nombre de la máquina y el DNS/mDNS que publicó `nombre/instalar-dns.sh`
#     salvo el archivo de dnsmasq, que sí es nuestro
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

SI=0
CONSERVAR_DATOS=0
CON_USUARIO=0
ADMIN_URL=""
for arg in "$@"; do
  case "$arg" in
    --si) SI=1 ;;
    --conservar-datos) CONSERVAR_DATOS=1 ;;
    --con-usuario) CON_USUARIO=1 ;;
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"
export DRY_RUN

# Qué se va a quitar y qué se conserva. Se enseña SIEMPRE (también con `--si`):
# quien reinstala tiene que ver que sus adjuntos y sus respaldos siguen ahí.
UNIDADES=()
for s in "${SERVICIOS[@]}"; do UNIDADES+=("odontocrm@$s.service"); done
# La PLANTILLA de la unidad (`odontocrm@.service`) y los dos del simulacro de restauración
# no son instancias: `systemctl disable odontocrm@identity` no las toca y antes se quedaban
# en /etc/systemd/system. El temporizador de verificación seguía ENABLED y con su aviso
# semanal después de «desinstalar» (trampa del 2026-11-11; el hermano de Windows ya la
# tenía resuelta desde el 2026-10-14 con la cuarta tarea programada).
UNIDADES+=(odontocrm@.service)
UNIDADES+=(odontocrm-gateway.service odontocrm-admin-bot.service odontocrm-alertas.service odontocrm-alertas.timer)
UNIDADES+=(odontocrm-red.service odontocrm-red.timer)
UNIDADES+=(odontocrm-backup.service odontocrm-backup.timer)
UNIDADES+=(odontocrm-verificar-respaldo.service odontocrm-verificar-respaldo.timer)
RUTAS_FIJAS=("$CODE_DIR" "$ETC_DIR" /usr/local/bin/odontocrm /etc/logrotate.d/odontocrm)
RUTAS_FIJAS+=(/etc/nginx/conf.d/odontocrm.conf /etc/dnsmasq.d/odontocrm.conf)
RUTAS_FIJAS+=(/etc/pki/tls/certs/odontocrm.crt /etc/pki/tls/private/odontocrm.key)
RUTAS_DATOS=("$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR")

if (( ! SI )); then
  printf '%sOdontoCRM · desinstalar (ENSAYO: no se borra nada)%s\n\n' "$C_TI" "$C_RE"
  detalle 'esto es lo que borraría con --si:'
  echo
  printf '  %sUnidades de systemd%s\n' "$C_TI" "$C_RE"
  for u in "${UNIDADES[@]}"; do printf '      %s\n' "$u"; done
  printf '\n  %sCódigo, secretos y proxy%s\n' "$C_TI" "$C_RE"
  for r in "${RUTAS_FIJAS[@]}"; do printf '      %s\n' "$r"; done
  printf '\n  %sBases y roles de PostgreSQL%s (los que digan los .env de %s, o del respaldo\n' "$C_TI" "$C_RE" "$ETC_DIR"
  printf '  anterior si una corrida a medias ya borró ese directorio)\n'
  printf '\n  %sDatos%s (se conservan con --conservar-datos)\n' "$C_TI" "$C_RE"
  for r in "${RUTAS_DATOS[@]}"; do printf '      %s\n' "$r"; done
  echo
  printf '  %sAntes de borrar%s: copia de %s y un pg_dump de cada base a\n' "$C_TI" "$C_RE" "$ETC_DIR"
  printf '      /root/odontocrm-antes-de-desinstalar-<fecha>/   (0600, solo root)\n\n'
  printf '  Para hacerlo de verdad:\n      sudo bash %s --si\n\n' "$0"
  printf '  %sNo se tocan%s los paquetes de dnf, ni PostgreSQL, ni el usuario «postgres».\n' "$C_TI" "$C_RE"
  exit 10
fi

# ── ¿La terminal está PARADA dentro de algo que se va a borrar? ─────────────
# Borrar el directorio de trabajo deja el intérprete roto: a partir de ahí cada orden
# imprime «getcwd: no se puede acceder a los directorios padre» y **todo lo que se
# ejecute después falla de formas raras** — `git clone` muere con «esta operación debe
# ser realizada en un árbol de trabajo» y la instalación siguiente se cae en el paso
# 3/4 sin que se vea por qué—. Pasó de verdad: se desinstaló /opt/odontocrm desde una
# terminal parada ahí mismo. Se comprueba ANTES de tocar nada (y antes que el sudo: no
# depende de permisos) y se pide salir.
for r in "${RUTAS_FIJAS[@]}" "${RUTAS_DATOS[@]}"; do
  case "$PWD/" in
    "$r"/*)
      if (( DRY_RUN )); then
        av "tu terminal está dentro de $r: cuando lo hagas de verdad, sal antes con «cd ~»"
      else
        err "tu terminal está dentro de $r, que es una de las rutas que se borran"
        detalle 'sal de ahí antes de seguir:   cd ~   (y repite el comando)'
        detalle 'si no, el intérprete se queda sin directorio y lo siguiente falla sin motivo aparente'
        exit 11
      fi
      ;;
  esac
done

# `--dry-run` no toca nada: se puede revisar, sin sudo, lo que haría.
(( DRY_RUN )) || exigir_root
(( DRY_RUN )) && av '--dry-run: se enseña lo que se haría, sin hacerlo'
# El guion, en todo caso, no depende del directorio actual.
cd / 2>/dev/null || true

FECHA="$(date +%Y%m%d-%H%M%S)"
RESPALDO="/root/odontocrm-antes-de-desinstalar-$FECHA"

# Borra una ruta y lo cuenta como es debido: en `--dry-run` no se borra nada, así que
# decir «borrado» sería mentir (y el ensayo existe justo para saber qué pasaría).
quitar() { # $1 = ruta · $2 = cómo llamarlo en el mensaje
  [[ -e "$1" ]] || return 0
  ejecutar rm -rf "$1"
  if (( DRY_RUN )); then detalle "se borraría $2"; else ok "borrado $2"; fi
}

# ── Las bases y los roles, según los propios .env (no se adivinan nombres) ───
# El usuario de la URL ES el rol, y la base va al final: así vale también para una
# clínica que haya renombrado sus bases.
#
# Si una corrida anterior YA borró /etc/odontocrm (este guion lo hace en el paso 4) y se
# quedó a medias, las credenciales siguen en el respaldo que esa corrida dejó: se usan
# esas. Antes, un reintento decía «no pude leer ninguna DATABASE_URL» y las bases se
# quedaban ahí sin que el guion pudiera ni verlas.
DIR_ENV_BASES="$ETC_DIR"
if [[ ! -d "$DIR_ENV_BASES" ]]; then
  anterior="$(ls -1d /root/odontocrm-antes-de-desinstalar-*/etc-odontocrm 2>/dev/null | sort -r | head -n 1 || true)"
  if [[ -n "$anterior" ]]; then
    DIR_ENV_BASES="$anterior"
    av "no hay $ETC_DIR; uso las credenciales que guardó la corrida anterior: $DIR_ENV_BASES"
  fi
fi

bases=()
roles=()
anotar() { # $1 = url
  local url="$1" resto rol base
  [[ "$url" == postgres://* ]] || return 0
  resto="${url#postgres://}"; rol="${resto%%:*}"; resto="${resto#*:}"
  base="${url##*/}"
  [[ -n "$base" ]] || return 0
  for b in "${bases[@]}"; do [[ "$b" == "$base" ]] && return 0; done
  bases+=("$base"); roles+=("${rol:-postgres}")
}
for s in "${SERVICIOS[@]}"; do
  anotar "$(leer_clave_entorno "$DIR_ENV_BASES/$s.env" DATABASE_URL)"
  anotar "$(leer_clave_entorno "$DIR_ENV_BASES/$s.env" EVENTS_DATABASE_URL)"
done
[[ ${#bases[@]} -gt 0 ]] || av "no pude leer ninguna DATABASE_URL de $DIR_ENV_BASES (¿ya estaba desinstalado?)"

# La URL con la que se conecta una base: la del servicio que la usa, o la de la cola de
# eventos (que comparten los ocho). Se devuelve ENTERA: es la misma cadena que el servicio
# usa para conectar, así que `pg_dump` la acepta tal cual.
url_de_base() { # $1 = base de datos
  local s url
  for s in "${SERVICIOS[@]}"; do
    for url in "$(leer_clave_entorno "$DIR_ENV_BASES/$s.env" DATABASE_URL)" \
      "$(leer_clave_entorno "$DIR_ENV_BASES/$s.env" EVENTS_DATABASE_URL)"; do
      if [[ -n "$url" && "${url##*/}" == "$1" ]]; then
        printf '%s' "$url"
        return 0
      fi
    done
  done
  return 1
}

# Ruta ABSOLUTA de las herramientas: `runuser` puede no heredar el PATH con el que se
# ejecutó el guion (los binarios de PostgreSQL del repositorio PGDG viven en
# /usr/pgsql-18/bin, no en /usr/bin), y el segundo intento del volcado tiene que
# encontrarlas igual que el primero.
PG_DUMP="$(command -v pg_dump 2>/dev/null || true)"
RUNUSER="$(command -v runuser 2>/dev/null || true)"

# URL del administrador apuntando a una base concreta. `--admin-url` apunta a la base
# «postgres»; se cambia solo el último segmento de la ruta y se conservan los parámetros
# (por ejemplo la forma con socket: `postgres://usuario@/postgres?host=/var/run/postgresql`).
url_admin_de_base() { # $1 = base de datos
  local base="$1" sin_consulta consulta=""
  if [[ "$ADMIN_URL" == *\?* ]]; then
    sin_consulta="${ADMIN_URL%%\?*}"
    consulta="?${ADMIN_URL#*\?}"
  else
    sin_consulta="$ADMIN_URL"
  fi
  printf '%s/%s%s' "${sin_consulta%/*}" "$base" "$consulta"
}

# Segundo intento del volcado, ya como administrador. Hace falta cuando dentro de una base
# hay objetos de otro dueño (por ejemplo un esquema `pgboss` que dejó una corrida de
# desarrollo): el rol del servicio no puede ni leerlos y `pg_dump` falla aunque los datos
# estén intactos. Aquí ya somos root y el paso 5 necesita el administrador de todos modos,
# así que no hay ninguna credencial nueva que pedir.
volcar_como_admin() { # $1 = base de datos · escribe el volcado por la salida estándar
  local base="$1"
  if [[ -n "${ADMIN_URL:-}" ]]; then
    "$PG_DUMP" "$(url_admin_de_base "$base")"
  elif [[ -n "$RUNUSER" ]]; then
    "$RUNUSER" -u postgres -- "$PG_DUMP" --no-password -d "$base"
  else
    return 1
  fi
}

# Bases cuya copia de seguridad no se pudo hacer. Solo esas se conservan: antes un único
# fallo (un objeto ajeno dentro de una base) bloqueaba también las nueve que SÍ se habían
# volcado, y el resumen decía que «no se borraron» todas.
sin_respaldo=()
base_sin_respaldo() { # $1 = base de datos
  local b
  for b in "${sin_respaldo[@]}"; do [[ "$b" == "$1" ]] && return 0; done
  return 1
}

# ── 1. Copia de seguridad de los secretos y de los datos ────────────────────
paso '1/6 · Copia antes de borrar'
# El directorio del respaldo se crea SIEMPRE: si /etc/odontocrm ya no está (reintento de
# una corrida a medias) pero las bases se conocen por el respaldo anterior, los volcados
# y sus .error tienen que poder escribirse igual.
ejecutar install -d -m 0700 "$RESPALDO"
if [[ -d "$ETC_DIR" ]]; then
  ejecutar cp -a "$ETC_DIR" "$RESPALDO/etc-odontocrm"
  if (( DRY_RUN )); then detalle "se copiaría $ETC_DIR → $RESPALDO/etc-odontocrm"
  else ok "secretos → $RESPALDO/etc-odontocrm (0600)"; fi
else
  av "no hay $ETC_DIR: nada que copiar"
fi
if [[ ${#bases[@]} -eq 0 ]]; then
  av 'sin bases que volcar'
elif [[ -z "$PG_DUMP" ]] && (( ! DRY_RUN )); then
  # Sin copia no se borra nada: es la única red que hay si alguien desinstala una
  # instalación con pacientes dentro. (Antes se seguía adelante y se borraban igual.)
  av 'no encuentro pg_dump: NO se borrará ninguna base (no habría copia)'
  sin_respaldo=("${bases[@]}")
else
  for i in "${!bases[@]}"; do
    base="${bases[$i]}"
    # Se vuelca con la URL COMPLETA que usa ese servicio, no con las piezas que uno
    # reconstruye a mano: es la misma cadena que el servicio usa para conectar (o sea,
    # está comprobado que funciona) y no hay forma de equivocarse al partirla. Antes se
    # partía a mano y cualquier fallo —de análisis o de conexión— se perdía en un
    # `2>/dev/null`: nueve «no pude volcar» sin decir por qué.
    url="$(url_de_base "$base" || true)"
    if (( DRY_RUN )); then
      detalle "[dry-run] pg_dump $base → $RESPALDO/$base.sql"
      continue
    fi
    destino="$RESPALDO/$base.sql"
    error="$RESPALDO/$base.error"
    : >"$error"
    if [[ -n "$url" ]]; then
      if "$PG_DUMP" "$url" >"$destino" 2>"$error"; then
        chmod 0600 "$destino"
        rm -f "$error"
        ok "datos → $destino"
        continue
      fi
    else
      printf 'no encontré la credencial de %s en %s\n' "$base" "$DIR_ENV_BASES" >>"$error"
    fi
    # El rol del servicio puede no leer TODA la base (un esquema heredado de una corrida
    # de desarrollo con otro dueño, por ejemplo): se reintenta como administrador, que es
    # lo que el paso 5 necesita de todos modos. Solo si los dos intentos fallan esa base
    # concreta se conserva; las demás se borran igual.
    printf '\n--- reintento como administrador ---\n' >>"$error"
    if volcar_como_admin "$base" >"$destino" 2>>"$error"; then
      chmod 0600 "$destino"
      rm -f "$error"
      ok "datos → $destino (con el administrador)"
    else
      # Un `.sql` a medias engaña (parece una copia y no lo es): se quita.
      rm -f "$destino"
      chmod 0600 "$error" 2>/dev/null || true
      av "no pude volcar $base (esa base NO se borrará):"
      sed -n '1,3p' "$error" 2>/dev/null | sed 's/^/        /'
      detalle "el detalle completo está en $error"
      sin_respaldo+=("$base")
    fi
  done
fi
if (( ${#sin_respaldo[@]} > 0 )) && (( ! DRY_RUN )); then
  err "no pude copiar ${#sin_respaldo[@]} base(s): solo esas no se borrarán"
  detalle "las demás siguen adelante; mira los .error de $RESPALDO y repite para terminar de limpiar"
fi

# ── 2. Los servicios de systemd ─────────────────────────────────────────────
paso '2/6 · Parar y deshabilitar los servicios'
ejecutar systemctl stop odontocrm-gateway.service 2>/dev/null || true
for u in "${UNIDADES[@]}"; do
  systemctl is-enabled --quiet "$u" 2>/dev/null && ejecutar systemctl disable "$u" >/dev/null 2>&1 || true
  systemctl is-active --quiet "$u" 2>/dev/null && ejecutar systemctl stop "$u" >/dev/null 2>&1 || true
done
for u in "${UNIDADES[@]}"; do
  archivo="/etc/systemd/system/$u"
  [[ -e "$archivo" ]] || continue
  ejecutar rm -f "$archivo"
  if (( DRY_RUN )); then detalle "se quitaría $u"; else ok "quitada $u"; fi
done
ejecutar systemctl daemon-reload || av 'systemctl daemon-reload falló'
ejecutar systemctl reset-failed >/dev/null 2>&1 || true

# ── 3. nginx: solo nuestro sitio ────────────────────────────────────────────
paso '3/6 · El sitio del proxy'
if [[ -f /etc/nginx/conf.d/odontocrm.conf ]]; then
  ejecutar rm -f /etc/nginx/conf.d/odontocrm.conf
  if (( DRY_RUN )); then
    detalle 'se quitaría /etc/nginx/conf.d/odontocrm.conf'
  elif command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then
    ejecutar systemctl reload nginx >/dev/null 2>&1 || true
    ok 'sitio quitado de nginx (nginx sigue corriendo para lo que hubiera)'
  else
    av 'nginx no valida la configuración: revisa /etc/nginx antes de recargarlo'
  fi
else
  detalle 'no había sitio de OdontoCRM en nginx'
fi
if [[ -f /etc/dnsmasq.d/odontocrm.conf ]]; then
  ejecutar rm -f /etc/dnsmasq.d/odontocrm.conf
  ejecutar systemctl restart dnsmasq >/dev/null 2>&1 || true
  (( DRY_RUN )) && detalle 'se quitaría la zona de DNS propia' || ok 'zona de DNS propia quitada'
fi

# ── 4. Código, secretos y ayudas del sistema ────────────────────────────────
paso '4/6 · Código, secretos y certificado'
for r in "${RUTAS_FIJAS[@]}"; do quitar "$r" "$r"; done

# ── 5. Bases y roles ────────────────────────────────────────────────────────
paso '5/6 · Bases y roles de PostgreSQL'
if [[ ${#bases[@]} -gt 0 ]]; then
  # Como administrador: por el socket con el usuario «postgres» (lo que hace el
  # instalador) o con --admin-url si el servidor no deja usar peer.
  if [[ -n "$ADMIN_URL" ]]; then
    psql_admin=(psql -X -q -w -v ON_ERROR_STOP=1 "$ADMIN_URL")
  else
    psql_admin=(runuser -u postgres -- psql -X -q -w -v ON_ERROR_STOP=1)
  fi
  for i in "${!bases[@]}"; do
    base="${bases[$i]}"; rol="${roles[$i]}"
    if (( DRY_RUN )); then
      detalle "[dry-run] DROP DATABASE IF EXISTS \"$base\" WITH (FORCE); DROP ROLE IF EXISTS \"$rol\";"
      continue
    fi
    if base_sin_respaldo "$base"; then
      av "no borro la base $base: su copia de seguridad falló (mira $RESPALDO)"
      continue
    fi
    # La salida NO se tira: si algo falla, el motivo (permisos, una conexión abierta, el
    # usuario de administración equivocado…) es justo lo que hay que ver.
    if salida="$("${psql_admin[@]}" -c "DROP DATABASE IF EXISTS \"$base\" WITH (FORCE);" 2>&1)"; then
      ok "base $base borrada"
    else
      av "no pude borrar la base $base:"
      printf '%s\n' "$salida" | sed -n '1,3p' | sed 's/^/        /'
    fi
    # El rol solo se puede borrar cuando ya no es dueño de nada.
    if salida="$("${psql_admin[@]}" -c "DROP ROLE IF EXISTS \"$rol\";" 2>&1)"; then
      :
    else
      av "no pude borrar el rol $rol:"
      printf '%s\n' "$salida" | sed -n '1,3p' | sed 's/^/        /'
    fi
  done
else
  detalle 'no encontré bases que borrar'
fi

# ── 6. Datos, firewall, SELinux y usuario ───────────────────────────────────
paso '6/6 · Datos, firewall, SELinux y usuario'
if (( CONSERVAR_DATOS )); then
  for r in "${RUTAS_DATOS[@]}"; do
    [[ -e "$r" ]] && detalle "se conserva $r (--conservar-datos)"
  done
else
  for r in "${RUTAS_DATOS[@]}"; do quitar "$r" "$r"; done
fi

# Firewall: se retiran los servicios que abrió el despliegue y las reglas por rango.
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  iface="$(interfaz_lan)"
  zona="$(firewall-cmd --get-zone-of-interface="${iface:-public}" 2>/dev/null || echo public)"
  [[ -n "$zona" && "$zona" != "no" ]] || zona=public
  for servicio in https http; do
    firewall-cmd --permanent --zone="$zona" --remove-service="$servicio" >/dev/null 2>&1 || true
  done
  # Sonda con `|| true` a propósito: `grep` devuelve 1 cuando no encuentra nada —que es
  # una respuesta válida— y con `pipefail` eso disparaba el aviso de «se cortó».
  reglas="$(firewall-cmd --list-rich-rules 2>/dev/null | grep -E 'port="(80|443)"' || true)"
  while IFS= read -r regla; do
    [[ -n "$regla" ]] || continue
    ejecutar firewall-cmd --permanent --remove-rich-rule="$regla" >/dev/null 2>&1 || true
  done <<<"$reglas"
  (( DRY_RUN )) || firewall-cmd --reload >/dev/null 2>&1 || true
  (( DRY_RUN )) && detalle "se retirarían 80/443 de la zona «$zona»" ||
    ok "firewall: 80/443 retirados de la zona «$zona»"
else
  detalle 'firewalld no está activo: nada que retirar'
fi

# SELinux: se borran los contextos que apuntaban a nuestras rutas y se restaura.
if command -v semanage >/dev/null; then
  for r in "$CODE_DIR(/.*)?" "$DATA_DIR(/.*)?" "$LOG_DIR(/.*)?"; do
    ejecutar semanage fcontext -d "$r" >/dev/null 2>&1 || true
  done
  for r in "$CODE_DIR" "$DATA_DIR" "$LOG_DIR"; do
    [[ -e "$r" ]] || continue
    ejecutar restorecon -R "$r" >/dev/null 2>&1 || true
  done
  (( DRY_RUN )) && detalle 'se retirarían los contextos de SELinux' ||
    ok 'contextos de SELinux retirados'
else
  detalle 'sin semanage (SELinux no gestionado por política): nada que retirar'
fi

if (( CON_USUARIO )); then
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    ejecutar userdel "$SERVICE_USER" >/dev/null 2>&1 || av "no pude borrar el usuario $SERVICE_USER"
    (( DRY_RUN )) && detalle "se borraría el usuario $SERVICE_USER" || ok "usuario $SERVICE_USER borrado"
  fi
  getent group "$SERVICE_GROUP" >/dev/null 2>&1 &&
    { ejecutar groupdel "$SERVICE_GROUP" >/dev/null 2>&1 || true; }
else
  detalle "el usuario $SERVICE_USER se conserva (--con-usuario lo borra)"
fi

# ── Resumen ─────────────────────────────────────────────────────────────────
printf '\n%s══════════════════════════════════════════════════════════════════%s\n' "$C_TI" "$C_RE"
(( DRY_RUN )) && printf '%s  Ensayo terminado (NO se borró nada)%s\n' "$C_TI" "$C_RE" ||
  printf '%s  Desinstalación terminada%s\n' "$C_TI" "$C_RE"
printf '%s══════════════════════════════════════════════════════════════════%s\n\n' "$C_TI" "$C_RE"
[[ -d "$RESPALDO" ]] && printf '  Lo que había, guardado en:\n      %s\n\n' "$RESPALDO"
if (( ${#sin_respaldo[@]} > 0 )) && (( ! DRY_RUN )); then
  printf '  %sEstas bases NO se han borrado%s (su copia de seguridad falló): %s\n' \
    "$C_TI" "$C_RE" "${sin_respaldo[*]}"
  printf '  Mira los .error de %s, arréglalo y repite para terminar de limpiar.\n\n' "$RESPALDO"
fi
printf '  Para volver a instalarlo desde cero:\n'
printf '      sudo bash %s/instalar.sh\n\n' "$INSTALADOR_DIR"
printf '  No se han tocado los paquetes de dnf ni PostgreSQL, a propósito.\n\n'
