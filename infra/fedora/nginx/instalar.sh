#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · instalar el reverse proxy con TLS interno (Fedora · Fase 10)
#
#   sudo bash infra/fedora/nginx/instalar.sh [--host="odontocrm.local 192.168.1.50"]
#
# Hace tres cosas, en este orden y de forma idempotente:
#
#   1. Desactiva el `default_server` que Fedora trae en /etc/nginx/nginx.conf
#      (su página de prueba contesta en el puerto 80 y tapa el redirect a HTTPS).
#      Se comentan solo las dos líneas `listen`, así el bloque queda inerte y el
#      cambio es reversible de un vistazo.
#   2. Copia el proxy versionado (nginx/odontocrm.conf) sustituyendo `__HOST__`
#      por el nombre y la IP del servidor.
#   3. Comprueba la sintaxis y arranca nginx.
#
# El certificado tiene que existir ANTES (INSTALL.md §13.2): este script no lo
# emite, para no pisar un certificado propio de la clínica.
# =============================================================================
set -uo pipefail

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


C_OK=$'\e[32m'; C_AV=$'\e[33m'; C_ER=$'\e[31m'; C_TI=$'\e[1m'; C_RE=$'\e[0m'
ok()   { printf '  %s✔%s %s\n' "$C_OK" "$C_RE" "$1"; }
av()   { printf '  %s!%s %s\n' "$C_AV" "$C_RE" "$1"; }
err()  { printf '  %s✖%s %s\n' "$C_ER" "$C_RE" "$1"; }
morir(){ err "$1"; exit 1; }

[[ $EUID -eq 0 ]] || morir 'hay que ejecutarlo como root (sudo)'

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC_DIR="${ODONTOCRM_ENV_DIR:-/etc/odontocrm}"
CONF_ORIGEN="$AQUI/odontocrm.conf"
CONF_DESTINO="/etc/nginx/conf.d/odontocrm.conf"
CERT="/etc/pki/tls/certs/odontocrm.crt"
CLAVE="/etc/pki/tls/private/odontocrm.key"
HOST=""

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    *) morir "argumento no reconocido: $arg" ;;
  esac
done

printf '%sOdontoCRM · reverse proxy (nginx)%s\n' "$C_TI" "$C_RE"

command -v nginx >/dev/null || morir 'nginx no está instalado: sudo dnf install -y nginx'
[[ -f "$CONF_ORIGEN" ]] || morir "no encuentro $CONF_ORIGEN"
[[ -f "$CERT" && -f "$CLAVE" ]] || morir "faltan el certificado o su clave ($CERT, $CLAVE): hazlo primero (INSTALL.md §13.2)"

if [[ -z "$HOST" ]]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
  [[ -n "$IP" ]] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  HOST="odontocrm.local${IP:+ $IP}"
fi
ok "server_name: $HOST"

# ── 1. Fedora: quitar de en medio su default_server del puerto 80 ────────────
NGINX_CONF="/etc/nginx/nginx.conf"
if grep -qE '^[[:space:]]*listen[[:space:]]+(\[::\]:)?80[[:space:]]+default_server' "$NGINX_CONF"; then
  cp -n "$NGINX_CONF" "$NGINX_CONF.odontocrm-orig" 2>/dev/null || true
  sed -i -E 's|^([[:space:]]*)(listen[[:space:]]+(\[::\]:)?80[[:space:]]+default_server;.*)$|\1# \2  # OdontoCRM: lo sirve conf.d/odontocrm.conf|' "$NGINX_CONF"
  ok 'desactivado el default_server de Fedora (página de prueba del puerto 80)'
else
  ok 'el default_server de Fedora ya estaba desactivado'
fi

