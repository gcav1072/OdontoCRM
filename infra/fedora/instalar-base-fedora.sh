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
  postgresql-contrib nginx mkcert nss-tools

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
sudo -u postgres createuser --superuser "$USUARIO_REAL" 2>/dev/null || echo "el rol $USUARIO_REAL ya existía"
# Y también para root: en el despliegue el bootstrap y las migraciones se ejecutan con
# `sudo` (el código de /opt pertenece a root), y con autenticación `peer` el usuario del
# sistema tiene que tener su propio rol. Sin esto, `sudo npm run db:bootstrap` falla en
# una máquina recién preparada con «Peer authentication failed for user "root"».
sudo -u postgres createuser --superuser root 2>/dev/null || echo "el rol root ya existía"
echo "  roles superusuario por socket: $USUARIO_REAL y root (peer)"
# La comprobación va COMO ESE USUARIO, no como root: la autenticación `peer` compara el
# usuario del sistema que conecta con el rol pedido, así que desde root falla con
# «Peer authentication failed» aunque el rol exista. (Se veía ese error en cada corrida
# y no significaba que el rol faltara.)
sudo -u "$USUARIO_REAL" psql -h /var/run/postgresql -d postgres -tAc 'select version();' |
  head -1 | sed 's/^/  /' ||
  echo "  (aviso) no pude comprobar la conexión como $USUARIO_REAL; el rol está creado igual"


echo
echo "== 4/6 · Dependencias de Chromium (récipe A5 y PDF de reportes) ============"
cd "$(dirname "$0")/.." || exit 1
if ! sudo npx playwright install-deps chromium; then
  echo "install-deps no soporta esta distribución: instalo la lista a mano"
  sudo dnf install -y nss nspr atk at-spi2-atk cups-libs libdrm mesa-libgbm \
    libxshmfence libX11 libXext libXcursor libXi libXtst libXcomposite libXdamage \
    libXfixes libXrandr pango alsa-lib libxkbcommon libxkbcommon-x11 \
    liberation-fonts dejavu-sans-fonts
fi

echo
echo "== 5/6 · Node.js 26 (NodeSource) en lugar del Node 22 de Fedora ==========="
sudo dnf remove -y 'nodejs22*'
curl -fsSL -o /tmp/nodesource-setup_26.x.sh https://rpm.nodesource.com/setup_26.x
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
    # avahi publica el nombre que tenía al arrancar: tras cambiarlo hay que reiniciarlo,
    # o `<nombre>.local` no resuelve hasta el próximo arranque de la máquina.
    systemctl restart avahi-daemon >/dev/null 2>&1 || true
    sleep 1
    if avahi-resolve -n "${NOMBRE_MDNS}.local" >/dev/null 2>&1; then
      echo "  comprobado: ${NOMBRE_MDNS}.local se resuelve por mDNS"
    else
      echo "  (aviso) ${NOMBRE_MDNS}.local aún no responde; suele tardar unos segundos"
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
