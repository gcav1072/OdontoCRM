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

source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

NOMBRE_MDNS=""   # vacío = el que ya estuviera aprovisionado (ver comun.sh)
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

NOMBRE_MDNS="$(resolver_nombre "$NOMBRE_MDNS")"
FQDN="$(nombre_fqdn "$NOMBRE_MDNS")"
printf '%sOdontoCRM · 4/4 · Verificar%s\n' "$C_TI" "$C_RE"
IP_LAN="$(ip_lan)"

# ── 1. Las credenciales CONECTAN (la prueba que faltaba antes) ──────────────
paso '1/6 · Credenciales y usuarios: cada credencial tiene que conectar'
if [[ ! -f "$ETC_DIR/odontocrm.env" ]]; then
  fallo "no hay entorno en $ETC_DIR — falta ejecutar 20-aprovisionar.sh"
else
  if node "$INSTALADOR_DIR/aprovisionar.mjs" --env-dir="$ETC_DIR" --solo-verificar 2>&1 | sed 's/^/  /'; then
    ok 'las 9 credenciales conectan y los secretos compartidos coinciden'
  else
    fallo 'alguna credencial NO conecta (arriba se dice cuál y qué archivo revisar)'
    detalle 'se arregla volviendo a aprovisionar:  sudo bash 20-aprovisionar.sh'
  fi

  # ¿Y se puede ENTRAR? Un servidor con los 9 servicios sanos y sin usuarios deja a
  # la consulta fuera, y el resumen diría «listo para la consulta». Se comprueba el
  # EFECTO: que existan las cuentas en la base de identidad.
  url_id="$(leer_clave_entorno "$ETC_DIR/identity.env" DATABASE_URL)"
  if [[ -z "$url_id" ]]; then
    av 'no pude leer la credencial de identidad para contar los usuarios'
  else
    resto="${url_id#postgres://}"; usu_db="${resto%%:*}"; resto="${resto#*:}"
    cla_db="${resto%%@*}"; bas_db="${url_id##*/}"
    cuantos="$(PGPASSWORD="$cla_db" PGPASSFILE=/dev/null psql -X -w -tAc 'select count(*) from users' \
      -h 127.0.0.1 -p 5432 -U "$usu_db" -d "$bas_db" 2>/dev/null || echo '?')"
    if [[ "$cuantos" =~ ^[0-9]+$ ]] && (( cuantos > 0 )); then
      ok "hay $cuantos usuario(s) con los que entrar"
    else
      fallo 'NO hay usuarios en la base de identidad: nadie puede iniciar sesión'
      detalle "siémbralos:  cd $CODE_DIR && node tools/con-entorno.mjs $ETC_DIR identity -- node services/identity/dist/seed.js"
    fi
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
  spa="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/ || true)"
  api="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/api/v1/meta || true)"
  redirect="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: 127.0.0.1' http://127.0.0.1/ || true)"
  # `curl` escribe el código aunque falle (000), pero si ni arranca no escribe nada.
  [[ -n "$spa" ]] || spa=000
  [[ -n "$api" ]] || api=000
  [[ -n "$redirect" ]] || redirect=000

  [[ "$spa" == "200" ]] && ok 'la interfaz se sirve por HTTPS (200)' ||
    fallo "la interfaz devolvió $spa (¿nginx? ¿la SPA compilada? ¿SELinux?)"
  [[ "$api" == "200" ]] && ok 'la API llega al gateway por el proxy (200)' ||
    fallo "la API devolvió $api (¿el gateway arrancado? ¿httpd_can_network_connect?)"
  [[ "$redirect" == "301" ]] && ok 'http redirige a https (301)' ||
    av "http devolvió $redirect (se esperaba 301; el bloque por defecto de Fedora puede estar tapándolo)"

  # La CA en los formatos que piden los aparatos: si esto falla, cada equipo
  # tendría que copiarla a mano y el aviso de certificado no se quitaría nunca.
  # Archivo temporal ÚNICO por corrida: con un nombre fijo, un resto de una ejecución
  # anterior (de otro usuario, o a medias) podía interferir en la comprobación.
  ca_archivo="$(mktemp -t odontocrm-ca-XXXXXX)"
  ca="000"
  # Se intenta dos veces: esto corre justo después de reiniciar nginx y publicar la CA,
  # y en la primera instalación real devolvió un 200 cuyo cuerpo no era el certificado.
  # El reintento cubre un estado transitorio; si aun así falla, abajo se dice QUÉ llegó.
  for intento in 1 2; do
    ca="$(curl -s -o "$ca_archivo" -w '%{http_code} %{content_type}' --max-time 8 \
      http://127.0.0.1/ca.crt 2>/dev/null || true)"
    [[ -n "$ca" ]] || ca=000
    openssl x509 -in "$ca_archivo" -noout -subject >/dev/null 2>&1 && break
    (( intento == 1 )) && sleep 2
  done

  if [[ "$ca" == 200* ]] && openssl x509 -in "$ca_archivo" -noout -subject >/dev/null 2>&1; then
    ok "la CA se descarga desde http://<servidor>/ca.crt ($(openssl x509 -in "$ca_archivo" -noout -subject 2>/dev/null | head -c 46)…)"
  else
    # Sin esto, un fallo aquí era un callejón sin salida: se sabía que fallaba, no por qué.
    fallo "no pude descargar la CA (respuesta: $ca)"
    detalle "lo que llegó no es un certificado; empieza por: $(head -c 60 "$ca_archivo" 2>/dev/null | tr -d '\n')"
    detalle "si es HTML, nginx está sirviendo la interfaz en vez de la CA: revisa «location = /ca.crt»"
    detalle "si es 403, SELinux no deja a nginx leer /var/www/odontocrm/ca"
  fi
  rm -f "$ca_archivo"
  for formato in ca.der odontocrm.mobileconfig ca-windows.ps1 ca-linux.sh; do
    # Se mira el TIPO, no solo el código: la interfaz responde 200 a cualquier ruta
    # desconocida, así que un 200 a secas podía dar por bueno un enlace que en
    # realidad devolvía la página de la aplicación.
    tipo="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 8 "http://127.0.0.1/$formato" || true)"
    [[ -n "$tipo" ]] || tipo=000
    case "$tipo" in
      200*text/html*) av "  /$formato devuelve la interfaz, no el archivo (¿location mal puesta?)" ;;
      200*) ok "  /$formato disponible ($tipo)" ;;
      *) av "  /$formato devolvió $tipo" ;;
    esac
  done

  # El SSE de las pantallas: sin búfer, o la pantalla de la sala se queda congelada.
  sse="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 -H 'Accept: text/event-stream' \
    "https://127.0.0.1/api/v1/screens/lobby/stream" || true)"
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
  # `grep -q ""` casa SIEMPRE: si la IP saliera vacía, la comprobación diría «cubre »
  # en blanco y daría por bueno un certificado que no sirve para esa dirección.
  for esperado in "$FQDN" "$IP_LAN"; do
    [[ -n "$esperado" ]] || continue
    grep -q -- "$esperado" <<<"$nombres" && ok "  cubre $esperado" ||
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
  # Se miran la zona por defecto Y la de la interfaz de la LAN: `--list-ports` a
  # secas solo ve la primera, así que lo publicado en la zona de la LAN no aparecía.
  IFACE_FW="$(interfaz_lan)"
  ZONA_FW="$(timeout 15 firewall-cmd --get-zone-of-interface="${IFACE_FW}" 2>/dev/null || echo public)"
  [[ -n "$ZONA_FW" && "$ZONA_FW" != "no" ]] || ZONA_FW=public
  servicios_fw=""
  puertos_fw=""
  for z in public "$ZONA_FW"; do
    servicios_fw+="$(timeout 15 firewall-cmd --zone="$z" --list-services 2>/dev/null || true) "
    puertos_fw+="$(timeout 15 firewall-cmd --zone="$z" --list-ports 2>/dev/null || true) "
  done
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
      av "SELinux: $denegaciones denegación(es) hoy. La última, para saber de qué es:"
      ausearch -m avc -ts today 2>/dev/null | grep 'denied' | tail -1 |
        grep -oE 'denied\{[^}]*\} for [^ ]*[^ ]*' | head -c 160 | sed 's/^/      /' || true
      detalle 'el detalle completo:  sudo ausearch -m avc -ts today | tail -20'
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
printf '       %shttps://%s%s   o   %shttps://%s%s\n\n' "$C_TI" "$FQDN" "$C_RE" "$C_TI" "${IP_LAN:-<IP>}" "$C_RE"
printf '  Si algún Android no resuelve «%s», repite el despliegue con %s--con-dns%s\n' \
  "$FQDN" "$C_TI" "$C_RE"
printf '  Para mirar cómo va:  sudo odontocrm estado  ·  sudo odontocrm verificar\n\n'

(( PROBLEMAS == 0 )) && exit 0 || exit 1
