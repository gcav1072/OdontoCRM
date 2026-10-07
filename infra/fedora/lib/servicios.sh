#!/usr/bin/env bash
# =============================================================================
# Es una BIBLIOTECA (fedora:check-ok biblioteca): NO se ejecuta sola, se carga con
# `source`. Los traps los pone quien la carga —ponerlos aquí duplicaría el aviso en cada
# pieza y pisaría el del llamador—, y por eso la comprobación de «guion que se corta en
# silencio» la salta.
# OdontoCRM · LA lista de servicios, y de dónde sale
#
#   Un servicio con base propia es **una carpeta `services/<nombre>/` con `migraciones/`**,
#   y su puerto lo declara él mismo en `.env.example` (`<NOMBRE>_PORT`). Nada más.
#
#   Añadir un servicio (el día que haya un décimo) no se hace tocando el instalador: se crea
#   la carpeta con sus migraciones y se le pone el puerto en `.env.example`. De aquí salen
#   solos —y en orden de puerto— la lista de servicios, la de bases (`odonto_<nombre>`), la
#   del respaldo, las unidades `odontocrm@<nombre>`, los puertos internos que no deben
#   publicarse y los papeles de PostgreSQL.
#
#   Esto existe porque las listas escritas a mano ya fallaron tres veces con `billing`:
#   el despliegue no esperaba su puerto, una comprobación de seguridad no lo miraba y la
#   copia diaria no lo incluía… diciendo «respaldo completado sin errores».
#
# Uso:   source infra/fedora/lib/servicios.sh     (define las funciones de abajo)
# =============================================================================

# Raíz del código donde buscar `services/`: el checkout del que se instala (ORIGEN) si está,
# el código desplegado (CODE_DIR) si no, y por último el propio repo de esta librería.
fuente_de_servicios() {
  local candidato
  for candidato in "${ODONTOCRM_FUENTE:-}" "${ORIGEN:-}" "${CODE_DIR:-}" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"; do
    [[ -n "$candidato" && -d "$candidato/services" && -f "$candidato/.env.example" ]] || continue
    printf '%s\n' "$candidato"
    return 0
  done
  return 1
}

# Puerto declarado por el propio servicio en `.env.example` (`BILLING_PORT=4009`).
puerto_de_servicio() {
  local servicio="$1" fuente="${2:-$(fuente_de_servicios)}" variable linea
  variable="$(printf '%s' "$servicio" | tr '[:lower:]' '[:upper:]')_PORT"
  linea="$(grep -m1 -E "^${variable}=[0-9]+" "$fuente/.env.example" 2>/dev/null || true)"
  printf '%s\n' "${linea#*=}"
}

# CONTRATO de las listas de aquí (importa, y ya falló una vez):
#   · `servicios_del_repo` y `puertos_internos` → **una por línea** (`mapfile -t` o `while read`).
#   · `bases_del_respaldo` → **una sola línea con espacios**, que es lo que espera `DATABASES=`.
#     Para recorrerla como array:  read -r -a bases <<<"$(bases_del_respaldo)"
#     Con `mapfile -t` queda UN elemento con los diez nombres pegados; así el rol de respaldo se
#     quedó sin GRANTs y el respaldo falló en las diez bases con «permiso denegado» (lo cazó la
#     prueba de desinstalar y volver a instalar).

# La lista de servicios, en orden de puerto (el orden de arranque natural: 4001, 4002…).
servicios_del_repo() {
  local fuente
  fuente="$(fuente_de_servicios)" || {
    printf '%s\n' 'no encuentro el código con services/ y .env.example (¿falta desplegar?)' >&2
    return 1
  }
  local dir servicio puerto
  for dir in "$fuente"/services/*/; do
    [[ -d "$dir/migrations" ]] || continue
    servicio="$(basename "$dir")"
    puerto="$(puerto_de_servicio "$servicio" "$fuente")"
    [[ -n "$puerto" ]] || puerto=99999
    printf '%s %s\n' "$puerto" "$servicio"
  done | sort -n | awk '{print $2}'
}

# Las bases que entran en el respaldo: una por servicio (`odonto_<servicio>`) más la cola.
bases_del_respaldo() {
  local s
  for s in $(servicios_del_repo); do printf 'odonto_%s ' "$s"; done
  printf 'odonto_events'
}

# Los puertos que NO pueden estar publicados: la base, cada servicio y el gateway.
puertos_internos() {
  local s
  printf '%s\n' 5432
  for s in $(servicios_del_repo); do puerto_de_servicio "$s"; done
  printf '%s\n' "${PUERTO_GATEWAY:-8090}"
}

# Deja `backup.env` con TODAS las bases: AÑADE las que falten (con copia `.antes-de-<fecha>`)
# y no quita ninguna — en un respaldo, mejor que sobre a que falte. Imprime lo que añadió.
asegurar_bases_en_backup_env() {
  local archivo="$1" faltan="" b lista
  [[ -f "$archivo" ]] || return 0
  for b in $(bases_del_respaldo); do
    grep -qE "(^|[[:space:]\"])$b([[:space:]\"]|$)" "$archivo" || faltan+="$b "
  done
  [[ -n "$faltan" ]] || return 0
  cp -a "$archivo" "${archivo}.antes-de-$(date +%Y%m%d%H%M%S)"
  lista="$(sed -n 's/^DATABASES="\(.*\)"$/\1/p' "$archivo" | head -1)"
  if [[ -n "$lista" ]]; then
    sed -i "s|^DATABASES=\".*\"$|DATABASES=\"$lista $faltan\"|" "$archivo"
  else
    printf 'DATABASES="%s"\n' "$(bases_del_respaldo)" >>"$archivo"
  fi
  printf '%s' "$faltan"
}
