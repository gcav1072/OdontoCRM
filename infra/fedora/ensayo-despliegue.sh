#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · Fase 10 — ensayo del despliegue Fedora en la PC de pruebas
#
# Repite, sobre ESTA máquina, los pasos de infra/fedora/INSTALL.md §7 a §16 con la
# forma de una instalación de verdad: usuario de sistema, código en /opt/odontocrm,
# secretos en /etc/odontocrm, unidades systemd, TLS interno con nginx y respaldos
# con su prueba de restauración. La guía manda; este guion solo mecaniza sus
# comandos para poder repetirlo sin equivocarse al teclear, y **comprueba** cada
# paso en vez de darlo por hecho (era el sentido del banco de pruebas).
#
#   sudo bash infra/fedora/ensayo-despliegue.sh --hasta=servicios
#   sudo bash infra/fedora/ensayo-despliegue.sh --hasta=tls --lan-cidr=192.168.1.0/24
#   sudo bash infra/fedora/ensayo-despliegue.sh --hasta=respaldos
#   sudo bash infra/fedora/ensayo-despliegue.sh --hasta=respaldos --reiniciar
#
# Despliega la rama que tengas ACTIVA en el repositorio de trabajo (o `--rama=`).
# Requisitos: la PC ya preparada (instalar-base-fedora.sh), el bootstrap hecho en
# el repositorio (`npm run db:bootstrap`) y ninguna otra pila en los puertos.
#
# Fases: usuario → codigo → config → migrar → servicios → [tls] → [respaldos]
# Al final imprime un resumen con lo que quedó y lo que hay que comprobar a mano.
# =============================================================================
set -uo pipefail

# Cualquier error inesperado dice DÓNDE fue. Sin esto, una variable mal escrita
# (como pasó con $ADMIN) mataba el guion en silencio: el ensayo terminaba sin
# «Resumen» y sin reiniciar, y parecía que el flag no funcionaba.
trap 'codigo=$?; err "el ensayo se detuvo en la línea $LINENO (código $codigo):"; err "    $(sed -n "${LINENO}p" "$0" | sed "s/^ *//")"; exit $codigo' ERR

# Y un aviso de SALIDA: se ejecuta siempre, incluso cuando bash aborta por `set -u` (ese
# caso **no** pasa por el trap de ERR). Es el que habría dicho «el ensayo terminó con
# error en la línea X» en vez de dejar una salida truncada que parecía un reinicio roto.
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

# ── Parámetros ───────────────────────────────────────────────────────────────
# El repositorio de trabajo es el que contiene este guion: así funciona en
# cualquier PC sin editar rutas (se puede forzar con --origen=).
ORIGEN="${ORIGEN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DESTINO="${DESTINO:-/opt/odontocrm}"
# Por defecto se despliega la rama que TENGAS ACTIVA en el repositorio de trabajo: es
# la que estás mirando y la que esperas ver en el servidor. Si quieres otra (por
# ejemplo, `main` mientras trabajas en una rama de función), pásala con `--rama=`.
RAMA="${RAMA:-}"
SERVICIOS=(identity patients scheduling notifications clinical odontogram screens reporting)
HASTA="servicios"
LAN_CIDR=""
REINICIAR=0

for arg in "$@"; do
  case "$arg" in
    --hasta=*)
      HASTA="${arg#*=}"
      # Un typo aquí es peligroso: `--hasta=tls` escrito mal hacía que el ensayo se saltara
      # el TLS y los respaldos… y el «Resumen» salía igual, como si hubiera ido todo. Se
      # valida contra la lista de fases.
      case "$HASTA" in
        precondiciones|usuario|codigo|config|migraciones|servicios|tls|respaldos|todo) ;;
        *) echo "--hasta=$HASTA no es una fase: precondiciones | usuario | codigo | config | migraciones | servicios | tls | respaldos | todo" >&2; exit 2 ;;
      esac
      ;;
    --lan-cidr=*) LAN_CIDR="${arg#*=}" ;;
    --reiniciar) REINICIAR=1 ;;
    --origen=*) ORIGEN="${arg#*=}" ;;
    --rama=*) RAMA="${arg#*=}" ;;
    *) echo "Argumento no reconocido: $arg"; exit 2 ;;
  esac
done

# ── Salida ───────────────────────────────────────────────────────────────────
C_OK=$'\e[32m'; C_AV=$'\e[33m'; C_ER=$'\e[31m'; C_TI=$'\e[1m'; C_RE=$'\e[0m'
paso() { printf '\n%s==> %s%s\n' "$C_TI" "$1" "$C_RE"; }
ok()   { printf '  %s✔%s %s\n' "$C_OK" "$C_RE" "$1"; }
av()   { printf '  %s!%s %s\n' "$C_AV" "$C_RE" "$1"; }
err()  { printf '  %s✖%s %s\n' "$C_ER" "$C_RE" "$1"; }
morir(){ err "$1"; exit 1; }

[[ $EUID -eq 0 ]] || morir 'hay que ejecutarlo como root: sudo bash tmp/fase10-ensayo-fedora.sh'
[[ -d "$ORIGEN/.git" ]] || morir "no encuentro el repositorio en $ORIGEN"

# Sin `--rama`, la que esté activa en el repositorio de trabajo.
if [[ -z "$RAMA" ]]; then
  RAMA="$(git -C "$ORIGEN" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
[[ -n "$RAMA" && "$RAMA" != "HEAD" ]] ||
  morir "no pude averiguar la rama del repositorio ($ORIGEN): pásala con --rama=<nombre>"

USUARIO_REAL="${SUDO_USER:-root}"
HOME_REAL="$(getent passwd "$USUARIO_REAL" | cut -d: -f6)"
[[ -d "$HOME_REAL" ]] || HOME_REAL="/root"

