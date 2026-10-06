#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# OdontoCRM · INSTALACIÓN COMPLETA de un servidor nuevo (el «seed»)
#
# **Un solo comando para una PC recién instalada.** Envuelve lo que ya existe —no
# reimplementa nada— en el orden correcto, y termina diciendo cómo entrar desde los
# aparatos de la consulta:
#
#   0. Prepara la máquina (paquetes, PostgreSQL, Node, nginx, mkcert, pg_hba, nombre mDNS)
#   1. Crea las 8 bases, sus roles y las credenciales, y siembra los usuarios
#   2. Despliega el código, las unidades, los secretos, el TLS, el firewall y los respaldos
#   3. Deja el nombre funcionando (mDNS siempre; DNS propio con --con-dns)
#   4. Comprueba todo y resume cómo entrar (nombre, IP y la página del certificado)
#
#   sudo bash infra/fedora/instalar-servidor.sh
#   sudo bash infra/fedora/instalar-servidor.sh --admin-url=postgres:///postgres?host=/var/run/postgresql
#   sudo bash infra/fedora/instalar-servidor.sh --sin-nombre --sin-respaldo
#   sudo bash infra/fedora/instalar-servidor.sh --comprobar   # ¿está lista la máquina?
#   sudo bash infra/fedora/instalar-servidor.sh --dry-run
#
# Es **idempotente**: se puede repetir sin miedo (cada paso lo es por su cuenta). Si algo
# falla, dice en qué paso y con qué se retoma.
#
# Después, en cada aparato de la consulta: la página que imprime al final.
# ---------------------------------------------------------------------------
set -uo pipefail

trap 'codigo=$?; printf "\n✖ %s: un comando devolvió error en la línea %s (código %s):\n    %s\n" "${0##*/}" "$LINENO" "$codigo" "$(sed -n "${LINENO}p" "$0" | sed "s/^ *//")" >&2' ERR
trap 'codigo=$?; if (( codigo != 0 )) && [[ "$BASH_COMMAND" != exit* ]]; then printf "\n✖ %s terminó con error (código %s). Última orden:\n    %s\n" "${0##*/}" "$codigo" "$BASH_COMMAND" >&2; fi' EXIT

C_OK=$'\033[32m✔\033[0m'; C_AV=$'\033[33m! \033[0m'; C_TI=$'\033[1m'; C_RE=$'\033[0m'
ok() { printf '  %s %s\n' "$C_OK" "$1"; }
av() { printf '  %s %s\n' "$C_AV" "$1"; }
paso() { printf '\n%s== %s ==%s\n' "$C_TI" "$1" "$C_RE"; }
morir() { printf '\n✖ %s\n' "$1" >&2; exit 1; }

# El repositorio se deduce del propio guion: funciona desde cualquier clon, de cualquier
# usuario y en cualquier ruta (fue uno de los fallos que más nos costó: rutas de una PC).
ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOMBRE_MDNS="odontocrm"
ADMIN_URL=""
DRY_RUN=0
CON_DNS=0
SIN_NOMBRE=0
SIN_RESPALDO=0

for arg in "$@"; do
  case "$arg" in
    --admin-url=*) ADMIN_URL="${arg#*=}" ;;
    --nombre-mdns=*) NOMBRE_MDNS="${arg#*=}" ;;
    --sin-mdns|--sin-nombre) SIN_NOMBRE=1 ;;
    --con-dns) CON_DNS=1 ;;
    --sin-respaldo) SIN_RESPALDO=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --comprobar) COMPROBAR=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) morir "opción no reconocida: $arg" ;;
  esac
done
# `--comprobar` solo lee, así que se puede ejecutar sin permisos (es lo primero que uno
# quiere saber antes de empezar).
if (( ! COMPROBAR )); then
  [[ "$(id -u)" == "0" ]] || morir 'esta orden necesita sudo (usa --comprobar para revisar sin permisos)'
fi
[[ -f "$ORIGEN/package.json" ]] || morir "no encuentro el repositorio en $ORIGEN"

USUARIO_REAL="${SUDO_USER:-root}"
# En `--comprobar` no hay sudo (ni usuario que deducir): no se avisa de nada.
if (( ! COMPROBAR )) && [[ "$USUARIO_REAL" == "root" ]]; then
  av 'no pude deducir tu usuario (¿lo lanzaste desde root?): el bootstrap usará el rol root'
fi
DRY=(); (( DRY_RUN )) && DRY=(--dry-run)
COMPROBAR="${COMPROBAR:-0}"

