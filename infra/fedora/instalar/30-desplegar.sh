#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · 3/4 · Desplegar el servidor
#
# Pone en marcha la aplicación SOBRE las credenciales que ya aprovisionó la pieza
# 2. Nada de lo que hace aquí escribe un secreto: el código desplegado en /opt no
# contiene ninguno, y las unidades de systemd los leen de /etc/odontocrm (ADR 0043).
#
#   1. Código en /opt/odontocrm (clon de git, sin .env ni claves)
#   2. Dependencias y compilación
#   3. Claves EdDSA de los JWT (si no existen; no se regeneran nunca solas)
#   4. Migraciones de las 8 bases
#   5. Usuarios iniciales (contraseña temporal, se imprime UNA vez)
#   6. Unidades de systemd y arranque de los servicios
#   7. Certificado TLS interno (mkcert) si no hay
#   8. Proxy inverso, SELinux y firewall: 80 y 443 para la LAN
#   9. Respaldos diarios (con --sin-respaldo se omiten)
#
#   sudo bash infra/fedora/instalar/30-desplegar.sh
#   sudo bash infra/fedora/instalar/30-desplegar.sh --con-dns --lan-cidr=192.168.1.0/24
#   sudo bash infra/fedora/instalar/30-desplegar.sh --sin-respaldo
#   sudo bash infra/fedora/instalar/30-desplegar.sh --dry-run
#
# Al terminar imprime la dirección por la que entran los aparatos de la consulta.
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS=""   # vacío = el que ya estuviera aprovisionado (ver comun.sh)
LAN_CIDR=""
ADMIN_URL=""
CON_DNS=0
SIN_RESPALDO=0
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --lan-cidr=*) LAN_CIDR="${arg#*=}" ;;
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    --con-dns) CON_DNS=1 ;;
    --sin-respaldo) SIN_RESPALDO=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"
export DRY_RUN

# `--dry-run` no toca nada, así que se puede ejecutar sin sudo: es la forma de
# revisar el plan completo en una máquina que todavía no es el servidor.
(( DRY_RUN )) || exigir_root

# Las credenciales TIENEN que estar: si esta pieza genera algo, es que se saltó un paso.
# Con `--dry-run` se avisa en vez de abortar: puede ser que el directorio exista y no se
# pueda leer (es 0750 root:odontocrm), y en un modo que no cambia nada eso no debe parar
# la previsualización.
if [[ ! -f "$ETC_DIR/odontocrm.env" ]]; then
  if (( DRY_RUN )); then
    av "no puedo leer $ETC_DIR/odontocrm.env (¿hace falta sudo?): sigo porque es --dry-run"
  else
    morir "no hay entorno aprovisionado en $ETC_DIR — ejecuta antes 20-aprovisionar.sh"
  fi
fi

NOMBRE_MDNS="$(resolver_nombre "$NOMBRE_MDNS")"
IP_LAN="$(ip_lan)"
[[ -n "$IP_LAN" ]] || IP_LAN="127.0.0.1"
USUARIO_REAL="$(usuario_real)"

# El nombre completo (con su dominio) se calcula UNA vez y se usa en todas partes:
# certificado, proxy, DNS y el resumen. Antes se componía a mano en cada sitio.
FQDN="$(nombre_fqdn "$NOMBRE_MDNS")"

printf '%sOdontoCRM · 3/4 · Desplegar%s\n' "$C_TI" "$C_RE"
detalle "código → $CODE_DIR      entorno → $ETC_DIR"
detalle "nombre → $FQDN   IP → $IP_LAN"

# ════════════════════════════════════════════════════════════════════════════
# 1. Código en /opt — un clon de git, y SIN secretos
# ════════════════════════════════════════════════════════════════════════════
paso '1/9 · Código en /opt/odontocrm'
#
# Se clona en vez de copiar a mano por dos razones: `git clone` **nunca** trae los
# archivos ignorados (`.env`, `.keys`, `node_modules`), que es justo donde viven los
# secretos; y `odontocrm actualizar` necesita que /opt sea un clon para poder traer
# versiones nuevas.
#
# El clon es --local (del repositorio de trabajo): no hace falta ni red ni
# credenciales de GitHub para instalar. Después se apunta `origin` al remoto de
# verdad, para que las actualizaciones futuras sí vengan de ahí.
git config --global --add safe.directory "$ORIGEN" 2>/dev/null || true
REMOTO="$(git -C "$ORIGEN" remote get-url origin 2>/dev/null || true)"
RAMA="$(git -C "$ORIGEN" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
COMMIT="$(git -C "$ORIGEN" rev-parse --short HEAD 2>/dev/null || echo '?')"

if [[ -n "$(git -C "$ORIGEN" status --porcelain 2>/dev/null | head -1)" ]]; then
  av "el repositorio de trabajo tiene cambios sin confirmar: se despliega el commit $COMMIT"
  detalle 'lo que no esté confirmado NO llega al servidor (confírmalo si tiene que llegar)'
fi

# ¿Ya estamos SOBRE el código desplegado? Es lo que pasa al ejecutar esto desde
# /opt/odontocrm (que es como lo hace `odontocrm actualizar`, tras traer la versión
# nueva): clonar ahí sería clonarse a sí mismo. Se comprueba ANTES que el --dry-run,
# porque si no el mensaje del modo de prueba anunciaba un clon imposible y tapaba la
# guarda (visto probándolo desde el propio directorio desplegado).
EN_SU_SITIO=0
[[ "$(cd "$ORIGEN" && pwd)" == "$(cd "$CODE_DIR" 2>/dev/null && pwd)" ]] && EN_SU_SITIO=1