# ── 2. El proxy versionado, con el nombre del servidor ───────────────────────
#
# El puerto 80 tiene que quedar en NUESTRAS manos. Dos casos, medidos en la Fase 10:
#   a) Fedora trae `listen 80 default_server` → se comenta (arriba) y ya está.
#   b) Fedora trae solo `listen 80;` y `server_name _;` → **no** hay default_server
#      explícito, así que gana el primer bloque del puerto (el suyo) y quien escriba
#      `http://127.0.0.1` ve su página de prueba. Se resuelve declarando el nuestro
#      como `default_server`: así el redirect vale para cualquier nombre o IP.
install -d -m 0755 /etc/nginx/conf.d
nuestro_default=0
if grep -qE '^[[:space:]]*listen[[:space:]]+(\[::\]:)?80' /etc/nginx/nginx.conf &&
   ! grep -qE 'listen[[:space:]]+(\[::\]:)?80[[:space:]]+default_server' /etc/nginx/nginx.conf; then
  nuestro_default=1
  ok 'Fedora no declara default_server en el 80: el nuestro pasa a serlo'
else
  ok 'el puerto 80 queda sin competencia (el bloque de Fedora está desactivado)'
fi

{
  echo "# Generado por infra/fedora/nginx/instalar.sh desde odontocrm.conf."
  echo "# No lo edite aquí: cambie el archivo del repositorio y vuelva a ejecutarlo."
  if (( nuestro_default )); then
    sed -e "s|__HOST__|${HOST}|g" \
        -e 's|\(listen[[:space:]]*\(\[::\]:\)\?80\)[[:space:]]*;|\1 default_server;|' \
        "$CONF_ORIGEN"
  else
    sed "s|__HOST__|${HOST}|g" "$CONF_ORIGEN"
  fi
} >"$CONF_DESTINO"
chmod 0644 "$CONF_DESTINO"
ok "instalado $CONF_DESTINO"
grep -q 'listen 80 default_server;' "$CONF_DESTINO" && ok 'el redirect de http→https es el que decide' || true

# ── 2-bis. Publicar la CA donde nginx SÍ pueda leerla ───────────────────────
#
# `/etc/odontocrm` es `0750 root:odontocrm` y nginx corre como usuario `nginx`: no puede
# ni atravesarlo, así que servir la CA desde ahí daba **403 en texto plano** (error de
# nginx, no de la aplicación). La CA es un certificado **público**, así que se copia a
# /var/www/odontocrm/ca/ (0755) y se etiqueta para SELinux.
# IP del servidor para los scripts de un solo comando (se toma del argumento --host si
# trae una IP, y si no de la interfaz por la que sale la red local).
HOST_IP="$(printf '%s' "${HOST:-}" | grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' | head -1 || true)"
[[ -n "$HOST_IP" ]] || HOST_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
[[ -n "$HOST_IP" ]] || HOST_IP="SERVIDOR"