# ── Modo comprobación: ¿está la máquina lista para instalar? No toca nada. ──
if (( COMPROBAR )); then
  printf '%sOdontoCRM · ¿está esta máquina lista para instalar?%s\n\n' "$C_TI" "$C_RE"
  problemas=0
  revisar() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else av "$1 → $3"; problemas=$((problemas + 1)); fi; }
  revisar 'Node 22.9 o superior'            'node -e "process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)"' 'instala Node 26 (lo hace el paso 1)'
  revisar 'npm disponible'                  'command -v npm' 'viene con Node'
  revisar 'PostgreSQL instalado'            'command -v psql' 'lo instala el paso 1'
  revisar 'git disponible'                  'command -v git' 'dnf install git'
  revisar 'el repositorio es un clon de git' 'git -C "$ORIGEN" rev-parse --git-dir' 'clona el repositorio, no copies la carpeta'
  revisar 'hay conexión (dnf/Node)'         'timeout 8 curl -fsSI https://rpm.nodesource.com >/dev/null' 'sin red no se puede preparar la máquina'
  revisar 'no hay otra pila usando los puertos' '! pgrep -f "node --watch|tools/stack.mjs"' 'para la pila de desarrollo antes de instalar'
  echo
  (( problemas == 0 )) && ok 'todo listo:  sudo bash infra/fedora/instalar-servidor.sh --con-dns' ||
    av "$problemas cosa(s) por resolver antes de empezar"
  exit 0
fi

printf '%sOdontoCRM · instalación completa%s\n' "$C_TI" "$C_RE"
printf '  repositorio: %s\n  usuario: %s\n' "$ORIGEN" "$USUARIO_REAL"

# ── 0. La máquina -----------------------------------------------------------
paso '1/5 · Preparar la máquina (paquetes, PostgreSQL, Node, nginx, pg_hba)'
if (( SIN_NOMBRE )); then
  bash "$ORIGEN/infra/fedora/instalar-base-fedora.sh" "${DRY[@]}" ||
    morir 'falló la preparación de la máquina'
else
  # Publicar el nombre desde el principio: sin esto, los equipos no resuelven `odontocrm.local`
  # y parece un problema de red (nos llevó una tarde entender que era avahi con el nombre viejo).
  bash "$ORIGEN/infra/fedora/instalar-base-fedora.sh" "${DRY[@]}" --nombre-mdns="$NOMBRE_MDNS" ||
    morir 'falló la preparación de la máquina'
fi
ok 'máquina lista'

# ── 1. Bases, credenciales y usuarios ---------------------------------------
paso '2/5 · Bases, credenciales y usuarios'
cd "$ORIGEN" || morir "no puedo entrar en $ORIGEN"

# El administrador: lo que diga el entorno del repositorio, lo que se pasó por parámetro o
# (por defecto) el socket local, que es como funciona en Fedora.
if [[ -z "$ADMIN_URL" && -f "$ORIGEN/.env" ]]; then
  ADMIN_URL="$(sed -n 's/^PG_ADMIN_URL=//p' "$ORIGEN/.env" | head -1 || true)"
fi
if [[ -z "$ADMIN_URL" ]]; then
  ADMIN_URL="postgres:///postgres?host=/var/run/postgresql"
  av "sin --admin-url ni .env: uso el socket local ($ADMIN_URL)"
  av "  si tu superusuario necesita contraseña:  --admin-url=postgres://postgres:CLAVE@127.0.0.1:5432/postgres"
fi
export PG_ADMIN_URL="$ADMIN_URL"

# Las dependencias primero: en un clon recién hecho no hay `node_modules` y el bootstrap
# fallaría (nos lo habría dicho en la primera PC nueva).
if (( DRY_RUN )); then
  printf '       [dry-run]$ npm ci\n'
else
  npm ci --silent >/tmp/odontocrm-npm-ci.log 2>&1 ||
    { tail -20 /tmp/odontocrm-npm-ci.log; morir 'falló npm ci (registro: /tmp/odontocrm-npm-ci.log)'; }
  ok 'dependencias instaladas (npm ci)'
fi

for paso_cmd in "db:bootstrap" "db:migrate"; do
  if (( DRY_RUN )); then
    printf '       [dry-run]$ npm run %s\n' "$paso_cmd"
  else
    npm run "$paso_cmd" >/tmp/odontocrm-$paso_cmd.log 2>&1 ||
      { tail -20 /tmp/odontocrm-$paso_cmd.log; morir "falló npm run $paso_cmd (registro: /tmp/odontocrm-$paso_cmd.log)"; }
    ok "npm run $paso_cmd"
  fi
