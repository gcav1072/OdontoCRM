#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# Es una BIBLIOTECA (fedora:check-ok biblioteca): NO se ejecuta sola, se carga con
# `source`. Los traps los pone quien la carga.
#
# OdontoCRM · Reponer el almacén y su clave de cifrado al recuperar un respaldo
#
#   POR QUÉ EXISTE. Los récipes, las radiografías y los PDF se **archivan** en el almacén
#   compartido, cifrados con `STORAGE_ENCRYPTION_KEY`. Reimprimir un récipe no recompone
#   nada: vuelve a leer el archivo guardado. Si al recuperar se restaura la base pero **no**
#   el almacén —o se restaura con otra clave—, las filas siguen apuntando a unos PDF que ya
#   no están o que no se pueden descifrar: los documentos dejan de abrirse y nadie ve por qué.
#
#   Esta librería junta las tres piezas que faltaban:
#     1. extraer `storage_*.tar.gz` en la carpeta que leen los servicios,
#     2. dejar `STORAGE_ENCRYPTION_KEY` con la del respaldo (sin tocar nada más del `.env`),
#     3. comprobar que un archivo de muestra se descifra de verdad.
#
#   La usan `odontocrm recuperar` y `odontocrm restaurar` (Fedora). No roza el restaurador
#   de bases (`odontocrm-restore.sh`): este sigue haciendo solo las bases, como documenta.
#
# Variables que espera del llamador: ETC_DIR, DATA_DIR, CODE_DIR.
# =============================================================================

# ── Avisos: reutiliza los del llamador (ok/av/err) si los tiene; si no, imprime ──
_alm_nivel() { # $1 = ok|av|er, resto = mensaje
  local nivel="$1"; shift
  case "$nivel" in
    ok) if [[ "$(type -t ok)" == function ]]; then ok "$*"; return; fi ;;
    av) if [[ "$(type -t av)" == function ]]; then av "$*"; return; fi ;;
    er) if [[ "$(type -t err)" == function ]]; then err "$*"; return; fi ;;
  esac
  printf '  %s %s\n' "${nivel^^}" "$*" >&2
}
_alm_ok() { _alm_nivel ok "$@"; }
_alm_av() { _alm_nivel av "$@"; }
_alm_er() { _alm_nivel er "$@"; }

# ── Dónde está el almacén que LEEN los servicios ─────────────────────────────
# Se lee del `.env` de un servicio que guarda archivos (patients/clinical/billing), que es
# la verdad para el servicio; `backup.env` dice dónde se respaldó, que no tiene por qué ser
# lo mismo en una máquina nueva. Si no lo declara nadie, la convención del instalador.
almacen_dir() {
  local f leido=""
  for f in patients clinical billing; do
    [[ -f "$ETC_DIR/$f.env" ]] || continue
    leido="$(sed -n 's/^STORAGE_DIR=//p' "$ETC_DIR/$f.env" 2>/dev/null | head -1)"
    [[ -n "$leido" ]] && break
  done
  printf '%s\n' "${leido:-$DATA_DIR/storage}"
}

# La clave con la que está configurada la instalación AHORA (la que leerían los servicios).
clave_actual_almacen() {
  local f v
  for f in patients clinical billing identity; do
    [[ -f "$ETC_DIR/$f.env" ]] || continue
    v="$(sed -n 's/^STORAGE_ENCRYPTION_KEY=//p' "$ETC_DIR/$f.env" 2>/dev/null | head -1)"
    [[ -n "$v" ]] && { printf '%s\n' "$v"; return 0; }
  done
  return 1
}

# Clave de los `.env` que van DENTRO de un tar de configuración (busca en qualquer subcarpeta:
# el respaldo guarda `odontocrm/…`).
_clave_en_dir_env() { # $1 = carpeta que contiene subcarpetas con los .env
  local raiz="$1" f v
  for f in patients clinical billing identity; do
    v="$(find "$raiz" -maxdepth 2 -name "$f.env" -type f -print -quit 2>/dev/null)"
    [[ -n "$v" ]] || continue
    v="$(sed -n 's/^STORAGE_ENCRYPTION_KEY=//p' "$v" 2>/dev/null | head -1)"
    [[ -n "$v" ]] && { printf '%s\n' "$v"; return 0; }
  done
  return 1
}

# La clave que traía el respaldo (dentro de `etc-odontocrm_*.tar.gz`), si viene.
clave_almacen_del_respaldo() { # $1 = directorio del respaldo
  local desde="$1" tar tmp clave=""
  tar="$(compgen -G "$desde/etc-odontocrm_*.tar.gz" 2>/dev/null | head -1)"
  [[ -n "$tar" ]] || return 1
  tmp="$(mktemp -d)"
  if ! tar -xzf "$tar" -C "$tmp" 2>/dev/null; then
    rm -rf "$tmp"
    return 1
  fi
  clave="$(_clave_en_dir_env "$tmp" || true)"
  rm -rf "$tmp"
  [[ -n "$clave" ]] && { printf '%s\n' "$clave"; return 0; }
  return 1
}