# `safe.directory`: el instalador corre como root y el clon es del operador. Sin esto,
# git (>= 2.35.2) se niega a trabajar sobre él («dubious ownership») y el clon
# fallaría —o, peor, seguiría sin `origin`— en la instalación normal, que es
# `sudo bash instalar.sh` desde el clon del usuario.
git config --global --add safe.directory "$ORIGEN" 2>/dev/null || true

# Clona en un directorio TEMPORAL y lo mueve a su sitio al terminar.
#
# Las dos razones vienen de fallos reales:
#
# 1. `--no-hardlinks`. Sin él, `git clone --local` **enlaza** los objetos en vez de
#    copiarlos, y eso falla con «Enlace cruzado entre dispositivos no permitido»
#    (EXDEV) en cuanto el origen y el destino están en subvolúmenes o sistemas de
#    archivos distintos —que es el caso normal: el repositorio del operador está en
#    /home y el despliegue va a /opt—. Abortaba la instalación en el paso 3/4.
#    Copiar los objetos funciona siempre y el coste, para este repositorio, es de
#    segundos.
# 2. Clonar en temporal y moverlo después evita dejar `/opt/odontocrm` a medias si la
#    clonación falla: un `.git` incompleto en el destino bloqueaba el reintento.
clonar_codigo() {
  local temporal="${CODE_DIR}.clon-nuevo"
  rm -rf "$temporal"
  if ! git clone --local --no-hardlinks --quiet "$ORIGEN" "$temporal"; then
    rm -rf "$temporal"
    morir "no pude clonar el repositorio en $temporal"
  fi
  rm -rf "$CODE_DIR"
  mv "$temporal" "$CODE_DIR" || morir "no pude mover el clon a $CODE_DIR"
  # La rama, creada en el commit desplegado (no desacoplar la cabeza: ver arriba).
  if [[ -n "$RAMA" && "$RAMA" != "HEAD" ]]; then
    git -C "$CODE_DIR" checkout --quiet -B "$RAMA" "$COMMIT" 2>/dev/null ||
      av "no pude dejar la rama $RAMA en $COMMIT"
  fi
  ok "código clonado en $CODE_DIR (rama $RAMA, commit $COMMIT)"
}

if (( EN_SU_SITIO )); then
  ok "ya estamos sobre el código desplegado ($CODE_DIR), commit $COMMIT"
elif (( DRY_RUN )); then
  detalle "[dry-run] git clone --local --no-hardlinks $ORIGEN $CODE_DIR (rama $RAMA, commit $COMMIT)"
elif git -C "$CODE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$CODE_DIR" fetch --prune --quiet "$ORIGEN" 2>/dev/null || true
  # `checkout -B <rama> <commit>` deja la rama CREADA en ese commit. Un
  # `git checkout <sha>` a secas **desacopla** la cabeza (HEAD), y entonces
  # `odontocrm actualizar` —que lee la rama con `rev-parse --abbrev-ref HEAD`— recibe
  # «HEAD» y muere con «'HEAD' no es un nombre válido de rama»: la instalación
  # terminaba bien y la PRIMERA actualización era imposible.
  if [[ -n "$RAMA" && "$RAMA" != "HEAD" ]]; then
    git -C "$CODE_DIR" checkout --quiet -B "$RAMA" "$COMMIT" 2>/dev/null ||
      av "no pude poner el clon en $COMMIT: se deja como estaba"
  else
    git -C "$CODE_DIR" checkout --quiet "$COMMIT" 2>/dev/null || true
  fi
  ok "clon ya existente en $CODE_DIR (rama $RAMA, commit $COMMIT)"
elif [[ -d "$CODE_DIR/.git" ]]; then
  # Hay un `.git` que git no reconoce: es la ruina de un intento anterior que se
  # cortó a medias. No sirve para nada y bloquea la instalación, así que se retira.
  av "$CODE_DIR tenía un clon incompleto de un intento anterior: se retira y se clona de nuevo"
  rm -rf "$CODE_DIR"
  clonar_codigo
elif [[ -n "$(ls -A "$CODE_DIR" 2>/dev/null)" ]]; then
  morir "$CODE_DIR no está vacío y no es un clon de git. No lo borro por si hay algo dentro:
    muévelo aparte (p. ej. mv $CODE_DIR ${CODE_DIR}.viejo) y vuelve a ejecutar."
else
  mkdir -p "$(dirname "$CODE_DIR")"
  clonar_codigo
fi

if (( ! DRY_RUN )) && [[ -n "$REMOTO" ]]; then
  git -C "$CODE_DIR" remote set-url origin "$REMOTO" 2>/dev/null &&
    git config --global --add safe.directory "$CODE_DIR" 2>/dev/null || true
  ok "origen de las actualizaciones: $REMOTO"
fi

# ════════════════════════════════════════════════════════════════════════════
# 2. Dependencias y compilación
# ════════════════════════════════════════════════════════════════════════════
paso '2/9 · Dependencias y compilación'
if (( DRY_RUN )); then
  detalle "[dry-run] (cd $CODE_DIR && npm ci && npm run build)"