done
if (( DRY_RUN )); then
  printf '       [dry-run]$ npm run seed:users -- --contrasena-inicial (o equivalente)\n'
else
  # Los usuarios sembrados piden contraseña en producción (SEED_PASSWORD_*): se generan
  # temporales y se imprimen UNA vez, que es lo que el operador necesita para entrar.
  claves="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-14)"
  # Los usuarios salen de `packages/contracts/src/clinic.ts` (un odontólogo por entrada) más
  # los fijos `admin` y `recepcion`. En producción el seed exige `SEED_PASSWORD_<USUARIO>` para
  # cada uno, así que se los damos todos: con OTRA clínica los nombres son otros y sin esto el
  # seed fallaba en los que no estuvieran en la lista.
  usuarios="$( { printf 'admin\nrecepcion\n'; grep -oP "username: '\K[^']+" "$ORIGEN/packages/contracts/src/clinic.ts" 2>/dev/null; } |
    tr 'a-z' 'A-Z' | sort -u)"
  entorno_claves=()
  while IFS= read -r usuario; do
    [[ -n "$usuario" ]] && entorno_claves+=("SEED_PASSWORD_$usuario=$claves")
  done <<<"$usuarios"
  if env "${entorno_claves[@]}" npm run seed:users >/tmp/odontocrm-seed-users.log 2>&1; then
    ok 'usuarios sembrados'
    echo "       contraseña temporal de los usuarios iniciales: $C_TI$claves$C_RE"
    echo "       (el sistema obliga a cambiarla al primer ingreso)"
  else
    tail -20 /tmp/odontocrm-seed-users.log
    av 'no pude sembrar los usuarios; el resto de la instalación sigue (se puede repetir sin sudo: ver RUNBOOK §5)'
  fi
fi

# ── 2. Despliegue completo --------------------------------------------------
paso '3/5 · Despliegue (código, unidades, secretos, TLS, firewall, respaldos)'
hasta='respaldos'; (( SIN_RESPALDO )) && hasta='tls'
aviso_resumen="$(
  bash "$ORIGEN/infra/fedora/ensayo-despliegue.sh" "${DRY[@]}" --hasta="$hasta" 2>&1 |
    tee /tmp/odontocrm-instalacion.log | tail -25
)" || { printf '%s\n' "$aviso_resumen"; morir "falló el despliegue (registro: /tmp/odontocrm-instalacion.log)"; }
printf '%s\n' "$aviso_resumen"

# ── 3. El nombre en los demás equipos --------------------------------------
paso '4/5 · El nombre para los equipos de la consulta'
if (( CON_DNS )); then
  # DNS propio: es el camino que funciona en TODOS los aparatos, incluidos los Android
  # antiguos, y el único que no depende de la multidifusión de la red.
  bash "$ORIGEN/infra/fedora/nombre/instalar-dns.sh" "${DRY[@]}" --nombre="${NOMBRE_MDNS}.home.arpa" ||
    av 'no pude configurar el DNS propio (el mDNS y la IP siguen funcionando)'
else
  ok "mDNS: los equipos entran por https://${NOMBRE_MDNS}.local (si la red deja pasar la multidifusión)"
  echo "       para que funcione en TODOS (tablets Android incluidas), repite con --con-dns"
fi

# ── 4. Resumen --------------------------------------------------------------
paso '5/5 · Cómo entrar desde los aparatos'
IP_LAN="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)"
[[ -n "$IP_LAN" ]] || IP_LAN="<IP-del-servidor>"

if (( ! DRY_RUN )); then
  sudo -u "$USUARIO_REAL" -H true 2>/dev/null || true
  ODONTOCRM_ENV_DIR=/etc/odontocrm node "$ORIGEN/tools/estado.mjs" --alertas ||
    av 'el tablero reportó problemas: revisa la salida de arriba'
  echo
  "$ORIGEN/infra/fedora/odontocrm" certificado 2>/dev/null | head -30 || true
fi

echo
printf '%sListo.%s Instala el certificado en cada aparato abriendo esta página:\\n' "$C_TI" "$C_RE"
printf '    %shttp://%s/ca.crt%s   (Android, Linux)  ·  /ca.der (Windows)  ·  /odontocrm.mobileconfig (iPhone/iPad, macOS)\\n' \
  "$C_TI" "$IP_LAN" "$C_RE"
printf '  Y luego entra en:  https://%s.local   o   https://%s\\n' "$NOMBRE_MDNS" "$IP_LAN"
echo
echo "  Si algo falla más adelante:  sudo odontocrm estado · verificar · red · nombre · certificado"
echo "  Registro de esta instalación:  /tmp/odontocrm-instalacion.log"