# Red de seguridad: la clave que guardó el desinstalador antes de borrar
# (`/root/odontocrm-antes-de-desinstalar-*/etc-odontocrm/*.env`), la más reciente.
# Es la que puede salvar un almacén cuando el respaldo no trajo la configuración.
clave_almacen_de_seguridad() {
  local dir clave
  for dir in $(ls -1d /root/odontocrm-antes-de-desinstalar-* 2>/dev/null | sort -r); do
    [[ -d "$dir/etc-odontocrm" ]] || continue
    clave="$(_clave_en_dir_env "$dir/etc-odontocrm" || true)"
    [[ -n "$clave" ]] && { printf '%s\n' "$clave"; return 0; }
  done
  return 1
}

# ── Reponer los archivos ─────────────────────────────────────────────────────
# `$1` = el tar del almacén (o el directorio del respaldo). `$2` = destino (opcional).
reponer_almacen() {
  local origen="$1" destino="${2:-$(almacen_dir)}" tar
  if [[ -d "$origen" ]]; then
    tar="$(compgen -G "$origen/storage_*.tar.gz" 2>/dev/null | head -1)"
  else
    tar="$origen"
  fi
  [[ -n "$tar" && -f "$tar" ]] || { _alm_er "no encuentro el almacén en $origen"; return 1; }
  mkdir -p "$destino" || { _alm_er "no pude crear $destino"; return 1; }
  if ! tar -xzf "$tar" -C "$destino"; then
    _alm_er "no pude extraer $(basename "$tar") en $destino"
    return 1
  fi
  # El servicio corre como `odontocrm` y lee con ese usuario: si el tar quedó a nombre de
  # root, no podría abrir ni una radiografía (EACCES). El instalador lo corrige a mano; aquí
  # se hace solo.
  if id -u odontocrm >/dev/null 2>&1; then
    chown -R odontocrm:odontocrm "$destino" 2>/dev/null ||
      _alm_av "no pude ajustar el propietario de $destino (revisa que sea odontocrm:odontocrm)"
  fi
  _alm_ok "almacén repuesto en $destino ($(basename "$tar"))"
  return 0
}

# ── Reponer SOLO la clave (sin tocar el resto del .env) ──────────────────────
reconciliar_clave_almacen() { # $1 = clave (base64url)
  local clave="$1"
  [[ -n "$clave" ]] || return 1
  if node "$CODE_DIR/infra/fedora/instalar/aprovisionar.mjs" \
    --env-dir="$ETC_DIR" --clave-almacen="$clave"; then
    return 0
  fi
  _alm_er 'no pude reponer la clave del almacén en los .env'
  return 1
}

# ── Verificar que el almacén se lee de verdad ────────────────────────────────
verificar_almacen() {
  ODONTOCRM_ENV_DIR="$ETC_DIR" node "$CODE_DIR/tools/verificar-almacen.mjs" --estado
}

# ── La operación completa, para que la usen `recuperar` y `restaurar` ─────────
# Devuelve 1 solo si los ARCHIVOS no se pudieron reponer (eso sí es grave: sin ellos no hay
# documentos). Que la clave no se pueda averiguar o que la verificación avise se cuenta como
# aviso: los servicios siguen arrancando y el operador lo ve.
reponer_almacen_completo() { # $1 = directorio del respaldo
  local desde="$1" destino tar clave clave_actual
  destino="$(almacen_dir)"
  tar="$(compgen -G "$desde/storage_*.tar.gz" 2>/dev/null | head -1)"
  if [[ -z "$tar" ]]; then
    _alm_av 'este respaldo no trae el almacén (es anterior a la copia diaria con --include-storage)'
    return 0
  fi

  reponer_almacen "$tar" "$destino" || return 1

  clave_actual="$(clave_actual_almacen || true)"
  clave="$(clave_almacen_del_respaldo "$desde" || true)"
  if [[ -z "$clave" ]]; then
    clave="$(clave_almacen_de_seguridad || true)"
    [[ -n "$clave" ]] &&
      _alm_av 'la clave del almacén no venía en el respaldo: uso la del respaldo de la desinstalación'
  fi

  if [[ -z "$clave" ]]; then
    _alm_av 'no pude averiguar la clave del almacén: si está cifrado, quedará ilegible (RUNBOOK §Recuperación)'
  elif [[ "$clave" == "$clave_actual" ]]; then
    _alm_ok 'la clave del almacén ya es la del respaldo'
  else
    reconciliar_clave_almacen "$clave" || return 0
  fi

  verificar_almacen || _alm_av 'la verificación del almacén avisó de algo: revísalo antes de dar por bueno el sistema'
  return 0
}