CA_PUBLICA="/var/www/odontocrm/ca/odontocrm-ca.crt"
CA_ORIGEN="$ETC_DIR/keys/odontocrm-ca.crt"
[[ -f "$CA_ORIGEN" ]] || CA_ORIGEN="${CAROOT:-/root/.local/share/mkcert}/rootCA.pem"
if [[ -f "$CA_ORIGEN" ]]; then
  install -d -m 0755 /var/www/odontocrm/ca
  install -m 0644 -o root -g root "$CA_ORIGEN" "$CA_PUBLICA"
  ok "CA publicada en $CA_PUBLICA (legible por nginx)"

  # ── La CA en el formato que pide cada plataforma ──────────────────────────
  #
  # No todos los aparatos tragan lo mismo, y el que falla se queda con el aviso de
  # certificado sin saber por qué:
  #   · Android y Linux leen PEM (`ca.crt`) tal cual.
  #   · Windows prefiere DER (`ca.der`): se instala con doble clic.
  #   · iOS/iPadOS y macOS instalan un **perfil** (`odontocrm.mobileconfig`): es la vía
  #     correcta y la única que además deja el certificado en el llavero del sistema.
  #     Se sirve con `Content-Type: application/x-apple-aspen-config`, o Safari lo
  #     muestra como texto en vez de ofrecer instalarlo.
  CA_DIR="/var/www/odontocrm/ca"
  if openssl x509 -in "$CA_PUBLICA" -outform DER -out "$CA_DIR/odontocrm-ca.der" 2>/dev/null; then
    chmod 0644 "$CA_DIR/odontocrm-ca.der"
    ok 'CA en DER publicada (odontocrm-ca.der: doble clic en Windows)'
  else
    av 'no pude generar el DER de la CA (Windows tendrá que usar el .crt)'
  fi

  # Perfil de iOS/macOS: la CA en base64 dentro de un .mobileconfig bien formado.
  der_b64="$(openssl x509 -in "$CA_PUBLICA" -outform DER 2>/dev/null | base64 | tr -d '\n' || true)"
  huella="$(openssl x509 -in "$CA_PUBLICA" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)"
  if [[ -n "$der_b64" ]]; then
    uuid_ca="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000-0000-4000-8000-000000000001)"
    uuid_perfil="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000-0000-4000-8000-000000000002)"
    cat >"$CA_DIR/odontocrm.mobileconfig" <<PERFIL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>odontocrm-ca.crt</string>
      <key>PayloadDescription</key><string>Autoridad de certificación interna de OdontoCRM</string>
      <key>PayloadDisplayName</key><string>OdontoCRM · CA interna</string>
      <key>PayloadIdentifier</key><string>local.odontocrm.ca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid_ca}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadContent</key><data>${der_b64}</data>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Instala la CA interna de OdontoCRM para que el navegador no avise</string>
  <key>PayloadDisplayName</key><string>OdontoCRM · certificado de la clínica</string>
  <key>PayloadIdentifier</key><string>local.odontocrm.perfil</string>
  <key>PayloadOrganization</key><string>OdontoCRM</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid_perfil}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
PERFIL
    chmod 0644 "$CA_DIR/odontocrm.mobileconfig"
    ok 'perfil de iOS/macOS publicado (odontocrm.mobileconfig)'
    [[ -n "$huella" ]] && echo "       huella SHA-256 de la CA: ${huella:0:47}…"
  fi

  # Scripts de un solo comando para los equipos de la consulta.
  # OJO: los dos scripts NO llevan una IP grabada. Llevan el marcador `SERVIDOR`, y nginx lo
  # sustituye al servirlos por la dirección con la que el equipo llegó (`$host`, con
  # `sub_filter`). Así funcionan aunque el servidor cambie de red: pasó lo contrario y el
  # equipo que los ejecutaba se quedaba esperando a una dirección que ya no existía.
  cat >"$CA_DIR/ca-windows.ps1" <<'PS1'
# OdontoCRM · instalar la CA interna en Windows (PowerShell COMO ADMINISTRADOR)
#   irm http://<direccion-del-servidor>/ca-windows.ps1 | iex
$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:TEMP 'odontocrm-ca.der'
Invoke-WebRequest -Uri 'http://SERVIDOR/ca.der' -OutFile $destino
Import-Certificate -FilePath $destino -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Write-Host 'CA instalada. Cierra y vuelve a abrir el navegador.' -ForegroundColor Green
PS1
  chmod 0644 "$CA_DIR/ca-windows.ps1"

  cat >"$CA_DIR/ca-linux.sh" <<'SH'
#!/usr/bin/env bash
# OdontoCRM · instalar la CA interna en Linux (Fedora/RHEL y Debian/Ubuntu)
#
# El servidor lo pone nginx al servir este archivo (es la dirección con la que llegaste),
# así que funciona aunque el servidor cambie de IP o de red.
set -uo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'se necesita sudo'; exit 1; }
SERVIDOR_URL='http://SERVIDOR'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Si no llega, el error tiene que decir POR QUÉ y qué comprobar: un «timeout» a secas deja
# al operador sin nada (nos pasó: el servidor había cambiado de red y el script apuntaba a
# la dirección vieja).
if ! curl -fsSL --max-time 10 "$SERVIDOR_URL/ca.crt" -o "$tmp/odontocrm-ca.crt"; then
  echo "✖ No pude descargar la CA de $SERVIDOR_URL" >&2
  echo "  Comprueba, en este equipo:" >&2
  echo "    1. ¿estás en la misma red que el servidor?   ip -4 addr | grep inet" >&2
  echo "    2. ¿responde el servidor?                    ping -c2 $(printf '%s' "$SERVIDOR_URL" | sed 's|http://||')" >&2
  echo "    3. ¿el puerto 80 llega?                      curl -v --max-time 5 $SERVIDOR_URL/ca.crt" >&2
  echo "  Si el servidor cambió de red, vuelve a abrir la página de la CA con la" >&2
  echo "  dirección nueva (o pide al responsable: sudo odontocrm red --arreglar)." >&2
  exit 1