# ── Un solo ensayo a la vez, y con testigo ───────────────────────────────────
# Lección de la Fase 10: un ensayo se quedó colgado en el restablecimiento (esperando
# una contraseña), la terminal siguió ocupada por él y los siguientes comandos no
# hicieron nada: parecía que el ensayo «no avanzaba» cuando en realidad nunca volvió a
# correr. Con el testigo, el segundo intento lo dice en el acto.
CERROJO="/run/odontocrm-ensayo.lock"
exec 9>"$CERROJO" 2>/dev/null || true
if ! flock -n 9 2>/dev/null; then
  echo "Ya hay un ensayo en marcha (o colgado)."
  echo "Míralo con:  pgrep -af 'fase10-ensayo|[o]dontocrm-restore'"
  echo "Termínalo con:  sudo pkill -f '[f]ase10-ensayo-fedora'; sudo pkill -f '[o]dontocrm-restore'"
  exit 1
fi

# ── 0. Precondiciones (lo que ya tiene que estar) ────────────────────────────
paso "0/7 · Precondiciones"

command -v node >/dev/null || morir 'falta node'
NODE_V="$(node --version)"
[[ "$NODE_V" == v26* ]] && ok "node $NODE_V" || av "node $NODE_V (el plan pide 26)"

systemctl is-active --quiet postgresql && ok 'postgresql activo' || morir 'el servicio postgresql no está activo'
PG_MAJOR="$(psql --version | grep -oE '[0-9]+' | head -1 || true)"

# UNA SOLA PILA A LA VEZ (ADR 0037). En la PC de pruebas pasó: los nueve puertos
# estaban ocupados por la pila de desarrollo, los servicios de systemd quedaron en
# bucle con EADDRINUSE (y en `failed` por el límite de arranques) y las
# comprobaciones de salud las contestaba **la pila equivocada**: el ensayo daba
# verde sin haber probado systemd.
if pgrep -f 'node --watch --env-file-if-exists' >/dev/null 2>&1 || pgrep -f 'tools/stack\.mjs' >/dev/null 2>&1; then
  morir "hay una pila de desarrollo corriendo (npm run dev / stack:dev): párala con «npm run stack:down» y repite. Dos pilas en los mismos puertos dejan los servicios de systemd en bucle y las comprobaciones miden la pila equivocada."
fi
ok 'ninguna otra pila usa los puertos'

# pg_hba: en Fedora el clúster nace con `ident` en TCP y ningún servicio entra.
METODOS="$(sudo -u postgres psql -tAc "select string_agg(distinct auth_method, ',') from pg_hba_file_rules where type='host' and database='{all}'" 2>/dev/null || echo '?')"
if [[ "$METODOS" == *ident* ]]; then
  morir "pg_hba.conf sigue con 'ident' en TCP: cámbialo a scram-sha-256 (INSTALL.md §6.3) y vuelve a ejecutar"
fi
ok "pg_hba TCP: $METODOS"

# El administrador de la base: por socket con peer (INSTALL.md §6.4).
psql "postgres:///postgres?host=/var/run/postgresql" -tAc 'select 1' >/dev/null 2>&1 ||
  morir "no puedo entrar como $SUDO_USER por el socket: sudo -u postgres createuser --superuser \"$SUDO_USER\""
ok "entrada de administrador por socket (peer) como ${SUDO_USER:-root}"

# El bootstrap del repositorio de trabajo tiene que haber corrido antes: de ahí
# salen las contraseñas de los roles (INSTALL.md §8.6).
for s in "${SERVICIOS[@]}"; do
  [[ -f "$ORIGEN/services/$s/.env" ]] || morir "falta $ORIGEN/services/$s/.env: corre antes 'npm run db:bootstrap' en el repositorio"
done
ok 'credenciales de los 8 servicios en el repositorio de trabajo'

# El clon despliega lo **commiteado**: si hay cambios sin guardar, avisar.
if [[ -n "$(git -C "$ORIGEN" status --porcelain)" ]]; then
  av "$ORIGEN tiene cambios sin commitear: NO se desplegarán (haz commit antes si los quieres)"
fi

# ── 1. Usuario de sistema y directorios (INSTALL.md §7) ──────────────────────
paso "1/7 · Usuario de sistema y directorios"
if getent passwd odontocrm >/dev/null; then
  ok 'el usuario odontocrm ya existe'
else
  useradd --system --create-home --home-dir /var/lib/odontocrm \
    --shell /usr/sbin/nologin --comment 'OdontoCRM · servicios Node (sin login)' \
    --user-group odontocrm
  ok 'usuario odontocrm creado'
fi
install -d -m 0755 -o root -g root "$DESTINO"
install -d -m 0750 -o odontocrm -g odontocrm /var/lib/odontocrm{,/storage,/ms-playwright,/tmp}
install -d -m 0750 -o odontocrm -g odontocrm /var/log/odontocrm
install -d -m 0750 -o root -g odontocrm /etc/odontocrm{,/keys}
install -d -m 0700 -o root -g root /var/backups/odontocrm
ok 'directorios y permisos listos (/opt, /var/lib, /var/log, /etc/odontocrm, /var/backups)'

# ── 2. Código en /opt/odontocrm (INSTALL.md §9.1-§9.2) ───────────────────────
paso "2/7 · Código desplegado y compilado"
if [[ -d "$DESTINO/.git" ]] && git -C "$DESTINO" rev-parse --verify HEAD >/dev/null 2>&1; then
  # El destino es una COPIA de despliegue: su rama local tiene que apuntar a lo
  # mismo que el origen. Hacer `fetch` y `checkout` no basta —la rama local no se
  # mueve sola—, así que se recrea desde `origin/$RAMA`.
  #
  # OJO: como root, git se niega a leer un repositorio de otro usuario («detected
  # dubious ownership») y el fetch falla → el despliegue se queda en el commit viejo
  # **en silencio**, que es la peor forma de fallar: parece que actualizaste y no.
  git config --global --add safe.directory "$ORIGEN" 2>/dev/null || true
  git config --global --add safe.directory "$DESTINO" 2>/dev/null || true
  if ! git -C "$DESTINO" fetch --quiet --prune origin 2>/tmp/ensayo-fetch.log; then
    av "no pude actualizar desde $ORIGEN:"
    sed 's/^/      /' /tmp/ensayo-fetch.log | head -4
  fi
  origen_sha="$(git -C "$ORIGEN" rev-parse --short "$RAMA" 2>/dev/null || echo '?')"
  if git -C "$DESTINO" rev-parse --verify "origin/$RAMA" >/dev/null 2>&1; then
    git -C "$DESTINO" checkout --quiet -B "$RAMA" "origin/$RAMA"
    destino_sha="$(git -C "$DESTINO" rev-parse --short HEAD)"
    if [[ "$destino_sha" == "$origen_sha" ]]; then
      ok "código actualizado a $destino_sha ($RAMA)"
    else
      morir "el destino quedó en $destino_sha y el origen está en $origen_sha: no se desplegó lo último. Se para aquí: probar código viejo da resultados que no valen."
    fi
  else
    av "la rama $RAMA no está en el origen: me quedo en $(git -C "$DESTINO" rev-parse --short HEAD)"
  fi
