#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OdontoCRM · preparar una PC Fedora para el servidor de la clínica
#
# Deja la máquina lista para el despliegue: paquetes base, **PostgreSQL del
# sistema** (clúster inicializado y arrancado), el rol superusuario de tu usuario
# (entrada por socket con `peer`, sin contraseñas guardadas), **Node.js 26** de
# NodeSource, PM2, nginx + mkcert, las dependencias de Chromium que Playwright no
# instala en Fedora, y `pg_hba.conf` en `scram-sha-256` para las conexiones TCP.
#
# Es idempotente: lo que ya está, se salta o se deja igual. Se puede repetir.
#
#   sudo bash infra/fedora/instalar-base-fedora.sh
#   sudo bash infra/fedora/instalar-base-fedora.sh --nombre-mdns=odontocrm
#       (recomendado en la clínica: el servidor se llama `odontocrm` y los equipos
#        entran por https://odontocrm.local SIN tocar el archivo hosts de nadie)
#   sudo bash infra/fedora/instalar-base-fedora.sh --dry-run   # sin cambios (informativo)
#
# No guarda ningún secreto y no toca el repositorio. Lo que sigue, después:
#   npm run db:bootstrap && npm run db:migrate && npm run seed:users
#   sudo bash infra/fedora/instalar.sh --apply --supervisor=systemd --enable-services
#   sudo bash infra/fedora/ensayo-despliegue.sh --hasta=respaldos
# (INSTALL.md §4 a §10 lo explica paso a paso.)
# ---------------------------------------------------------------------------
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


NOMBRE_MDNS=""
for arg in "$@"; do
  case "$arg" in
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Argumento no reconocido: $arg"; exit 2 ;;
  esac
done
DRY_RUN="${DRY_RUN:-0}"

echo
echo "== 1/6 · Paquetes base y herramientas del sistema =========================="
sudo dnf install -y \
  git tar gzip xz zstd rsync curl ca-certificates logrotate chrony firewalld \
  policycoreutils-python-utils setools-console setroubleshoot-server audit \
  postgresql-contrib nginx mkcert nss-tools bind-utils

echo
echo "== 2/6 · PostgreSQL 18: clúster y arranque ================================="
if sudo test -s /var/lib/pgsql/data/PG_VERSION; then
  echo "el clúster ya estaba inicializado"
else
  sudo postgresql-setup --initdb
fi
sudo systemctl enable --now postgresql
sudo systemctl status postgresql --no-pager | head -6

echo
echo "== 3/6 · Rol superusuario para tu usuario (peer por socket) ================"
# OJO: dentro de un script con sudo, $USER es root. El rol hay que crearlo para el
# usuario de verdad, que es el que abre la sesión (SUDO_USER).
USUARIO_REAL="${SUDO_USER:-$USER}"
if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '$USUARIO_REAL'" | grep -q 1; then
  echo "el rol $USUARIO_REAL ya existía"
elif sudo -u postgres createuser --superuser "$USUARIO_REAL"; then
  echo "rol $USUARIO_REAL creado (superusuario por socket)"
else
  echo "ERROR: no pude crear el rol $USUARIO_REAL. Comprueba que PostgreSQL está arrancado" >&2
  echo "       y que puedes entrar como el usuario postgres (sudo -u postgres psql)." >&2
  exit 1
fi
# Y también para root: en el despliegue el bootstrap y las migraciones se ejecutan con
# `sudo` (el código de /opt pertenece a root), y con autenticación `peer` el usuario del
# sistema tiene que tener su propio rol. Sin esto, `sudo npm run db:bootstrap` falla en
# una máquina recién preparada con «Peer authentication failed for user "root"».
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'root'" | grep -q 1 ||
  sudo -u postgres createuser --superuser root ||
  { echo "ERROR: no pude crear el rol root (lo necesita el bootstrap cuando se ejecuta con sudo)" >&2; exit 1; }
echo "  roles superusuario por socket: $USUARIO_REAL y root (peer)"
# La comprobación va COMO ESE USUARIO, no como root: la autenticación `peer` compara el
# usuario del sistema que conecta con el rol pedido, así que desde root falla con
# «Peer authentication failed» aunque el rol exista. (Se veía ese error en cada corrida
# y no significaba que el rol faltara.)
sudo -u "$USUARIO_REAL" psql -h /var/run/postgresql -d postgres -tAc 'select version();' |
  head -1 | sed 's/^/  /' ||
  echo "  (aviso) no pude comprobar la conexión como $USUARIO_REAL; el rol está creado igual"