fi
if [[ -d /etc/pki/ca-trust/source/anchors ]]; then
  install -m 0644 "$tmp/odontocrm-ca.crt" /etc/pki/ca-trust/source/anchors/ && update-ca-trust
elif [[ -d /usr/local/share/ca-certificates ]]; then
  install -m 0644 "$tmp/odontocrm-ca.crt" /usr/local/share/ca-certificates/odontocrm-ca.crt && update-ca-certificates
else
  echo 'no encontré el almacén del sistema; revisa la documentación de tu distribución'; exit 1
fi
echo "✔ CA instalada (desde $SERVIDOR_URL)."
echo '  Firefox tiene su propio almacén: about:config → security.enterprise_roots.enabled = true'
SH
  chmod 0755 "$CA_DIR/ca-linux.sh"
  ok 'scripts de un comando publicados (ca-windows.ps1 y ca-linux.sh)'
  if command -v semanage >/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    semanage fcontext -a -t httpd_sys_content_t '/var/www/odontocrm(/.*)?' 2>/dev/null ||
      semanage fcontext -m -t httpd_sys_content_t '/var/www/odontocrm(/.*)?' 2>/dev/null || true
    restorecon -R /var/www/odontocrm 2>/dev/null &&
      ok 'SELinux: /var/www/odontocrm etiquetado como httpd_sys_content_t' ||
      av 'no pude etiquetar /var/www/odontocrm (SELinux podría devolver 403)'
  fi
else
  av "no encuentro la CA (busqué $ETC_DIR/keys/odontocrm-ca.crt y el almacén de mkcert)"
  av 'créala con: sudo mkcert -install   y vuelve a ejecutar esto'
fi

# ── 3. Sintaxis y arranque ───────────────────────────────────────────────────
if nginx -t >/tmp/odontocrm-nginx.log 2>&1; then
  ok 'nginx -t: configuración válida'
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx >/dev/null 2>&1 || morir 'nginx no arrancó (journalctl -u nginx -n 40)'
  ok 'nginx activo'
else
  tail -5 /tmp/odontocrm-nginx.log
  morir 'nginx -t falló: revisa el mensaje de arriba'
fi

# ── Comprobación rápida (sin sesión) ────────────────────────────────────────
sleep 1
spa="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 https://127.0.0.1/ || echo 000)"
api="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 https://127.0.0.1/api/v1/meta || echo 000)"
redir="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1/ || echo 000)"
[[ "$spa" == "200" ]] && ok 'la SPA se sirve por https' || err "la SPA devolvió $spa"
[[ "$api" == "200" ]] && ok 'la API llega por el proxy' || err "la API devolvió $api"
[[ "$redir" == "301" ]] && ok 'http redirige a https' || av "http devolvió $redir (esperaba 301)"

ca_codigo="$(curl -s -o /tmp/odontocrm-ca-descargada.crt -w '%{http_code}' --max-time 6 http://127.0.0.1/ca.crt || echo 000)"
if [[ "$ca_codigo" == "200" ]] && openssl x509 -in /tmp/odontocrm-ca-descargada.crt -noout -subject >/dev/null 2>&1; then
  ok "la CA se descarga en http://<servidor>/ca.crt (para instalar en los equipos)"
else
  av "la CA responde $ca_codigo: revisa permisos de $CA_PUBLICA y las denegaciones de SELinux"
  ausearch -m avc -ts recent 2>/dev/null | grep -i 'ca.crt\|var/www/odontocrm' | tail -3 || true
fi