else
  # Un clon a medias (o un directorio suelto) se descarta: `--local` usa hard links
  # y /opt está en otro sistema de archivos, así que hay que pedir --no-hardlinks.
  if [[ -e "$DESTINO" ]]; then
    [[ "$DESTINO" == /opt/* ]] || morir "no borro $DESTINO: no está bajo /opt"
    av "descarto $DESTINO (clon incompleto) y vuelvo a clonar"
    rm -rf "$DESTINO"
  fi
  git clone --quiet --no-hardlinks "$ORIGEN" "$DESTINO" || morir 'falló el clonado'
  git -C "$DESTINO" checkout --quiet "$RAMA" 2>/dev/null || av "no pude cambiar a $RAMA"
fi
git -C "$DESTINO" log --oneline -1 | sed 's/^/    /'
chown -R root:root "$DESTINO"
chmod -R go-w "$DESTINO"
ok 'código en el destino, propietario root y sin escritura para el resto'

(cd "$DESTINO" && npm ci --silent) || morir 'falló npm ci'
(cd "$DESTINO" && npm run build >/dev/null 2>&1) || morir 'falló la compilación'
ok 'dependencias instaladas y código compilado'

# ── 3. Configuración: instalación, plantillas y secretos (INSTALL.md §8) ─────
paso "3/7 · /etc/odontocrm, unidades y secretos"
(cd "$DESTINO" && bash infra/fedora/install.sh --apply --supervisor=systemd --enable-services >/tmp/ensayo-install.log 2>&1) ||
  { tail -20 /tmp/ensayo-install.log; morir 'falló infra/fedora/install.sh --apply'; }
ok 'install.sh aplicado (usuario, plantillas, unidades, alertas y logrotate)'

# Secretos: de los .env del repositorio de trabajo a /etc/odontocrm (INSTALL.md §8.6).
for s in "${SERVICIOS[@]}"; do
  destino="/etc/odontocrm/$s.env"
  origen="$ORIGEN/services/$s/.env"
  [[ -f "$destino" ]] || morir "falta $destino (¿corrió install.sh?)"
  tmp="$(mktemp)"
  # Se trasladan los valores GENERADOS y, si están puestos, las credenciales del bot:
  # sin esto el despliegue se queda con el marcador `CAMBIAR_TOKEN_BOTFATHER`, que
  # cumple la longitud mínima y por eso el servicio dice «token configurado» para
  # luego no conectar (pasó en el ensayo de la Fase 10).
  # Se copia clave por clave: la del repositorio manda cuando existe y NO es un
  # marcador de plantilla; si no, se conserva la que ya tenía el archivo. Borrar y
  # reescribir solo lo que venga del repositorio dejaba el archivo incompleto (así se
  # perdió TELEGRAM_MODE, que el .env de desarrollo no define porque usa el valor por
  # defecto, y el ensayo avisaba de que faltaba).
  CLAVES='DATABASE_URL|EVENTS_DATABASE_URL|INTERNAL_SERVICE_SECRET|COOKIE_SECRET|TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_USERNAME|TELEGRAM_MODE|TELEGRAM_TEST_CHAT_ID|WHATSAPP_TOKEN|WHATSAPP_PHONE_ID|WHATSAPP_VERIFY_TOKEN|WHATSAPP_APP_SECRET'
  grep -vE "^($CLAVES)=" "$destino" >"$tmp"
  for clave in ${CLAVES//|/ }; do
    valor="$(sed -n "s/^${clave}=//p" "$origen" | head -1 || true)"
    if [[ -z "$valor" || "$valor" == CAMBIAR* ]]; then
      # Lo que no trae el repositorio se queda como estaba en la plantilla.
      valor="$(sed -n "s/^${clave}=//p" "$destino" | head -1 || true)"
      [[ -z "$valor" ]] && continue
    fi
    printf '%s=%s\n' "$clave" "$valor" >>"$tmp"
  done
  install -m 0600 -o root -g root "$tmp" "$destino"
  rm -f "$tmp"

  # Y se COMPRUEBA la credencial que se acaba de dejar, en vez de descubrirlo tres pasos más
  # tarde con un «password authentication failed» en las migraciones (que fue lo que pasó y
  # costó dos rondas de depuración). Si no autentica, se dice cuál y qué archivo revisar.
  url="$(sed -n 's/^DATABASE_URL=//p' "$destino" | head -1 || true)"
  if [[ -n "$url" ]]; then
    if psql "$url" -tAc 'select 1' >/dev/null 2>&1; then
      ok "  $s: la credencial de /etc/odontocrm/$s.env conecta"
    else
      av "  $s: la credencial de /etc/odontocrm/$s.env NO conecta (¿el bootstrap regeneró las"
      av "      contraseñas y este archivo quedó con las viejas? Mira $origen y /etc/odontocrm/$s.env)"
    fi
  fi
done
# El gateway comparte el secreto interno de identity (no tiene base de datos).
SECRETO="$(sed -n 's/^INTERNAL_SERVICE_SECRET=//p' /etc/odontocrm/identity.env || true)"
sed -i "s|^INTERNAL_SERVICE_SECRET=.*|INTERNAL_SERVICE_SECRET=${SECRETO}|" /etc/odontocrm/gateway.env
# Permisos del plan §11: los lee systemd como root, el servicio no los toca.
chown root:root /etc/odontocrm/*.env
chmod 0600 /etc/odontocrm/*.env
ok 'secretos trasladados a /etc/odontocrm/*.env (0600 root:root)'

# Valores que impiden arrancar: se avisan con nombre y apellido antes de migrar.
for par in "notifications:TELEGRAM_MODE" "odontocrm:TEST_MODE" "odontocrm:ALLOW_TEST_MODE"; do
  archivo="/etc/odontocrm/${par%%:*}.env"; clave="${par##*:}"
  valor="$(sed -n "s/^${clave}=//p" "$archivo" | head -1 || true)"
  if [[ -n "$valor" ]]; then ok "$archivo → $clave=$valor"; else av "$archivo no define $clave"; fi
done

# El token del bot, sin imprimirlo: solo se dice si es real o si sigue el marcador.
if grep -qE '^TELEGRAM_BOT_TOKEN=CAMBIAR' /etc/odontocrm/notifications.env 2>/dev/null; then
  av 'el token del bot sigue siendo el marcador de la plantilla: el servicio dirá «token configurado» y no conectará'
  av 'ponlo en /etc/odontocrm/notifications.env y reinicia: systemctl restart odontocrm@notifications'
elif grep -qE '^TELEGRAM_BOT_TOKEN=.{20,}' /etc/odontocrm/notifications.env 2>/dev/null; then
  ok 'token del bot puesto (no se imprime)'
else
  av 'no hay token del bot: los avisos quedarán como pendientes manuales (es válido si aún no hay bot)'
fi

# Claves EdDSA: se copian las del repositorio de trabajo (las mismas que ya usan
# los servicios en desarrollo) para no invalidar la sesión de nadie.
if [[ -f "$ORIGEN/services/identity/.keys/jwt-private.pem" ]]; then
  install -m 0640 -o root -g odontocrm "$ORIGEN/services/identity/.keys/jwt-private.pem" /etc/odontocrm/keys/jwt-private.pem
  install -m 0644 -o root -g root "$ORIGEN/services/identity/.keys/jwt-public.pem" /etc/odontocrm/keys/jwt-public.pem
  ok 'claves EdDSA copiadas a /etc/odontocrm/keys'
else
  av 'no encontré .keys/ en el repositorio: corre "npm run keys:generate" antes'
fi

# Chromium para los PDF (INSTALL.md §9.5): se reutiliza el del usuario que ensaya.
# Chromium para los PDF: tiene que estar DONDE EL SERVICIO LO BUSCA Y PODER EJECUTARSE.
# (En el ensayo, la exportación a PDF devolvía 503 porque `reporting.env` no llevaba la
# ruta y el navegador no se encontraba: se copiaba, pero nadie lo comprobaba.)
if [[ -d "$HOME_REAL/.cache/ms-playwright" ]]; then
  cp -a "$HOME_REAL/.cache/ms-playwright/." /var/lib/odontocrm/ms-playwright/ 2>/dev/null || true
  chown -R odontocrm:odontocrm /var/lib/odontocrm/ms-playwright
  NAVEGADOR="$(find /var/lib/odontocrm/ms-playwright -maxdepth 3 -type f -name chrome -o -maxdepth 3 -type f -name headless_shell 2>/dev/null | head -1 || true)"
  if [[ -n "$NAVEGADOR" ]] && sudo -u odontocrm test -x "$NAVEGADOR" 2>/dev/null; then
    ok "navegador de Playwright desplegado y ejecutable por odontocrm ($NAVEGADOR)"
  else
    av "el navegador de Playwright NO quedó ejecutable en /var/lib/odontocrm/ms-playwright: los PDF fallarán"
  fi
fi

# ── 4. Migraciones (INSTALL.md §9.3) ─────────────────────────────────────────
paso "4/7 · Migraciones"
for s in "${SERVICIOS[@]}"; do
  # Se inyecta el entorno del servicio (los .env del código NO viven en /opt).
  # `tools/con-entorno.mjs` carga los .env sin interpretarlos como shell (ver el encabezado
  # de ese archivo: `source` vaciaba WEB_ORIGIN por el espacio tras la coma, y expandía las
  # contraseñas con `$`).
  (cd "$DESTINO" && NODE_ENV=production node tools/con-entorno.mjs /etc/odontocrm "$s" -- \
    node "services/$s/dist/db/migrate.js") >/tmp/ensayo-migrar-$s.log 2>&1 ||
    { echo "    --- /tmp/ensayo-migrar-$s.log ---"; tail -25 "/tmp/ensayo-migrar-$s.log" | sed 's/^/    /'; morir "fallaron las migraciones de $s"; }
  ok "migraciones de $s"
done

# ── 5. Servicios (INSTALL.md §10) ────────────────────────────────────────────
paso "5/7 · Arranque con systemd"
systemctl daemon-reload
systemctl enable --now postgresql >/dev/null 2>&1 || true
for s in "${SERVICIOS[@]}"; do
  # `restart` (no `enable --now`): si ya estaban corriendo con el entorno viejo, hay
  # que volver a leer /etc/odontocrm.
  systemctl enable "odontocrm@$s.service" >/dev/null 2>&1 || true
  systemctl restart "odontocrm@$s.service" >/dev/null 2>&1 || av "no pude arrancar odontocrm@$s"
done
systemctl enable odontocrm-gateway.service >/dev/null 2>&1 || true
systemctl restart odontocrm-gateway.service >/dev/null 2>&1 || av 'no pude arrancar el gateway'
systemctl enable --now odontocrm-alertas.timer >/dev/null 2>&1 || av 'no pude habilitar el temporizador de alertas'

sleep 8
FALLOS=0
# El puerto tiene que estar ocupado por el proceso **de la unidad**, no por otro
# (una pila de desarrollo, un proceso suelto): si no, un /health 200 engaña.
declare -A PUERTO_DE=([identity]=4001 [patients]=4002 [scheduling]=4003 [notifications]=4004 [clinical]=4005 [odontogram]=4006 [screens]=4007 [reporting]=4008)
for s in "${SERVICIOS[@]}"; do
  puerto="${PUERTO_DE[$s]}"
  unidad="odontocrm@$s"
  activa="$(systemctl is-active "$unidad.service" 2>/dev/null || true)"
  pid_unidad="$(systemctl show -p MainPID --value "$unidad.service" 2>/dev/null || echo 0)"
  pid_puerto="$(ss -lntpH "sport = :$puerto" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$puerto/health" || echo 000)"
  if [[ "$activa" != "active" ]]; then
    err "$unidad: estado $activa (no active)"; FALLOS=$((FALLOS+1))
  elif [[ "$pid_puerto" != "$pid_unidad" ]]; then
    err "puerto $puerto: lo ocupa el PID ${pid_puerto:-ninguno}, no $unidad (PID $pid_unidad)"; FALLOS=$((FALLOS+1))
  elif [[ "$codigo" == "200" ]]; then
    ok "$unidad activa y sirviendo el puerto $puerto → /health 200"
  else
    err "$unidad activa en $puerto pero /health → $codigo"; FALLOS=$((FALLOS+1))
  fi
done
puerto_gw="$(systemctl show -p MainPID --value odontocrm-gateway.service 2>/dev/null || echo 0)"
pid_gw="$(ss -lntpH 'sport = :8090' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [[ "$(systemctl is-active odontocrm-gateway.service 2>/dev/null)" == "active" && "$pid_gw" == "$puerto_gw" ]]; then
  ok "odontocrm-gateway activo y sirviendo el 8090 → /health $(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8090/health)"
else
  err "el gateway no está activo o el 8090 lo ocupa otro proceso"; FALLOS=$((FALLOS+1))
fi
(( FALLOS == 0 )) || { av "hay $FALLOS servicios con problemas: journalctl -u odontocrm@<servicio> -n 50 --no-pager"; av 'si dice EADDRINUSE, hay otra pila en los puertos: npm run stack:down'; }

# La tabla de estado, con los entornos de producción.
# Los PDF se generan con Chromium bajo la unidad endurecida: se prueba de verdad,
# exportando un reporte por el proxy (es lo que destapa una ruta de navegador mal
# puesta, que en el ensayo daba 503 sin que nada más fallara).
if [[ "$HASTA" == "tls" || "$HASTA" == "respaldos" ]]; then
  CLAVE_ADMIN="${SEED_PASSWORD_ADMIN:-admin-odontocrm-2026}"
  for intento in "$CLAVE_ADMIN" "prueba-e2e-odontocrm-2026"; do
    TOKEN="$(curl -sk --max-time 8 -X POST https://127.0.0.1/api/v1/auth/login \
      -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$intento\"}" |
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("accessToken",""))' 2>/dev/null)"
    [[ -n "$TOKEN" ]] && break
  done
  if [[ -z "$TOKEN" ]]; then
    av 'no probé la exportación a PDF: la contraseña sembrada de admin ya no es válida (se cambió desde la interfaz)'
  else
    codigo_pdf="$(curl -sk -o /tmp/ensayo-pdf.pdf -w '%{http_code}' --max-time 90 \
      -H "authorization: Bearer $TOKEN" \
      "https://127.0.0.1/api/v1/reports/oral-health/export.pdf?desde=2026-01-01&hasta=2026-12-31" || echo 000)"
    if [[ "$codigo_pdf" == "200" ]] && head -c 5 /tmp/ensayo-pdf.pdf | grep -q '%PDF-'; then
      ok "Chromium genera PDF bajo systemd (exportación de reporte: $(wc -c </tmp/ensayo-pdf.pdf) bytes)"
    else
      av "la exportación a PDF devolvió $codigo_pdf (mira PLAYWRIGHT_BROWSERS_PATH en /etc/odontocrm/reporting.env)"
    fi
  fi
fi

# Comprobación explícita de la cola compartida: sin ella, los servicios no se ven.
for s in "${SERVICIOS[@]}"; do
  grep -q '^EVENTS_DATABASE_URL=' "/etc/odontocrm/$s.env" || av "/etc/odontocrm/$s.env no tiene EVENTS_DATABASE_URL (la cola compartida)"
done

if [[ -x "$DESTINO/tools/estado.mjs" || -f "$DESTINO/tools/estado.mjs" ]]; then
  ODONTOCRM_ENV_DIR=/etc/odontocrm node "$DESTINO/tools/estado.mjs" --alertas &&
    ok 'npm run estado --alertas: sin problemas' || av 'el tablero de estado reportó problemas (ver arriba)'
fi

# ── 6. TLS interno y proxy (INSTALL.md §11-§13), opcional ────────────────────
if [[ "$HASTA" == "tls" || "$HASTA" == "respaldos" ]]; then
  paso "6/7 · firewalld, certificado interno y reverse proxy (INSTALL.md §12 y §13)"

  # Nombre e IP que van a teclear los equipos de la clínica. Por defecto, el
  # nombre bonito + la IP de la LAN de esta máquina.
  IP_LAN="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
  [[ -n "$IP_LAN" ]] || IP_LAN="$(hostname -I 2>/dev/null | awk '{print $1}')"
  # Si no dicen la red, se usa la /24 de esta máquina (443 abierto solo ahí).
  if [[ -z "$LAN_CIDR" && -n "$IP_LAN" ]]; then
    LAN_CIDR="$(ip -o -f inet addr show dev "${IFACE_LAN:-$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1)}" 2>/dev/null | awk 'NR==1 {print $4; exit}' || true)"
    av "sin --lan-cidr: uso la red de esta máquina ($LAN_CIDR) para abrir 443"
  fi
  HOSTS_TLS=(odontocrm.local localhost 127.0.0.1)
  [[ -n "$IP_LAN" ]] && HOSTS_TLS+=("$IP_LAN")
  SERVICIO_HTTP="${HOSTS_TLS[0]}"
  ok "el certificado cubrirá: ${HOSTS_TLS[*]}"

  # 1) Certificado interno con mkcert (idempotente: si ya existe, lo rehace).
  if ! command -v mkcert >/dev/null; then
    av 'mkcert no está instalado: sudo dnf install -y mkcert nss-tools'
  else
    mkcert -install >/dev/null 2>&1 || true
    install -d -m 0755 /etc/pki/tls/certs /etc/pki/tls/private
    mkcert -key-file /etc/pki/tls/private/odontocrm.key \
           -cert-file /etc/pki/tls/certs/odontocrm.crt "${HOSTS_TLS[@]}" >/dev/null 2>&1 &&
      ok 'certificado emitido en /etc/pki/tls/{certs,private}/odontocrm.*' ||
      av 'no pude emitir el certificado con mkcert'
    chmod 0600 /etc/pki/tls/private/odontocrm.key
    chown root:root /etc/pki/tls/private/odontocrm.key

    # La CA interna, en un sitio estable y dentro del respaldo de configuración: sin
    # ella no se puede quitar el aviso en los demás equipos, y si se pierde hay que
    # emitir certificados nuevos en todos.
    CA_MKCERT="$(mkcert -CAROOT 2>/dev/null)/rootCA.pem"
    if [[ -f "$CA_MKCERT" ]]; then
      install -d -m 0755 /etc/odontocrm/keys
      install -m 0644 -o root -g root "$CA_MKCERT" /etc/odontocrm/keys/odontocrm-ca.crt
      # Copia PÚBLICA: nginx corre como usuario `nginx` y /etc/odontocrm es
      # `0750 root:odontocrm`, así que servirla desde ahí daba 403 en texto plano.
      install -d -m 0755 /var/www/odontocrm/ca
      install -m 0644 -o root -g root "$CA_MKCERT" /var/www/odontocrm/ca/odontocrm-ca.crt
      if command -v semanage >/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        semanage fcontext -a -t httpd_sys_content_t '/var/www/odontocrm(/.*)?' 2>/dev/null ||
          semanage fcontext -m -t httpd_sys_content_t '/var/www/odontocrm(/.*)?' 2>/dev/null || true
        restorecon -R /var/www/odontocrm 2>/dev/null || true
      fi
      ok 'CA interna copiada (respaldo y copia pública para nginx)'
    else
      av "no encuentro la CA de mkcert en $CA_MKCERT: los equipos no podrán confiar sin aviso"
    fi
  fi

  # 2) Proxy inverso: lo instala el script del repositorio, el mismo que usa la guía.
  if [[ -f "$DESTINO/infra/fedora/nginx/instalar.sh" ]]; then
    bash "$DESTINO/infra/fedora/nginx/instalar.sh" --host="${SERVICIO_HTTP} ${IP_LAN:-127.0.0.1}" |
      sed 's/^/  /'
  else
    av 'no encuentro infra/fedora/nginx/instalar.sh en el código desplegado'
  fi

  # 3) SELinux: nginx tiene que poder salir al gateway y leer la SPA.
  if command -v getenforce >/dev/null && [[ "$(getenforce)" == "Enforcing" ]]; then
    setsebool -P httpd_can_network_connect on 2>/dev/null &&
      ok 'SELinux: httpd_can_network_connect activado (nginx → 127.0.0.1:8090)' ||
      av 'no pude activar httpd_can_network_connect'
    if command -v semanage >/dev/null; then
      semanage fcontext -a -t httpd_sys_content_t "$DESTINO/apps/web/dist(/.*)?" 2>/dev/null ||
        semanage fcontext -m -t httpd_sys_content_t "$DESTINO/apps/web/dist(/.*)?" 2>/dev/null || true
      restorecon -R "$DESTINO/apps/web/dist" 2>/dev/null &&
        ok "SELinux: $DESTINO/apps/web/dist etiquetado como httpd_sys_content_t" ||
        av 'no pude etiquetar la SPA'
    else
      av 'falta semanage (policycoreutils-python-utils): la SPA puede dar 403'
    fi
  else
    av 'SELinux no está en Enforcing: no se toca'
  fi

  # 4) firewalld: solo el proxy (443 y 80). Nada de 5432 ni de 4001-4008.
  #
  # Se abre en la **zona** de la interfaz de la red local, no para un rango de IPs: así
  # sigue valiendo cuando cambia la red (el PC de pruebas en otro wifi, o el consultorio
  # si algún día le cambian el rango), sin tocar nada. Con `--lan-cidr=<red>` se hace al
  # revés, con una regla estricta para ese rango: es lo recomendable en la clínica, donde
  # la IP es reservada y fija.
  if systemctl is-active --quiet firewalld || systemctl is-enabled --quiet firewalld 2>/dev/null; then
    systemctl enable --now firewalld >/dev/null 2>&1 || true
    if [[ -n "$LAN_CIDR" ]]; then
      firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${LAN_CIDR} port port=443 protocol=tcp accept" >/dev/null
      firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
      modo_fw="rango estricto $LAN_CIDR"
    else
      IFACE_LAN="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1 || true)"
      ZONA_LAN="$(firewall-cmd --get-zone-of-interface="${IFACE_LAN}" 2>/dev/null || echo public)"
      [[ -n "$ZONA_LAN" && "$ZONA_LAN" != "no" ]] || ZONA_LAN=public
      firewall-cmd --permanent --zone="$ZONA_LAN" --add-service=https >/dev/null 2>&1 || true
      firewall-cmd --permanent --zone="$ZONA_LAN" --add-service=http >/dev/null 2>&1 || true
      modo_fw="zona «$ZONA_LAN» (sigue a la interfaz ${IFACE_LAN:-?}: vale en cualquier red)"
    fi
    firewall-cmd --reload >/dev/null
    ok "firewalld: 443/tcp (y 80 para el redirect) abiertos — $modo_fw"
    for puerto in 5432 4001 4002 4003 4004 4005 4006 4007 4008 8090; do
      if firewall-cmd --list-ports 2>/dev/null | grep -q "\b${puerto}/tcp\b"; then
        av "el $puerto está ABIERTO en firewalld y no debería (solo 127.0.0.1)"
      fi
    done
    ok 'comprobado que la base y los servicios internos no están publicados'
  else
    av 'firewalld no está activo en esta máquina: no se toca'
  fi

  # 5) Arrancar y probar de verdad contra https.
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl restart nginx >/dev/null 2>&1 || av 'no pude reiniciar nginx'
  sleep 2
  codigo_spa="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 https://127.0.0.1/ || echo 000)"
  codigo_api="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 https://127.0.0.1/api/v1/meta || echo 000)"
  codigo_http="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 -H 'Host: 127.0.0.1' http://127.0.0.1/ || echo 000)"
  [[ "$codigo_spa" == "200" ]] && ok 'la SPA se sirve por https (200)' || err "la SPA devolvió $codigo_spa"
  [[ "$codigo_api" == "200" ]] && ok 'la API llega por el proxy (200)' || err "la API devolvió $codigo_api"
  [[ "$codigo_http" == "301" ]] && ok 'http redirige a https (301)' || av "http devolvió $codigo_http (esperaba 301)"
  grep -q '/var/www/odontocrm' /etc/nginx/conf.d/odontocrm.conf 2>/dev/null &&
    ok 'el proxy sirve la CA desde la copia pública (nginx puede leerla)' ||
    av 'la configuración del proxy apunta a /etc/odontocrm: nginx dará 403 (ejecuta nginx/instalar.sh)'
  ca_http="$(curl -s -o /tmp/ensayo-ca.crt -w '%{http_code}' --max-time 6 http://127.0.0.1/ca.crt || echo 000)"
  if [[ "$ca_http" == "200" ]] && openssl x509 -in /tmp/ensayo-ca.crt -noout -subject >/dev/null 2>&1; then
    ok "la CA se descarga desde http://<servidor>/ca.crt ($(openssl x509 -in /tmp/ensayo-ca.crt -noout -subject 2>/dev/null | head -c 40)…)"
  else
    av "no pude descargar la CA en /ca.crt (código $ca_http): los equipos tendrían que copiarla a mano"
  fi
  # El SSE necesita token de pantalla: sin él, un 401 ya demuestra que el proxy
  # llega al servicio de pantallas (un 404 sería la location mal puesta).
  sse="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Accept: text/event-stream' \
        "https://127.0.0.1/api/v1/screens/lobby/stream" || echo 000)"
  case "$sse" in
    200) ok 'el SSE de las pantallas responde 200 por el proxy' ;;
    401|403) ok "el SSE llega al servicio de pantallas ($sse sin token: correcto)" ;;
    404) err 'el SSE devuelve 404: la location /api/v1/screens/ no está bien puesta' ;;
    *) av "el SSE devolvió $sse (se comprueba con una pantalla real en §13.5)" ;;
  esac

  # 6) La URL pública tiene que ser la del proxy (CORS y el QR del récipe).
  # El CORS admite varios orígenes separados por comas: se ponen el NOMBRE y la IP,
  # que son las dos formas en que entra un equipo de la clínica.
  ORIGENES="https://${SERVICIO_HTTP}"
  [[ -n "$IP_LAN" ]] && ORIGENES="${ORIGENES}, https://${IP_LAN}"
  for par in "odontocrm:WEB_ORIGIN" "clinical:PUBLIC_APP_URL"; do
    archivo="/etc/odontocrm/${par%%:*}.env"; clave="${par##*:}"
    if grep -qE "^${clave}=https://CAMBIAR" "$archivo" 2>/dev/null; then
      if [[ "$clave" == "WEB_ORIGIN" ]]; then
        sed -i "s|^${clave}=.*|${clave}=${ORIGENES}|" "$archivo"
        ok "$clave=$ORIGENES en $archivo (nombre e IP: entran las dos)"
      else
        sed -i "s|^${clave}=.*|${clave}=https://${SERVICIO_HTTP}|" "$archivo"
        ok "$clave=https://${SERVICIO_HTTP} en $archivo (lo usa el QR del récipe)"
      fi
      REINICIAR_POR_TLS=1
    fi
  done
  if [[ "${REINICIAR_POR_TLS:-0}" == "1" ]]; then
    systemctl restart odontocrm@clinical.service odontocrm-gateway.service odontocrm@identity.service >/dev/null 2>&1 || true
    sleep 4
    ok 'clinical, gateway e identity reiniciados para releer la URL pública'
  fi

  # 7) Que SELinux no esté bloqueando nada en silencio.
  if command -v ausearch >/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    denegaciones="$(ausearch -m avc -ts today 2>/dev/null | grep -c 'denied' || true)"
    if [[ "${denegaciones:-0}" == "0" ]]; then ok 'SELinux: sin denegaciones hoy'
    else av "SELinux: $denegaciones denegaciones hoy — ausearch -m avc -ts today | tail -20"; fi
  fi
else
  paso "6/7 · TLS (omitido: usa --hasta=tls --lan-cidr=<tu red>)"
fi

# ── 7. Respaldos (INSTALL.md §15-§16), opcional ──────────────────────────────
if [[ "$HASTA" == "respaldos" ]]; then
  paso "7/7 · Respaldo y prueba de restauración (INSTALL.md §15 y §16)"

  # 1) El rol de respaldo, con su .pgpass (una sola vez; idempotente).
  bash "$DESTINO/infra/fedora/backup/crear-rol-respaldo.sh" --admin-role="${USUARIO_REAL}" 2>&1 | sed 's/^/  /' ||
    av 'no pude preparar el rol de respaldo (revisa INSTALL.md §15.2)'

  # 2) El respaldo.
  # Con tope de tiempo: un respaldo o un restablecimiento NO pueden quedarse mudos
  # indefinidamente (ver RUNBOOK: qué hacer si el restablecimiento se atasca).
  if timeout 1800 bash "$DESTINO/infra/fedora/backup/odontocrm-backup.sh" --include-config >/tmp/ensayo-backup.log 2>&1; then
    ok 'respaldo ejecutado (--include-config)'
    grep -E "Respaldo (correcto|completado)|bases|Destino" /tmp/ensayo-backup.log | tail -4 | sed 's/^/    /'
  else
    err 'falló el respaldo'; tail -12 /tmp/ensayo-backup.log | sed 's/^/    /'
  fi

  ULTIMO="$(ls -1dt /var/backups/odontocrm/*/ 2>/dev/null | head -1 || true)"
  if [[ -n "$ULTIMO" ]]; then
    du -sh "$ULTIMO" 2>/dev/null | sed 's/^/    /'

    # 3) Ensayo en seco: explica qué haría sin tocar nada (queda en el registro).
    timeout 600 bash "$DESTINO/infra/fedora/backup/odontocrm-restore.sh" --from "$ULTIMO" --all --yes --dry-run \
      >/tmp/ensayo-restore-seco.log 2>&1 && ok 'ensayo en seco del restablecimiento (--dry-run)' ||
      av 'el ensayo en seco devolvió error (ver /tmp/ensayo-restore-seco.log)'

    # 4) La prueba de verdad: restaura a <base>__verif y CONSERVA esas bases como
    #    evidencia (--keep-verify-db), sin tocar las de producción.
    if timeout 3600 bash "$DESTINO/infra/fedora/backup/odontocrm-restore.sh" --from "$ULTIMO" --all --yes --keep-verify-db \
         >/tmp/ensayo-restore.log 2>&1; then
      ok 'restablecimiento verificado en las 8 bases temporales __verif'
    else
      err 'la verificación del restablecimiento falló'; tail -15 /tmp/ensayo-restore.log | sed 's/^/    /'
    fi

    # 5) Evidencia: mismas tablas y mismas filas en la base real y en la restaurada.
    echo
    echo "    Filas por base (real → restaurada):"
    URL_BASE() { printf 'postgres:///%s?host=/var/run/postgresql' "$1"; }
    total_real=0; total_verif=0
    for base in odonto_identity odonto_patients odonto_scheduling odonto_notifications odonto_clinical odonto_odontogram odonto_screens odonto_reporting; do
      psql -d "postgres:///postgres?host=/var/run/postgresql" -tAc "select 1 from pg_database where datname='${base}__verif'" | grep -q 1 || continue
      # Los contadores de pg_stat pueden estar desactualizados: se cuenta de verdad.
      contar() {
        local db="$1" suma=0 n tabla
        for tabla in $(psql -d "$(URL_BASE "$db")" -tAc "select tablename from pg_tables where schemaname='public'" 2>/dev/null); do
          n="$(psql -d "$(URL_BASE "$db")" -tAc "select count(*) from \"$tabla\"" 2>/dev/null || echo 0)"
          suma=$((suma + n))
        done
        echo "$suma"
      }
      real="$(contar "$base")"; verif="$(contar "${base}__verif")"
      total_real=$((total_real + real)); total_verif=$((total_verif + verif))
      if [[ "$real" == "$verif" ]]; then
        ok "$base: $real filas → $verif en la restaurada"
      else
        av "$base: $real filas en la real y $verif en la restaurada (revisar)"
      fi
    done
    echo "    Total: $total_real filas en producción → $total_verif en las restauradas"

    # 6) Las bases __verif quedan como evidencia; se dice cómo borrarlas.
    echo
    av "las bases __verif se han conservado como evidencia:"
    echo "      para borrarlas cuando ya no hagan falta:"
    echo "      psql -d postgres:///postgres?host=/var/run/postgresql -c 'drop database \"odonto_identity__verif\"'   # y las demás"
    echo "      (o: sudo bash $DESTINO/infra/fedora/backup/odontocrm-restore.sh --limpiar-verif)"
  else
    av 'no encuentro ningún respaldo en /var/backups/odontocrm'
  fi

  # 7) Dejar el temporizador de respaldos programado (si existe la unidad).
  if systemctl list-unit-files 'odontocrm-backup*' >/dev/null 2>&1 &&
     [[ -n "$(systemctl list-unit-files 'odontocrm-backup*' --no-legend 2>/dev/null)" ]]; then
    systemctl enable --now odontocrm-backup.timer >/dev/null 2>&1 && ok 'temporizador de respaldos activado'
  else
    av 'no hay unidad de temporizador de respaldos (se programa con cron/timer, INSTALL.md §15.4)'
  fi
else
  paso "7/7 · Respaldos (omitido: usa --hasta=respaldos)"
fi

# ── Resumen ──────────────────────────────────────────────────────────────────
paso "Resumen"
echo "    Código:        $DESTINO ($(git -C "$DESTINO" rev-parse --short HEAD 2>/dev/null))"
echo "    Configuración: /etc/odontocrm/*.env (0600 root:root)"
echo "    Servicios:     $(systemctl list-units --type=service --state=running --all 'odontocrm*' --no-legend | wc -l) en marcha (de 9)"
echo "    Tablero:       ODONTOCRM_ENV_DIR=/etc/odontocrm node $DESTINO/tools/estado.mjs"
echo "    Logs:          journalctl -u odontocrm@clinical -n 50 --no-pager"
if (( REINICIAR )); then
  av 'Reinicio pedido con --reiniciar: guarda lo que estés haciendo; la máquina vuelve en unos segundos.'
  if command -v systemctl >/dev/null; then
    sleep 3
    systemctl reboot || err 'no pude reiniciar: hazlo a mano con «sudo systemctl reboot»'
    ok 'reinicio pedido al sistema'
  else
    err 'no hay systemctl: reinicia a mano'
  fi
fi
echo