echo
echo "== 3-bis/6 · pg_hba.conf: TCP con contraseña (scram-sha-256) =============="
# `postgresql-setup --initdb` deja `ident` en las líneas de TCP: el servidor compara el
# usuario del SISTEMA con el rol pedido, así que los 8 servicios —que entran por
# 127.0.0.1 con su contraseña— fallan con «Peer authentication failed» y systemd los
# reintenta en bucle. Se cambia SOLO eso: el socket local conserva `peer`, que es lo que
# permite administrar sin contraseñas guardadas.
PG_HBA="$(sudo -u postgres psql -tAc 'show hba_file' 2>/dev/null || echo /var/lib/pgsql/data/pg_hba.conf)"
if [[ -f "$PG_HBA" ]]; then
  metodos="$(sudo -u postgres psql -tAc \
    "select coalesce(string_agg(distinct auth_method, ','), '?') from pg_hba_file_rules where type = 'host'" 2>/dev/null || echo '?')"
  if (( DRY_RUN )); then
    echo "  [dry-run] $PG_HBA: sed host 127.0.0.1/32 y ::1/128 → scram-sha-256  (hoy: $metodos)"
  elif [[ "$metodos" == *ident* || "$metodos" == *trust* ]]; then
    cp -a "$PG_HBA" "${PG_HBA}.antes-de-odontocrm"
    # OJO con el delimitador: el patrón lleva una alternación (`|`), así que `|` no sirve como
    # separador de `s///` — `sed` lo interpreta como fin de la orden y falla con «opción
    # desconocida para `s'». Se usa `#`, que no aparece en el patrón.
    sed -i -E 's#^(host[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)(ident|trust)#\1scram-sha-256#' "$PG_HBA"
    systemctl reload postgresql
    nuevos="$(sudo -u postgres psql -tAc \
      "select coalesce(string_agg(distinct auth_method, ','), '?') from pg_hba_file_rules where type = 'host' and address in ('127.0.0.1/32', '::1/128')" 2>/dev/null)"
    if [[ "$nuevos" == *scram-sha-256* ]]; then
      echo "  TCP con contraseña: $metodos → $nuevos (copia previa: ${PG_HBA}.antes-de-odontocrm)"
    else
      echo "  ✖ No pude dejar TCP con contraseña en $PG_HBA y sin eso los servicios NO pueden" >&2
      echo "    entrar (arrancan en bucle con «Peer authentication failed»). Hazlo a mano:" >&2
      echo "      sudo cp -a $PG_HBA $PG_HBA.antes-de-odontocrm" >&2
      echo "      sudo sed -i -E 's#^(host[[:space:]]+.*(127\.0\.0\.1/32|::1/128)[[:space:]]+)ident#\1scram-sha-256#' $PG_HBA" >&2
      echo "      sudo systemctl reload postgresql && sudo bash $0   # y repite" >&2
      echo "    (Detalle en INSTALL.md §6.3.)" >&2
      exit 1
    fi
  else
    echo "  ya estaba con contraseña ($metodos): no se toca"
  fi
else
  echo "  (aviso) no encuentro pg_hba.conf; revisa INSTALL.md §6.3"
fi

echo
echo "== 4/6 · Dependencias de Chromium (récipe A5 y PDF de reportes) ============"
cd "$(dirname "$0")/../.." || exit 1   # la raíz del repositorio, no infra/
# `playwright install-deps` NO soporta Fedora: intenta `apt-get` y falla con un error que
# asusta («sh: línea 1: apt-get: orden no encontrada») antes de caer a la lista de `dnf`.
# En Fedora se va **directo a la lista** (menos ruido y menos tiempo); en otras
# distribuciones se intenta primero y, si falla, también se usa la lista.
if [[ -f /etc/fedora-release ]]; then
  echo "install-deps no soporta esta distribución: instalo la lista de dnf directamente"
elif ! sudo npx playwright install-deps chromium; then
  echo "install-deps falló: instalo la lista de dnf a mano"
fi

# La lista, siempre: es la que deja Chromium en condiciones en Fedora.
sudo dnf install -y nss nspr atk at-spi2-atk cups-libs libdrm mesa-libgbm \
  libxshmfence libX11 libXext libXcursor libXi libXtst libXcomposite libXdamage \
  libXfixes libXrandr pango alsa-lib libxkbcommon libxkbcommon-x11 \
  liberation-fonts dejavu-sans-fonts

