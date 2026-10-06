#!/usr/bin/env bash
# =============================================================================
# OdontoCRM · 4/4 · Verificar el servidor
#
# Comprueba el EFECTO, no los archivos: que cada credencial CONECTE, que cada
# servicio ESCUCHE y responda, que el proxy SIRVA la aplicación por HTTPS y que
# los aparatos de la LAN puedan entrar. Un archivo escrito no es una prueba.
#
# Solo lee: no cambia nada. Se puede ejecutar tantas veces como haga falta.
#
#   sudo bash infra/fedora/instalar/40-verificar.sh
#   sudo bash infra/fedora/instalar/40-verificar.sh --rapido   # sin comprobar la red
#
# Sale con código 0 si todo está bien y 1 si hay algo que arreglar.
# =============================================================================
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS="$NOMBRE_MDNS_POR_DEFECTO"
RAPIDO=0
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --rapido) RAPIDO=1 ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done

PROBLEMAS=0
fallo() {
  err "$1"
  PROBLEMAS=$((PROBLEMAS + 1))
}

printf '%sOdontoCRM · 4/4 · Verificar%s\n' "$C_TI" "$C_RE"
IP_LAN="$(ip_lan)"

# ── 1. Las credenciales CONECTAN (la prueba que faltaba antes) ──────────────
paso '1/6 · Credenciales: cada una tiene que conectar'
if [[ ! -f "$ETC_DIR/odontocrm.env" ]]; then
  fallo "no hay entorno en $ETC_DIR — falta ejecutar 20-aprovisionar.sh"
else
  if node "$INSTALADOR_DIR/aprovisionar.mjs" --env-dir="$ETC_DIR" --solo-verificar 2>&1 | sed 's/^/  /'; then
    ok 'las 9 credenciales conectan y los secretos compartidos coinciden'
  else
    fallo 'alguna credencial NO conecta (arriba se dice cuál y qué archivo revisar)'
    detalle 'se arregla volviendo a aprovisionar:  sudo bash 20-aprovisionar.sh'
  fi
fi

# ── 2. Los 9 servicios: unidad activa, puerto suyo y /health ────────────────
paso '2/6 · Los 9 servicios'
if (( RAPIDO )); then
  detalle 'omitido (--rapido)'
elif [[ -x /usr/local/bin/odontocrm ]]; then
  /usr/local/bin/odontocrm verificar 2>&1 | sed 's/^/  /' || fallo 'algún servicio no responde (arriba está cuál)'
else
  inactivas=0
  for s in "${SERVICIOS[@]}"; do
    if ! systemctl is-active --quiet "odontocrm@$s.service"; then
      fallo "odontocrm@$s.service no está activo"
      inactivas=$((inactivas + 1))
    fi
  done
  if ! systemctl is-active --quiet odontocrm-gateway.service; then
    fallo 'odontocrm-gateway.service no está activo'
    inactivas=$((inactivas + 1))
  fi
  (( inactivas == 0 )) && ok 'las 9 unidades están activas'
fi

# ── 3. El proxy sirve la aplicación por HTTPS ───────────────────────────────
paso '3/6 · La aplicación por HTTPS'
if (( RAPIDO )); then
  detalle 'omitido (--rapido)'