else
  registro=/tmp/odontocrm-npm-ci.log
  if ! (cd "$CODE_DIR" && npm ci --silent) >"$registro" 2>&1; then
    tail -20 "$registro"
    morir "falló «npm ci» (registro: $registro). ¿Hay conexión a internet?"
  fi
  ok 'dependencias instaladas (npm ci)'

  registro=/tmp/odontocrm-build.log
  if ! (cd "$CODE_DIR" && npm run build) >"$registro" 2>&1; then
    tail -25 "$registro"
    morir "falló la compilación (registro: $registro)"
  fi
  ok 'compilado: servicios, paquetes y la interfaz web'
fi

# ════════════════════════════════════════════════════════════════════════════
# 3. Claves EdDSA de los JWT
# ════════════════════════════════════════════════════════════════════════════
paso '3/9 · Claves de firma de los JWT'
CLAVE_PRIV="$ETC_DIR/keys/jwt-private.pem"
CLAVE_PUB="$ETC_DIR/keys/jwt-public.pem"
if [[ -f "$CLAVE_PRIV" && -f "$CLAVE_PUB" ]]; then
  ok 'ya existen las dos: se conservan (regenerarlas cerraría todas las sesiones abiertas)'
elif (( DRY_RUN )); then
  detalle "[dry-run] generaría $ETC_DIR/keys/jwt-{private,public}.pem"
