#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OdontoCRM · nombre del servidor para los demás equipos, por DNS
#
# **Para qué.** El nombre por mDNS (`odontocrm.local`) es cómodo —no hay que configurar
# nada— pero depende de dos cosas que no siempre se cumplen:
#
#   1. que la red deje pasar la **multidifusión** (las wifi de invitados y las redes con
#      aislamiento de clientes la filtran), y
#   2. que el equipo que consulta **sepa mDNS**: Windows 10+, macOS y Linux con
#      `nss-mdns` sí; los navegadores de **Android, no** (y Android tampoco puede editar
#      el archivo `hosts` sin root).
#
# Este guion instala un **DNS pequeño en el propio servidor** (`dnsmasq`, solo DNS, sin
# DHCP) que responde con la IP del servidor al nombre que se elija. A partir de ahí,
# cualquier equipo de la red —tablet Android incluida— entra por el nombre, siempre que
# use este servidor como DNS (lo normal es decírselo al router, una sola vez).
#
# NO toca el DHCP de nadie ni el DNS de internet: reenvía las consultas que no son suyas
# a los servidores del sistema.
#
#   sudo bash infra/fedora/nombre/instalar-dns.sh
#   sudo bash infra/fedora/nombre/instalar-dns.sh --nombre=consultorio.lan
#   sudo bash infra/fedora/nombre/instalar-dns.sh --dry-run
#
# Después: emitir el certificado para ese nombre (`odontocrm red --arreglar` lo hace con
# el nombre que tenga el proxy, y el instalador de nginx acepta `--host=`).
# ---------------------------------------------------------------------------
set -uo pipefail

# ── Aviso de dónde se corta ──────────────────────────────────────────────────
trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

C_OK=$'\033[32m✔\033[0m'; C_AV=$'\033[33m!\033[0m'; C_TI=$'\033[1m'; C_RE=$'\033[0m'
ok() { printf '  %s %s\n' "$C_OK" "$1"; }
av() { printf '  %s %s\n' "$C_AV" "$1"; }
morir() { printf '\n✖ %s\n' "$1" >&2; exit 1; }

# El nombre por defecto NO es `.local`: ese espacio está reservado para mDNS (RFC 6762) y
# usarlo por DNS unidifusión da comportamientos raros según el equipo. `home.arpa` es el
# dominio que la RFC 8375 reserva para redes domésticas/pequeñas, así que no choca con
# nada de internet.
NOMBRE="odontocrm.home.arpa"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --nombre=*) NOMBRE="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done

[[ "$(id -u)" == "0" ]] || morir 'esta orden necesita sudo (escribe configuración del sistema)'

# El código desplegado, para poder citar la ruta del instalador de nginx en el resumen.
# Antes se usaba `$CODE_DIR` sin definirla: con `set -u` el guion moría **al final** —después
# de dejar el DNS configurado— con «unbound variable», y quien lo llamaba (odontocrm red
# --arreglar) creía que no había hecho nada.
CODE_DIR="${ODONTOCRM_CODE_DIR:-/opt/odontocrm}"

IFACE="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1 || true)"
IP_LAN="$(ip -4 addr show dev "${IFACE:-wlp2s0}" 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1 || true)"
[[ -n "$IP_LAN" ]] || morir 'no pude deducir la IP de este servidor en la red local'

printf '%sConfigurar el nombre «%s» por DNS%s\n' "$C_TI" "$NOMBRE" "$C_RE"
printf '  servidor: %s   interfaz: %s\n\n' "$IP_LAN" "${IFACE:-?}"

# ── 1. dnsmasq ───────────────────────────────────────────────────────────────
if rpm -q dnsmasq >/dev/null 2>&1; then
  ok 'dnsmasq ya está instalado'
elif (( DRY_RUN )); then
  printf '       [dry-run]$ dnf install -y dnsmasq\n'
else
  dnf install -y dnsmasq || morir 'no pude instalar dnsmasq'
  ok 'dnsmasq instalado'
fi

# ── 2. Configuración: solo DNS, solo en la IP de la LAN ──────────────────────
# `listen-address` + `bind-dynamic` evitan chocar con systemd-resolved (que escucha en
# 127.0.0.53) y con las instancias de dnsmasq de libvirt. Sin `dhcp-range`: este servidor
# NO reparte direcciones, solo responde nombres.
CONF=/etc/dnsmasq.d/odontocrm.conf
contenido="# OdontoCRM · nombre del servidor para la red local (generado por
# infra/fedora/nombre/instalar-dns.sh). Solo DNS: no hay DHCP ni se toca el DNS de internet
# (las consultas que no son de esta red se reenvían a los servidores del sistema).
port=53
listen-address=${IP_LAN}
bind-dynamic
domain-needed
bogus-priv
cache-size=1000