else
  systemctl is-active --quiet nginx || fallo 'nginx no está activo'
  spa="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/ || echo 000)"
  api="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/api/v1/meta || echo 000)"
  redirect="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: 127.0.0.1' http://127.0.0.1/ || echo 000)"

  [[ "$spa" == "200" ]] && ok 'la interfaz se sirve por HTTPS (200)' ||
    fallo "la interfaz devolvió $spa (¿nginx? ¿la SPA compilada? ¿SELinux?)"
  [[ "$api" == "200" ]] && ok 'la API llega al gateway por el proxy (200)' ||
    fallo "la API devolvió $api (¿el gateway arrancado? ¿httpd_can_network_connect?)"
  [[ "$redirect" == "301" ]] && ok 'http redirige a https (301)' ||
    av "http devolvió $redirect (se esperaba 301; el bloque por defecto de Fedora puede estar tapándolo)"

  # La CA en los formatos que piden los aparatos: si esto falla, cada equipo
  # tendría que copiarla a mano y el aviso de certificado no se quitaría nunca.
  ca="$(curl -s -o /tmp/odontocrm-ca-verif.crt -w '%{http_code}' --max-time 8 http://127.0.0.1/ca.crt || echo 000)"
  if [[ "$ca" == "200" ]] && openssl x509 -in /tmp/odontocrm-ca-verif.crt -noout -subject >/dev/null 2>&1; then
    ok "la CA se descarga desde http://<servidor>/ca.crt ($(openssl x509 -in /tmp/odontocrm-ca-verif.crt -noout -subject 2>/dev/null | head -c 46)…)"
  else
    fallo "no pude descargar la CA (código $ca): los aparatos no podrían quitar el aviso"
  fi
  for formato in ca.der odontocrm.mobileconfig ca-windows.ps1 ca-linux.sh; do
    codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1/$formato" || echo 000)"
    [[ "$codigo" == "200" ]] && ok "  /$formato disponible" || av "  /$formato devolvió $codigo"
  done

  # El SSE de las pantallas: sin búfer, o la pantalla de la sala se queda congelada.
  sse="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Accept: text/event-stream' \
    "https://127.0.0.1/api/v1/screens/lobby/stream" || echo 000)"
  case "$sse" in
    200 | 401 | 403) ok "las pantallas SSE llegan al servicio ($sse sin token: correcto)" ;;
    404) fallo 'el SSE devuelve 404: falta la location /api/v1/screens/ en el proxy' ;;
    *) av "el SSE devolvió $sse" ;;
  esac
fi

# ── 4. El certificado ───────────────────────────────────────────────────────
paso '4/6 · Certificado'
CERT=/etc/pki/tls/certs/odontocrm.crt
if [[ ! -f "$CERT" ]]; then
  fallo "no hay certificado en $CERT — ejecuta 30-desplegar.sh"
elif ! openssl x509 -in "$CERT" -noout -subject >/dev/null 2>&1; then
  fallo 'el certificado no se puede leer con openssl'
else
  nombres="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')"
  vence="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  ok "certificado válido hasta $vence"
  for esperado in "$NOMBRE_MDNS.local" "$IP_LAN"; do
    grep -q "$esperado" <<<"$nombres" && ok "  cubre $esperado" ||
      fallo "  NO cubre $esperado: los equipos que entren así verán un aviso"
  done
  # Y que HTTPS funcione de verdad con él (no solo que el archivo exista).
  if ! (( RAPIDO )); then
    if curl -sk --max-time 8 https://127.0.0.1/ >/dev/null 2>&1; then
      ok 'el certificado funciona en una conexión real'
    else
      fallo 'HTTPS no responde con este certificado'
    fi
  fi
fi

# ── 5. Firewall: abierto lo que debe, cerrado lo que no ─────────────────────
paso '5/6 · Firewall'
if ! systemctl is-active --quiet firewalld; then
  av 'firewalld no está activo en esta máquina'
elif (( RAPIDO )); then
  detalle 'omitido (--rapido)'
elif (( $(id -u) != 0 )); then
  # `firewall-cmd` sin root NO falla: se queda esperando a que polkit pida la
  # contraseña, y sin agente de polkit eso es un cuelgue indefinido (medido). Se
  # dice y se sigue, en vez de dejar la verificación parada para siempre.
  av 'para comprobar el firewall hace falta sudo: se omite esta sección'
  detalle 'repítelo con:  sudo bash infra/fedora/instalar/40-verificar.sh'