else
  # Se usa el generador del propio proyecto, con el entorno del servicio, para que el
  # formato sea exactamente el que espera el código (no uno parecido).
  #
  # OJO: con el entorno incompleto, `keys.js` cae a su ruta por defecto, que es
  # RELATIVA AL CÓDIGO (`services/identity/.keys/`). Eso dejaría la clave privada
  # DENTRO de /opt —justo lo que el ADR 0043 prohíbe— y el servicio no la
  # encontraría. Por eso se comprueba DÓNDE quedó, y si quedó en el código se
  # retira y se aborta en vez de seguir con una instalación que parece correcta.
  registro=/tmp/odontocrm-keys.log
  (cd "$CODE_DIR" && node tools/con-entorno.mjs "$ETC_DIR" identity -- \
    node services/identity/dist/keys.js) >"$registro" 2>&1 || true

  perdida="$CODE_DIR/services/identity/.keys/jwt-private.pem"
  if [[ ! -f "$CLAVE_PRIV" ]]; then
    [[ -f "$perdida" ]] && rm -rf "$CODE_DIR/services/identity/.keys"
    tail -10 "$registro" 2>/dev/null | sed 's/^/      /'
    morir "las claves no quedaron en $ETC_DIR/keys. Se habrían escrito dentro del código
    (que es lo que NO debe pasar: los secretos no viven en $CODE_DIR)."
  fi
  chown root:"$SERVICE_GROUP" "$ETC_DIR/keys"/*.pem 2>/dev/null || true
  chmod 0640 "$CLAVE_PRIV"
  chmod 0644 "$CLAVE_PUB"
  ok "claves nuevas en $ETC_DIR/keys (privada 0640 root:$SERVICE_GROUP)"
fi

# ════════════════════════════════════════════════════════════════════════════
# 4. Migraciones — con el entorno de /etc/odontocrm, no con los .env del repo
# ════════════════════════════════════════════════════════════════════════════
paso "4/9 · Migraciones de las ${#SERVICIOS[@]} bases"
#
# `tools/con-entorno.mjs` carga los .env SIN interpretarlos como shell. Es
# importante: `source` vaciaba WEB_ORIGIN por el espacio tras la coma y expandía las
# contraseñas con `$`, y el fallo aparecía como «password authentication failed»
# sobre una credencial que en el archivo estaba bien.
if (( DRY_RUN )); then
  for s in "${SERVICIOS[@]}"; do detalle "[dry-run] migrar $s"; done
else
  # Antes de migrar: ¿está PostgreSQL en marcha? Si no, lo que se ve es un `ECONNREFUSED
  # 127.0.0.1:5432` dentro de una traza larga de Node, que no dice qué hacer. Pasó tras un
  # reinicio con la base parada (la había parado `odontocrm parar --todo`).
  if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    av 'PostgreSQL no está escuchando en 127.0.0.1:5432'
    detalle 'arráncalo y repite:   sudo odontocrm arrancar   (o la pieza 1: 10-preparar.sh)'
    morir 'no puedo migrar sin base de datos'
  fi
  for s in "${SERVICIOS[@]}"; do
    registro="/tmp/odontocrm-migrar-$s.log"
    if ! (cd "$CODE_DIR" && node tools/con-entorno.mjs "$ETC_DIR" "$s" -- \
      node "services/$s/dist/db/migrate.js") >"$registro" 2>&1; then
      echo "    --- $registro ---"
      tail -25 "$registro" | sed 's/^/    /'
      morir "fallaron las migraciones de $s"
    fi
    ok "migraciones de $s"
  done
fi

# ════════════════════════════════════════════════════════════════════════════
# 5. Usuarios iniciales
# ════════════════════════════════════════════════════════════════════════════
paso '5/9 · Usuarios iniciales'
SIN_USUARIOS=0
INFORME_CLAVE=/root/odontocrm-contrasena-inicial.txt
if (( DRY_RUN )); then
  detalle "[dry-run] sembraría: ${USUARIOS_SEED:-admin, recepcion y los odontólogos de clinic.ts}"
else
  # Qué cuentas se siembran. Por defecto, todas —`admin`, `recepcion` y un odontólogo por
  # entrada de `CLINIC.dentists`—, que es lo que necesitan el desarrollo y las pruebas y lo
  # que sigue haciendo `odontocrm actualizar` (no define `USUARIOS_SEED`). El instalador
  # pide **solo `admin`** en una instalación nueva: el resto del personal se da de alta
  # desde la aplicación (`/usuarios`), que es donde tiene sentido decidir rol y datos.
  # Los nombres van tal cual salen de `clinic.ts` (el seed los compara sin distinguir
  # mayúsculas) y la variable de entorno sí se escribe en mayúsculas.
  if [[ -n "${USUARIOS_SEED:-}" ]]; then
    usuarios_seed="$(printf '%s' "$USUARIOS_SEED" | tr ',' '\n' | sed '/^[[:space:]]*$/d')"
  else
    usuarios_seed="$(
      { printf 'admin\nrecepcion\n'
        grep -oP "username: '\K[^']+" "$CODE_DIR/packages/contracts/src/clinic.ts" 2>/dev/null || true
      } | sort -u
    )"
  fi
  usuarios_lista="$(printf '%s' "$usuarios_seed" | paste -sd, -)"

  # ¿Hay ya usuarios? El seed **omite los que existen** (sin `--reset`), así que
  # repetir la instalación y volver a imprimir una contraseña recién generada daría
  # una clave que no vale para nadie y dejaría al operador sin poder entrar.
  # Se cuenta antes de sembrar, con la credencial de /etc/odontocrm.
  url_identidad="$(leer_clave_entorno "$ETC_DIR/identity.env" DATABASE_URL)"
  ya_hay=0
  if [[ -n "$url_identidad" ]]; then
    resto="${url_identidad#postgres://}"
    usuario_db="${resto%%:*}"
    resto="${resto#*:}"
    clave_db="${resto%%@*}"
    base_db="${url_identidad##*/}"
    existentes_db="$(PGPASSWORD="$clave_db" PGPASSFILE=/dev/null psql -X -w -tAc 'select count(*) from users' \
      -h 127.0.0.1 -p 5432 -U "$usuario_db" -d "$base_db" 2>/dev/null || echo '?')"
    [[ "$existentes_db" =~ ^[0-9]+$ ]] && (( existentes_db > 0 )) && ya_hay=1
  fi

  # Contraseña con la que nacen las cuentas:
  #   · si el entorno ya trae `SEED_PASSWORD_<USUARIO>` —es lo que pide el instalador—,
  #     manda esa y **no se imprime**: la eligió quien instala y ya la conoce;
  #   · si no, se genera una temporal que se imprime UNA vez y queda en un archivo de root
  #     (0600): el sistema obliga a cambiarla en el primer ingreso.
  temporal="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-14)"
  entorno_claves=(); generadas=(); propias=()
  while IFS= read -r usuario; do
    [[ -n "$usuario" ]] || continue
    variable="SEED_PASSWORD_$(printf '%s' "$usuario" | tr 'a-z' 'A-Z')"
    valor="${!variable:-}"
    if (( ${#valor} >= 10 )); then
      entorno_claves+=("$variable=$valor"); propias+=("$usuario")
    else
      entorno_claves+=("$variable=$temporal"); generadas+=("$usuario")
    fi
  done <<<"$usuarios_seed"

  # `--usuarios=`: siembra solo estas cuentas (y en producción solo exige sus claves).
  # `--ocultar-claves=`: no imprime las que eligió una persona.
  argumentos_seed=("--usuarios=$usuarios_lista")
  (( ${#propias[@]} > 0 )) &&
    argumentos_seed+=("--ocultar-claves=$(printf '%s' "${propias[*]}" | tr ' ' ',')")

  # El registro nace en 0600 y dentro de /root: la salida del seed lleva credenciales, y un
  # archivo en /tmp a 644 lo lee cualquiera de la máquina. Se borra al terminar bien.
  registro="$(mktemp /root/.odontocrm-seed-XXXXXX.log)" ||
    morir 'no pude crear el registro del seed en /root'
  if (cd "$CODE_DIR" && env "${entorno_claves[@]}" node tools/con-entorno.mjs "$ETC_DIR" identity -- \
    node services/identity/dist/seed.js "${argumentos_seed[@]}") >"$registro" 2>&1; then
    # ¿El seed creó alguna cuenta? Solo entonces hay contraseña nueva que dar.
    creadas=0
    if grep -q 'Usuarios creados' "$registro"; then creadas=1; fi
    rm -f "$registro"
    ok "usuarios al día: $(printf '%s' "$usuarios_lista" | tr ',' ' ')"
    if (( creadas )); then
      if (( ${#generadas[@]} > 0 )); then
        # La generada se deja además en un archivo de root (0600): si esto corre desde
        # `odontocrm actualizar`, la salida va a un registro del que nadie se acuerda.
        printf 'Contraseña temporal de %s: %s\n' "${generadas[*]}" "$temporal" >"$INFORME_CLAVE"
        chmod 0600 "$INFORME_CLAVE"; chown root:root "$INFORME_CLAVE" 2>/dev/null || true
        if [[ -t 1 ]]; then
          printf '\n  %sContraseña temporal: %s%s%s\n' "$C_TI" "$C_TI" "$temporal" "$C_RE"
          printf '  %s(se pide cambiarla al primer ingreso)%s\n\n' "$C_DIM" "$C_RE"
          (( ${#propias[@]} > 0 )) && detalle "solo para: ${generadas[*]}"
        else
          ok "contraseña temporal (${generadas[*]}) → $INFORME_CLAVE (0600, solo root)"
          detalle 'se pide cambiarla al primer ingreso'
        fi
      fi
      # Las que eligió quien instala no se imprimen: ya las conoce.
      (( ${#propias[@]} > 0 )) && detalle "con la contraseña que elegiste: ${propias[*]}"
    elif (( ya_hay )); then
      # Los usuarios ya estaban: el seed NO los toca, así que aquí NO hay contraseña
      # nueva que dar. Se dice claro y se da la receta exacta para poner una que el
      # operador elija — sin esto, quien instala se queda fuera del sistema sin
      # ninguna pista de cómo entrar (pasó en la primera instalación real).
      av "los $existentes_db usuario(s) ya existían: no se les ha cambiado la contraseña"
      detalle 'para entrar vale la que ya tuvieran'
      echo
      printf '      %spara poner una que elijas TÚ:%s\n' "$C_TI" "$C_RE"
      receta=""
      while IFS= read -r u; do
        [[ -n "$u" ]] && receta+="SEED_PASSWORD_$(printf '%s' "$u" | tr 'a-z' 'A-Z')='TU_CLAVE' "
      done <<<"$usuarios_seed"
      printf '        cd %s && sudo %s \\\n' "$CODE_DIR" "${receta% }"
      printf '          node tools/con-entorno.mjs %s identity -- node services/identity/dist/seed.js --reset --usuarios=%s\n\n' "$ETC_DIR" "$usuarios_lista"
      detalle 'el sistema pedirá cambiarla en el primer acceso'
    fi
  else
    tail -20 "$registro" | sed 's/^/    /'
    err 'NO se pudieron sembrar los usuarios: sin usuarios no se puede entrar al sistema'
    detalle "mira $registro y repítelo a mano (RUNBOOK §5) antes de dar la instalación por buena"
    SIN_USUARIOS=1
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 6. Unidades de systemd
# ════════════════════════════════════════════════════════════════════════════
paso '6/9 · Unidades de systemd'
UNIDADES=(odontocrm@.service odontocrm-gateway.service)
# El de la red va SIEMPRE (no depende de los respaldos): es el que vuelve a adaptar
# firewall, certificado, CORS y el DNS del nombre cuando cambia la IP. En la clínica, con
# IP fija, sale sin hacer nada; en un portátil de pruebas, deja todo al día solo.
TIMERS=(odontocrm-alertas.service odontocrm-alertas.timer)
TIMERS+=(odontocrm-red.service odontocrm-red.timer)
(( ! SIN_RESPALDO )) && TIMERS+=(odontocrm-backup.service odontocrm-backup.timer)

for unidad in "${UNIDADES[@]}" "${TIMERS[@]}"; do
  origen="$CODE_DIR/infra/fedora/systemd/$unidad"
  destino="/etc/systemd/system/$unidad"
  [[ -f "$origen" ]] || { av "no encuentro $unidad en el código"; continue; }
  if [[ -f "$destino" ]] && cmp -s "$origen" "$destino"; then
    ok "$(printf '%-32s' "$unidad") sin cambios"
  else
    ejecutar install -m 0644 -o root -g root "$origen" "$destino"
    ok "$(printf '%-32s' "$unidad") instalada"
  fi
done

if (( ! DRY_RUN )); then
  systemctl daemon-reload || morir 'systemctl daemon-reload falló'
  ok 'systemd ha releído las unidades'
fi

# El comando del servidor: una sola puerta para el día a día en la clínica.
if [[ -f "$CODE_DIR/infra/fedora/odontocrm" ]]; then
  ejecutar install -m 0755 -o root -g root "$CODE_DIR/infra/fedora/odontocrm" /usr/local/bin/odontocrm
  ok 'instalado /usr/local/bin/odontocrm'
fi
if [[ -f "$CODE_DIR/infra/fedora/logrotate/odontocrm" ]]; then
  ejecutar install -m 0644 -o root -g root "$CODE_DIR/infra/fedora/logrotate/odontocrm" /etc/logrotate.d/odontocrm
  ok 'rotación de logs instalada'
fi

# Los servicios. Se habilitan (arrancan solos al encender la máquina).
UNIDADES_SERVICIO=()
for s in "${SERVICIOS[@]}"; do UNIDADES_SERVICIO+=("odontocrm@$s.service"); done
UNIDADES_SERVICIO+=(odontocrm-gateway.service)

if (( DRY_RUN )); then
  detalle "[dry-run] systemctl enable --now ${UNIDADES_SERVICIO[*]}"
else
  # `enable` para que arranquen al encender la máquina, y `restart` —no `--now`— para
  # que los procesos tomen el entorno ACTUAL: `enable --now` no reinicia una unidad
  # que ya estaba activa, así que tras un `--rotar-credenciales` los 9 procesos se
  # quedaban con el DATABASE_URL viejo y fallaban con 28P01 hasta un reinicio a mano.
  systemctl enable "${UNIDADES_SERVICIO[@]}" >/dev/null 2>&1 ||
    av 'alguna unidad no se pudo habilitar para el arranque'
  systemctl restart "${UNIDADES_SERVICIO[@]}" >/dev/null 2>&1 ||
    av 'alguna unidad no arrancó: se detalla al verificar (pieza 4)'
  if (( ! SIN_RESPALDO )); then
    systemctl enable --now odontocrm-backup.timer >/dev/null 2>&1 || true
  fi
  systemctl enable --now odontocrm-alertas.timer >/dev/null 2>&1 || true
  systemctl enable --now odontocrm-red.timer >/dev/null 2>&1 || true
  ok "los ${#SERVICIOS[@]} servicios habilitados (arrancan solos al encender la máquina)"
  detalle 'esperando a que escuchen…'
  # Los puertos salen de `PUERTO_SERVICIO` (comun.sh): antes estaban escritos a mano aquí y,
  # al añadir un servicio (billing fue el último), esta espera se quedaba corta en silencio.
  mapfile -t PUERTOS_ESPERADOS < <(puertos_internos)
  total_puertos=$(( ${#PUERTOS_ESPERADOS[@]} - 1 ))   # 5432 (la base) no se espera aquí
  for _ in $(seq 1 30); do
    listos=0
    for p in "${PUERTOS_ESPERADOS[@]}"; do
      [[ "$p" == "5432" ]] && continue
      ss -ltn 2>/dev/null | grep -q "127.0.0.1:$p" && listos=$((listos + 1))
    done
    (( listos >= total_puertos )) && break
    sleep 1
  done
  (( listos >= total_puertos )) && ok "los $total_puertos puertos internos escuchan" ||
    av "solo $listos de $total_puertos escuchan todavía: mira «sudo odontocrm verificar»"
fi

# ════════════════════════════════════════════════════════════════════════════
# 7. Certificado TLS interno
# ════════════════════════════════════════════════════════════════════════════
paso '7/9 · Certificado TLS interno'
#
# Con TLS interno el navegador avisa la primera vez hasta que se instala la CA en
# cada aparato. No es un fallo: la CA se descarga desde el propio servidor (paso 8)
# y se instala una sola vez por equipo.
NOMBRES_TLS=("$FQDN" localhost 127.0.0.1 "$IP_LAN")
CERT=/etc/pki/tls/certs/odontocrm.crt
CLAVE=/etc/pki/tls/private/odontocrm.key

if cert_cubre "$CERT" "${NOMBRES_TLS[@]}"; then
  # Ya hay un certificado que sirve para estos nombres. NO se reemite: podría ser
  # uno propio de la clínica (de su proveedor), y pisarlo sin avisar es perderlo.
  vence="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  ok "ya hay un certificado que cubre ${NOMBRES_TLS[*]}: se conserva"
  [[ -n "$vence" ]] && detalle "válido hasta $vence"
elif ! command -v mkcert >/dev/null 2>&1; then
  av 'mkcert no está instalado: sin certificado, el proxy no arrancará'
  detalle 'lo instala 10-preparar.sh (paquete mkcert)'
elif (( DRY_RUN )); then
  detalle "[dry-run] mkcert -install && mkcert ${NOMBRES_TLS[*]}"
else
  mkcert -install >/dev/null 2>&1 || true
  install -d -m 0755 /etc/pki/tls/certs /etc/pki/tls/private
  if mkcert -key-file "$CLAVE" -cert-file "$CERT" "${NOMBRES_TLS[@]}" >/dev/null 2>&1; then
    chmod 0600 "$CLAVE"; chown root:root "$CLAVE"
    vence="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
    ok "certificado emitido para: ${NOMBRES_TLS[*]}"
    [[ -n "$vence" ]] && detalle "válido hasta $vence (mkcert renueva con: sudo odontocrm certificado)"
  else
    av 'no pude emitir el certificado con mkcert'
  fi

  # La CA interna: sin ella no se puede quitar el aviso en los aparatos, y si se
  # pierde hay que emitir certificados nuevos en TODOS.
  CAROOT_DIR="$(mkcert -CAROOT 2>/dev/null || echo /root/.local/share/mkcert)"
  if [[ -f "$CAROOT_DIR/rootCA.pem" ]]; then
    install -d -m 0750 -o root -g "$SERVICE_GROUP" "$ETC_DIR/keys"
    install -m 0644 -o root -g root "$CAROOT_DIR/rootCA.pem" "$ETC_DIR/keys/odontocrm-ca.crt"
    ok 'CA interna guardada en /etc/odontocrm/keys (entra en el respaldo de configuración)'
  else
    av "no encuentro la CA de mkcert en $CAROOT_DIR/rootCA.pem"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 8. Proxy inverso, SELinux y firewall
# ════════════════════════════════════════════════════════════════════════════
paso '8/9 · Proxy inverso, SELinux y firewall'

# ── El nombre para los aparatos ─────────────────────────────────────────────
# mDNS (odontocrm.local) ya lo publica 10-preparar.sh vía avahi. Funciona en
# Windows 10+, macOS y Linux; los Android antiguos no lo entienden, y para esos
# está el DNS propio (--con-dns), que es lo que funciona en TODOS.
if (( CON_DNS )); then
  if (( DRY_RUN )); then
    detalle "[dry-run] instalaría el DNS propio para $(nombre_corto "$NOMBRE_MDNS").home.arpa"
  elif [[ -f "$CODE_DIR/infra/fedora/nombre/instalar-dns.sh" ]]; then
    bash "$CODE_DIR/infra/fedora/nombre/instalar-dns.sh" --nombre="$(nombre_corto "$NOMBRE_MDNS").home.arpa" ||
      av 'no pude configurar el DNS propio (el mDNS y la IP siguen funcionando)'
  else
    av 'no encuentro nombre/instalar-dns.sh en el código desplegado'
  fi
else
  ok "mDNS: los equipos entran por https://$FQDN"
  detalle 'si algún Android no resuelve el nombre, repite con --con-dns'
fi

# ── El proxy ────────────────────────────────────────────────────────────────
if (( DRY_RUN )); then
  detalle "[dry-run] nginx/instalar.sh --host=\"$FQDN $IP_LAN\""
elif [[ -f "$CODE_DIR/infra/fedora/nginx/instalar.sh" ]]; then
  bash "$CODE_DIR/infra/fedora/nginx/instalar.sh" --host="$FQDN $IP_LAN" | sed 's/^/  /' ||
    av 'el instalador del proxy reportó un problema'
else
  av 'no encuentro nginx/instalar.sh en el código desplegado'
fi

# ── SELinux ─────────────────────────────────────────────────────────────────
# Fedora lo trae en Enforcing. Las dos cosas que nginx necesita y que no se
# adivinan: poder salir a la red (llegar al gateway) y leer la SPA compilada.
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
  if (( DRY_RUN )); then
    detalle '[dry-run] setsebool -P httpd_can_network_connect on y etiquetar la SPA'
  else
    setsebool -P httpd_can_network_connect on 2>/dev/null &&
      ok 'SELinux: nginx puede salir a 127.0.0.1:8090' ||
      av 'no pude activar httpd_can_network_connect: el proxy no llegará al gateway'
    if command -v semanage >/dev/null 2>&1; then
      etiquetadas=0
      for ruta in "$CODE_DIR/apps/web/dist" /var/www/odontocrm; do
        [[ -e "$ruta" ]] || continue
        semanage fcontext -a -t httpd_sys_content_t "$ruta(/.*)?" 2>/dev/null ||
          semanage fcontext -m -t httpd_sys_content_t "$ruta(/.*)?" 2>/dev/null || true
        restorecon -R "$ruta" 2>/dev/null || true
        etiquetadas=$((etiquetadas + 1))
      done
      (( etiquetadas > 0 )) &&
        ok "SELinux: $etiquetadas ruta(s) etiquetadas como contenido web" ||
        av 'no encontré la interfaz compilada que etiquetar'
    else
      av 'falta semanage (policycoreutils-python-utils): la interfaz puede dar 403'
    fi
  fi
else
  detalle 'SELinux no está en Enforcing: no se toca'
fi

# ── Firewall ────────────────────────────────────────────────────────────────
# Se abren SOLO el 80 y el 443. El gateway y los servicios internos
# escuchan en 127.0.0.1 y NO se publican: los aparatos entran por el proxy.
if ! systemctl is-active --quiet firewalld && ! systemctl is-enabled --quiet firewalld 2>/dev/null; then
  av 'firewalld no está activo: los puertos no se filtran en esta máquina'
  detalle 'si la red es de confianza puede valer; si no:  sudo systemctl enable --now firewalld'
elif (( DRY_RUN )); then
  detalle '[dry-run] firewall-cmd --add-service={http,https} en la zona de la LAN'
else
  systemctl enable --now firewalld >/dev/null 2>&1 || true

  if [[ -n "$LAN_CIDR" ]]; then
    ZONA=""
    if timeout 20 firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${LAN_CIDR} port port=443 protocol=tcp accept" >/dev/null 2>&1 &&
       timeout 20 firewall-cmd --permanent --add-service=http >/dev/null 2>&1; then
      abierto=1
    else
      abierto=0
    fi
    modo_fw="regla estricta para $LAN_CIDR"
  else
    IFACE="$(interfaz_lan)"
    ZONA="$(timeout 15 firewall-cmd --get-zone-of-interface="${IFACE}" 2>/dev/null || echo public)"
    [[ -n "$ZONA" && "$ZONA" != "no" ]] || ZONA=public
    if timeout 20 firewall-cmd --permanent --zone="$ZONA" --add-service=https >/dev/null 2>&1 &&
       timeout 20 firewall-cmd --permanent --zone="$ZONA" --add-service=http >/dev/null 2>&1; then
      abierto=1
    else
      abierto=0
    fi
    modo_fw="zona «$ZONA» de ${IFACE:-la interfaz de la LAN} (vale en cualquier red)"
  fi

  # El `ok` va DESPUÉS de comprobar el código de salida. Antes se imprimía «80 y 443
  # abiertos» pasara lo que pasara: si firewall-cmd fallaba, la instalación decía
  # haber abierto los puertos y desde los aparatos no entraba nadie.
  if (( abierto )) && timeout 30 firewall-cmd --reload >/dev/null 2>&1; then
    ok "80 y 443 abiertos para la LAN — $modo_fw"
  else
    err 'NO se pudieron abrir el 80 y el 443: desde otro aparato no cargará la aplicación'
    detalle "abre a mano el https (y el http) en la zona de la LAN:  sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload"
  fi

  # Lo que NO debe estar abierto. Se consulta la zona de la LAN **y** la de por
  # defecto: `--list-ports` a secas mira solo la de por defecto, así que un puerto
  # publicado en la zona de la interfaz no se veía y el «no están publicados» mentía.
  zonas=(public)
  [[ -n "${ZONA:-}" && "$ZONA" != "public" ]] && zonas+=("$ZONA")
  abiertos=""
  for z in "${zonas[@]}"; do
    abiertos+="$(timeout 15 firewall-cmd --zone="$z" --list-ports 2>/dev/null || true)"$'\n'
    abiertos+="$(timeout 15 firewall-cmd --zone="$z" --list-rich-rules 2>/dev/null || true)"$'\n'
  done
  publicados=0
  # La lista sale de `puertos_internos` (comun.sh): escrita a mano se quedaba sin el puerto
  # del último servicio, y esta comprobación —que es de seguridad— decía «todo bien» sin
  # haberlo mirado.
  while IFS= read -r puerto; do
    if grep -qE "(^|[^0-9])${puerto}/(tcp|udp)" <<<"$abiertos"; then
      av "el puerto $puerto está abierto a la red y no debería (la base y los servicios van por dentro)"
      publicados=$((publicados + 1))
    fi
  done < <(puertos_internos)
  (( publicados == 0 )) && ok 'comprobado: la base y los servicios internos NO están publicados'
fi

# ════════════════════════════════════════════════════════════════════════════
# 9. Respaldos
# ════════════════════════════════════════════════════════════════════════════
paso '9/9 · Respaldos'
if (( SIN_RESPALDO )); then
  av 'omitidos (--sin-respaldo): no habrá copia automática de las historias clínicas'
elif (( DRY_RUN )); then
  detalle '[dry-run] crear rol odonto_backup, backup.env y el temporizador diario'
else
  # backup.env tiene que existir antes: el rol de respaldo se apoya en él.
  if [[ ! -f "$ETC_DIR/backup.env" ]]; then
    cat >"$ETC_DIR/backup.env" <<EOF
# ─────────────────────────────────────────────────────────────────────────────
# OdontoCRM · configuración de los respaldos (lo lee backup/odontocrm-backup.sh)
# ─────────────────────────────────────────────────────────────────────────────
BACKUP_DIR=$BACKUP_DIR
RETENTION_DAYS=30
LOG_FILE=$LOG_DIR/backup.log
STORAGE_DIR=$DATA_DIR/storage
PGBIN_DIR=$(dirname "$(command -v pg_dump 2>/dev/null || echo /usr/bin/pg_dump)")
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=odonto_backup
PGPASSFILE=$ETC_DIR/.pgpass
DATABASES="odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting odonto_events"
ROLE_odonto_identity=odonto_identity
ROLE_odonto_patients=odonto_patients
ROLE_odonto_scheduling=odonto_scheduling
ROLE_odonto_notifications=odonto_notifications
ROLE_odonto_clinical=odonto_clinical
ROLE_odonto_odontogram=odonto_odontogram
ROLE_odonto_screens=odonto_screens
ROLE_odonto_reporting=odonto_reporting
EOF
    chown root:root "$ETC_DIR/backup.env"; chmod 0600 "$ETC_DIR/backup.env"
    ok 'backup.env creado'
  else
    ok 'backup.env ya existía: se conserva'
  fi

  if [[ -f "$CODE_DIR/infra/fedora/backup/crear-rol-respaldo.sh" ]]; then
    # El rol se conecta por TCP con .pgpass: el respaldo no depende de que el
    # usuario del sistema se llame como un rol de PostgreSQL.
    ADMIN_URL="$ADMIN_URL" SUDO_USER="$USUARIO_REAL" \
      bash "$CODE_DIR/infra/fedora/backup/crear-rol-respaldo.sh" --admin-role="$USUARIO_REAL" |
      sed 's/^/  /' || av 'no pude preparar el rol de respaldo'
  fi
  systemctl enable --now odontocrm-backup.timer >/dev/null 2>&1 &&
    ok 'respaldo diario programado (y entra en el respaldo la configuración, con secretos)' ||
    av 'no pude habilitar el temporizador de respaldo'
fi

# ════════════════════════════════════════════════════════════════════════════
# Guardia final: el código desplegado no puede contener secretos
# ════════════════════════════════════════════════════════════════════════════
if (( ! DRY_RUN )); then
  filtrados="$(find "$CODE_DIR" -maxdepth 3 -name '.env' -not -path '*/node_modules/*' 2>/dev/null | head -5 || true)"
  if [[ -n "$filtrados" ]]; then
    av 'hay archivos .env dentro del código desplegado (no deberían estar aquí):'
    printf '%s\n' "$filtrados" | sed 's/^/      /'
    detalle "los secretos viven SOLO en $ETC_DIR"
  else
    ok "el código de $CODE_DIR no contiene secretos (ni un .env)"
  fi
fi

if (( SIN_USUARIOS )); then
  printf '\n%s! El servidor está desplegado, pero NO hay usuarios con los que entrar.%s\n' "$C_TI" "$C_AV" "$C_RE"
  printf '  No lo des por bueno hasta sembrarlos (arriba está el registro con el fallo).\n'
else
  printf '\n%s3/4 listo.%s El servidor está desplegado y arrancado.\n' "$C_TI" "$C_RE"
fi
detalle "siguiente:  sudo bash $INSTALADOR_DIR/40-verificar.sh"