echo
echo "== 5/6 · Node.js 26 (NodeSource) en lugar del Node 22 de Fedora ==========="
sudo dnf remove -y 'nodejs22*'
curl -fsSL --retry 3 -o /tmp/nodesource-setup_26.x.sh https://rpm.nodesource.com/setup_26.x &&
  test -s /tmp/nodesource-setup_26.x.sh ||
  { echo "ERROR: no pude descargar el instalador de Node 26 (¿sin red?). Revisa la conexión y repite." >&2; exit 1; }
sha256sum /tmp/nodesource-setup_26.x.sh
sudo bash /tmp/nodesource-setup_26.x.sh
sudo dnf install -y nodejs
rm -f /tmp/nodesource-setup_26.x.sh
sudo npm install -g pm2

echo
echo
echo "== 7/7 · Nombre de red del servidor (mDNS) ================================"
# Sin esto, cada equipo que quiera entrar por `odontocrm.local` necesita una linea en su
# archivo hosts. Con el nombre publicado por mDNS (avahi, que ya viene en Fedora) los
# equipos de la red lo resuelven SOLOS —tablets, moviles, Windows 10+, macOS y Linux con
# nss-mdns— y da igual la IP que tenga el servidor en cada momento.
if [[ -n "$NOMBRE_MDNS" ]]; then
  actual="$(hostname)"
  if [[ "$actual" == "$NOMBRE_MDNS" ]]; then
    echo "  ya se llama $NOMBRE_MDNS"
  elif (( DRY_RUN )); then
    echo "  [dry-run] hostnamectl set-hostname $NOMBRE_MDNS   (ahora: $actual)"
  else
    hostnamectl set-hostname "$NOMBRE_MDNS"
    echo "  nombre cambiado: $actual -> $NOMBRE_MDNS"
  fi
  if (( ! DRY_RUN )); then
    systemctl enable --now avahi-daemon >/dev/null 2>&1 || true
    # avahi publica el nombre que tenía **al arrancar**: tras cambiarlo hay que reiniciarlo,
    # o `<nombre>.local` no resuelve en ningún equipo. Ojo: `systemctl restart` no siempre
    # reemplaza el proceso —en la PC de pruebas el servicio decía «Started» y el demonio
    # seguía anunciando `fedora.local`—, así que se para, se arranca y se comprueba **lo que
    # anuncia el proceso**, que es lo que de verdad ven los demás equipos.
    systemctl stop avahi-daemon.socket avahi-daemon.service >/dev/null 2>&1 || true
    systemctl start avahi-daemon.socket avahi-daemon.service >/dev/null 2>&1 || true
    anunciado=""
    for _ in $(seq 1 10); do
      anunciado="$(pgrep -a avahi-daemon 2>/dev/null | grep -oP 'running \[\K[^]]+' | head -1 || true)"
      [[ "$anunciado" == "${NOMBRE_MDNS}.local" ]] && break
      sleep 1
    done
    if [[ "$anunciado" == "${NOMBRE_MDNS}.local" ]]; then
      echo "  comprobado: avahi anuncia ${NOMBRE_MDNS}.local"
      if ! timeout 3 avahi-resolve -n "${NOMBRE_MDNS}.local" >/dev/null 2>&1; then
        echo "  (aviso) esta red no responde a la multidifusión: los equipos pueden entrar"
        echo "          por la IP, o con un DNS propio (infra/fedora/nombre/instalar-dns.sh)"
      fi
    else
      echo "  (aviso) avahi sigue anunciando «${anunciado:-nada}»; reinícialo a mano:"
      echo "          sudo systemctl restart avahi-daemon"
    fi
  fi
  echo "  los equipos entran por:  https://${NOMBRE_MDNS}.local"
else
  echo "  (opcional, recomendado en la clinica) publica un nombre fijo para entrar:"
  echo "      sudo bash $0 --nombre-mdns=odontocrm"
  echo "  ahora mismo esta maquina publica: $(hostname).local"
fi
echo "== Resumen (pega esta parte de vuelta) ===================================="
echo "node:      $(node --version 2>&1)"
echo "npm:       $(npm --version 2>&1)"
echo "pm2:       $(pm2 --version 2>&1 | tail -1)"
echo "psql:      $(psql --version 2>&1)"
echo "pg_isready:$(pg_isready 2>&1)"
echo "nginx:     $(nginx -v 2>&1)"
echo "mkcert:    $(mkcert -version 2>&1)"
echo "selinux:   $(getenforce 2>&1)"
echo "firewalld: $(systemctl is-active firewalld 2>&1)"
echo "postgres:  $(systemctl is-active postgresql 2>&1)"