else
  # `timeout` por si acaso: una comprobación nunca debe poder colgarse.
  servicios_fw="$(timeout 15 firewall-cmd --list-services 2>/dev/null || true)"
  puertos_fw="$(timeout 15 firewall-cmd --list-ports 2>/dev/null || true)"
  if grep -qE '\bhttps\b' <<<"$servicios_fw" || grep -q '443/tcp' <<<"$puertos_fw"; then
    ok '443 abierto: los aparatos de la LAN pueden entrar'
  else
    fallo 'el 443 NO está abierto: desde otro aparato no cargará nada'
    detalle 'se arregla con:  sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload'
  fi
  if grep -qE '\bhttp\b' <<<"$servicios_fw" || grep -q '80/tcp' <<<"$puertos_fw"; then
    ok '80 abierto: sirve para el redirect y para descargar la CA'
  else
    av 'el 80 no está abierto: quien escriba la IP a secas no llegará al redirect'
  fi
  # Contador PROPIO de esta sección: usar el total haría que un fallo anterior
  # silenciara un «todo bien» del firewall, que es justo lo que no se quiere.
  publicados=0
  for puerto in 5432 4001 4002 4003 4004 4005 4006 4007 4008 8090; do
    if grep -q "\b${puerto}/tcp\b" <<<"$puertos_fw"; then
      fallo "el puerto $puerto está ABIERTO a la red y no debería (la base y los servicios van por dentro)"
      publicados=$((publicados + 1))
    fi
  done
  (( publicados == 0 )) && ok 'la base de datos y los servicios internos NO están publicados'
fi

# ── 6. Sin secretos en el código, y sin denegaciones de SELinux ─────────────
paso '6/6 · Secretos y SELinux'
filtrados="$(find "$CODE_DIR" -maxdepth 3 -name '.env' -not -path '*/node_modules/*' 2>/dev/null | head -5 || true)"
if [[ -z "$filtrados" ]]; then
  ok "el código de $CODE_DIR no contiene secretos"
else
  fallo "hay .env dentro de $CODE_DIR: los secretos viven SOLO en $ETC_DIR"
  printf '%s\n' "$filtrados" | sed 's/^/      /'
fi

if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
  if command -v ausearch >/dev/null 2>&1; then
    denegaciones="$(ausearch -m avc -ts today 2>/dev/null | grep -c 'denied' || true)"
    if [[ "${denegaciones:-0}" == "0" ]]; then
      ok 'SELinux en Enforcing, sin denegaciones hoy'
    else
      av "SELinux: $denegaciones denegaciones hoy — ausearch -m avc -ts today | tail -20"
    fi
  else
    ok 'SELinux en Enforcing'
  fi
  getsebool httpd_can_network_connect 2>/dev/null | grep -q 'on$' &&
    ok 'nginx puede salir a la red (httpd_can_network_connect)' ||
    fallo 'falta httpd_can_network_connect: el proxy no llegará al gateway'
else
  detalle 'SELinux no está en Enforcing'
fi

# ── Resumen ─────────────────────────────────────────────────────────────────
echo
if (( PROBLEMAS == 0 )); then
  printf '%s✔ Todo correcto.%s El servidor está listo para la consulta.\n\n' "$C_TI$C_OK" "$C_RE"
else
  printf '%s✖ %s problema(s).%s Arriba está cada uno con lo que le falta.\n\n' "$C_TI$C_ER" "$PROBLEMAS" "$C_RE"
fi

printf '%sCómo entrar desde los demás aparatos%s\n' "$C_TI" "$C_RE"
printf '  1. En cada equipo, abre esta dirección UNA vez para instalar el certificado:\n'
printf '       %shttp://%s/ca.crt%s            (Android, Linux)\n' "$C_TI" "${IP_LAN:-<IP>}" "$C_RE"
printf '       %shttp://%s/ca.der%s            (Windows: doble clic)\n' "$C_TI" "${IP_LAN:-<IP>}" "$C_RE"
printf '       %shttp://%s/odontocrm.mobileconfig%s   (iPhone, iPad, macOS)\n' "$C_TI" "${IP_LAN:-<IP>}" "$C_RE"
printf '  2. Y entra en la aplicación:\n'
printf '       %shttps://%s.local%s   o   %shttps://%s%s\n\n' "$C_TI" "$NOMBRE_MDNS" "$C_RE" "$C_TI" "${IP_LAN:-<IP>}" "$C_RE"
printf '  Si algún Android no resuelve «%s.local», repite el despliegue con %s--con-dns%s\n' \
  "$NOMBRE_MDNS" "$C_TI" "$C_RE"
printf '  Para mirar cómo va:  sudo odontocrm estado  ·  sudo odontocrm verificar\n\n'

(( PROBLEMAS == 0 )) && exit 0 || exit 1
