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

C_OK=$'\e[32m'; C_AV=$'\e[33m'; C_ER=$'\e[31m'; C_TI=$'\e[1m'; C_RE=$'\e[0m'
ok()   { printf '  %s✔%s %s\n' "$C_OK" "$C_RE" "$1"; }
av()   { printf '  %s!%s %s\n' "$C_AV" "$C_RE" "$1"; }
err()  { printf '  %s✖%s %s\n' "$C_ER" "$C_RE" "$1"; }
morir(){ err "$1"; exit 1; }

[[ $EUID -eq 0 ]] || morir 'hay que ejecutarlo como root (sudo)'

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1)"
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
CA_PUBLICA="/var/www/odontocrm/ca/odontocrm-ca.crt"
CA_ORIGEN="$ETC_DIR/keys/odontocrm-ca.crt"
[[ -f "$CA_ORIGEN" ]] || CA_ORIGEN="${CAROOT:-/root/.local/share/mkcert}/rootCA.pem"
if [[ -f "$CA_ORIGEN" ]]; then
  install -d -m 0755 /var/www/odontocrm/ca
  install -m 0644 -o root -g root "$CA_ORIGEN" "$CA_PUBLICA"
  ok "CA publicada en $CA_PUBLICA (legible por nginx)"
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