# El nombre del servidor → su IP. Se publican las dos formas: la elegida y `.local`
# (por si algún equipo consulta el .local por DNS en vez de por mDNS).
address=/${NOMBRE}/${IP_LAN}
address=/odontocrm.local/${IP_LAN}
"
if (( DRY_RUN )); then
  printf '       [dry-run] escribiría %s:\n' "$CONF"
  printf '%s\n' "$contenido" | sed 's/^/         /'
else
  install -d -m 0755 /etc/dnsmasq.d
  printf '%s' "$contenido" >"$CONF"
  ok "configuración escrita en $CONF (solo DNS, escuchando en $IP_LAN)"
fi

# ── 3. Servicio ──────────────────────────────────────────────────────────────
# `enable` (que arranque al encender) + `restart`, NO `enable --now`: un dnsmasq que ya
# estaba activo **no** se reinicia con `--now`, así que seguía con la configuración vieja
# —esperando la IP anterior, porque `bind-dynamic` espera direcciones que aún no existen—
# y el nombre no resolvía en ningún equipo. Pasó justo al cambiar de red: el guion decía
# «dnsmasq activo» y el 53 no escuchaba en la LAN.
if (( DRY_RUN )); then
  printf '       [dry-run]$ systemctl enable dnsmasq && systemctl restart dnsmasq\n'
else
  systemctl enable dnsmasq >/dev/null 2>&1 || true
  systemctl restart dnsmasq >/dev/null 2>&1 || morir 'no pude arrancar dnsmasq (revisa: journalctl -u dnsmasq)'
  systemctl is-active --quiet dnsmasq && ok 'dnsmasq activo (reiniciado con esta configuración)' ||
    morir 'dnsmasq no quedó activo (revisa: journalctl -u dnsmasq)'
fi

# ── 4. Firewall: el 53 tiene que llegar desde la LAN ─────────────────────────
if systemctl is-active --quiet firewalld; then
  ZONA="$(firewall-cmd --get-zone-of-interface="${IFACE:-$(ip route | awk '/default/ {print $5; exit}')}" 2>/dev/null || echo public)"
  [[ -n "$ZONA" && "$ZONA" != "no" ]] || ZONA=public
  if (( DRY_RUN )); then
    printf '       [dry-run]$ firewall-cmd --permanent --zone=%s --add-service=dns && firewall-cmd --reload\n' "$ZONA"
  else
    firewall-cmd --permanent --zone="$ZONA" --add-service=dns >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld: 53/udp y 53/tcp abiertos en la zona «$ZONA»"
  fi
else
  av 'firewalld no está activo: no hay nada que abrir'
fi

# ── 5. Comprobar que responde ────────────────────────────────────────────────
if (( DRY_RUN )); then
  printf '       [dry-run]$ dig +short @%s %s   → %s\n' "$IP_LAN" "$NOMBRE" "$IP_LAN"
else
  respuesta="$(dig +short +time=3 +tries=1 "@$IP_LAN" "$NOMBRE" 2>/dev/null | head -1 || true)"
  if [[ "$respuesta" == "$IP_LAN" ]]; then
    ok "el DNS responde: $NOMBRE → $respuesta"
  else
    av "el DNS no respondió «$respuesta»; revisa: journalctl -u dnsmasq"
    av "  (comprueba también que el 53 no lo tenga otro: ss -lunp | grep :53)"
  fi
fi

# ── 6. Lo que falta: que los equipos usen este DNS ───────────────────────────
echo
printf '%sFalta un paso, y es una sola vez:%s\n' "$C_TI" "$C_RE"
echo "  Los equipos tienen que preguntar a este servidor ($IP_LAN) para resolver el nombre."
echo
echo "  · Lo recomendable: en el ROUTER, en la configuración de DHCP, poner como servidor"
echo "    DNS la IP $IP_LAN (así lo toman todos los equipos solos, también las tablets)."
echo "  · Si el router no lo permite, se pone en cada equipo:"
echo "      Windows 10/11 : Configuración → Red → Propiedades → IPv4 → DNS: $IP_LAN"
echo "      macOS         : Ajustes → Red → Avanzado → DNS → + $IP_LAN"
echo "      Android       : Ajustes → Red → (red actual) → IP estática → DNS 1: $IP_LAN"
echo "      Linux         : nmcli con mod <conexión> ipv4.dns $IP_LAN && nmcli con up <conexión>"
echo
echo "  Y después, el certificado tiene que cubrir ese nombre:"
echo "      sudo bash $CODE_DIR/infra/fedora/nginx/instalar.sh --host=\"$NOMBRE $IP_LAN\"   # o:"
echo "      sudo odontocrm red --arreglar                                        # reemite con lo que use el proxy"
echo
ok "hecho. Comprueba desde otro equipo:  nslookup $NOMBRE $IP_LAN   y luego  https://$NOMBRE"
