# =============================================================================
# OdontoCRM · 2/4 · Aprovisionar: credenciales, bases, roles y usuarios (Windows)
#
# **Esta es la ÚNICA pieza del despliegue que escribe credenciales.** Lo hace en
# `C:\ProgramData\OdontoCRM\env`, que es la única fuente de verdad (ADR 0043): genera cada
# secreto UNA vez, crea el rol y la base con ESA misma contraseña y después lo comprueba
# conectándose de verdad, uno por uno.
#
# Reutiliza el mismo aprovisionador que Fedora (`aprovisionar.mjs`), que se hizo portable:
# lo que cambia en Windows es dónde viven los secretos, dónde está `psql` y que el
# administrador de PostgreSQL es OBLIGATORIO (no existe el socket «peer» de Linux).
#
#   .\20-aprovisionar.ps1 --admin-url="postgres://postgres:CLAVE@127.0.0.1:5432/postgres"
#   .\20-aprovisionar.ps1 --solo-verificar    # no cambia nada
#   .\20-aprovisionar.ps1 --rotate            # contraseñas nuevas
#   .\20-aprovisionar.ps1 --dry-run
#
# Espejo de `infra/fedora/instalar/20-aprovisionar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · 2/4 · Aprovisionar (Windows)

USO
  .\20-aprovisionar.ps1 [--nombre-mdns=NOMBRE] [--ip=IP]
                        [--admin-url=URL] [--rotate] [--solo-verificar] [--dry-run]

OPCIONES
  --admin-url=URL     Cómo entrar a PostgreSQL como administrador. Si no se indica, se
                      usa la variable PG_ADMIN_URL. EN WINDOWS ES OBLIGATORIO.
  --nombre-mdns=…     Nombre del servidor (para el certificado y WEB_ORIGIN).
  --ip=…              IP de la LAN (si no, se deduce).
  --rotate            Genera contraseñas NUEVAS (invalida las anteriores).
  --solo-verificar    No cambia nada: comprueba que cada credencial CONECTA.
  --dry-run           Enseña lo que haría, sin hacerlo.
'@

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }

$Nombre = Get-Argumento $args 'nombre-mdns'
$Ip = Get-Argumento $args 'ip'
$AdminUrl = Get-Argumento $args 'admin-url'
if (-not $AdminUrl) { $AdminUrl = $env:PG_ADMIN_URL }
$Rotar = Test-Bandera $args 'rotate'
$SoloVerificar = Test-Bandera $args 'solo-verificar'
$DryRun = Test-Bandera $args 'dry-run'

if (-not $DryRun -and -not $SoloVerificar) { Afirmar-Administrador }

Write-Host ''
Write-Host 'OdontoCRM · 2/4 · Aprovisionar (Windows)' -ForegroundColor White

$Nombre = Get-Nombre -Pedido $Nombre
if (-not $Ip) { $Ip = Get-IpLan }
if ($Ip) { Escribir-Detalle "IP de la LAN: $Ip" }
else { Escribir-Aviso 'no pude deducir la IP de la LAN (usa --ip=…); el certificado la necesita.' }
Escribir-Detalle "nombre: $Nombre"
Escribir-Detalle "secretos → $OdontoEnv"
Escribir-Detalle "claves TLS → $OdontoTls"
if ($DryRun) { Escribir-Aviso '--dry-run: no se escribe ni se cambia nada' }
if ($Rotar) { Escribir-Aviso '--rotate: se generan contraseñas NUEVAS (invalida las anteriores)' }

$info = Get-Info
$cuantos = $info.servicios.Count

# ── El administrador de PostgreSQL ───────────────────────────────────────────
# En Fedora, sin `--admin-url` se usa el socket como usuario `postgres`. En Windows no
# existe eso: o hay URL, o no se puede crear ninguna base. Se dice ANTES de intentarlo.
if (-not $SoloVerificar -and -not $AdminUrl -and -not $DryRun) {
  Write-Host ''
  Escribir-Error 'falta el administrador de PostgreSQL (--admin-url o PG_ADMIN_URL).'
  Escribir-Detalle 'En Windows no hay socket «peer»: se necesita la contraseña del usuario postgres.'
  Escribir-Detalle ''
  Escribir-Detalle '  .\20-aprovisionar.ps1 --admin-url="postgres://postgres:TU_CLAVE@127.0.0.1:5432/postgres"'
  exit 1
}

# ── Los argumentos para el aprovisionador (el MISMO que usa Fedora) ──────────
$aprovisionador = Join-Path $OdontoRepo 'infra\fedora\instalar\aprovisionar.mjs'
if (-not (Test-Path $aprovisionador)) {
  Morir "no encuentro el aprovisionador en $aprovisionador (¿se movió infra/fedora/instalar?)"
}

$argumentos = @(
  $aprovisionador,
  "--env-dir=$OdontoEnv",
  "--data-dir=$OdontoDatos",
  "--keys-dir=$OdontoTls",
  "--host=$Nombre",
  "--tz=$TzIana"
)
if ($Ip) { $argumentos += "--ip=$Ip" }
if ($AdminUrl) { $argumentos += "--admin-url=$AdminUrl" }
$pgBin = Get-PgBin
if ($pgBin) { $argumentos += "--pgbin=$pgBin" }
if ($Rotar) { $argumentos += '--rotate' }
if ($SoloVerificar) { $argumentos += '--solo-verificar' }
if ($DryRun) { $argumentos += '--dry-run' }

if ($DryRun) {
  # La URL de administrador se oculta en pantalla: lleva la contraseña de `postgres`.
  $visible = $argumentos | Where-Object { $_ -notlike '--admin-url=*' }
  Escribir-Detalle "[dry-run] node $($visible -join ' ')"
}
else {
  & node @argumentos
  if ($LASTEXITCODE -ne 0) {
    Morir "el aprovisionamiento falló (código $LASTEXITCODE)." $LASTEXITCODE
  }
}

# ── Permisos de los secretos ────────────────────────────────────────────────
# Se fijan aquí y no se delegan: en Fedora systemd lee los `.env` COMO ROOT; aquí los lee
# LocalService (PM2). Por eso la ACL es: Administradores control total, LocalService
# lectura, y **sin herencia** (que no entre «Users» por la carpeta padre).
if (-not $DryRun -and -not $SoloVerificar) {
  $envs = @(Get-ChildItem -Path $OdontoEnv -Filter '*.env' -ErrorAction SilentlyContinue)
  foreach ($f in $envs) { Proteger-Archivo -Ruta $f.FullName -LecturaServicio }
  $pems = @(Get-ChildItem -Path $OdontoTls -Filter '*.pem' -ErrorAction SilentlyContinue)
  foreach ($f in $pems) { Proteger-Archivo -Ruta $f.FullName -LecturaServicio }
  if ($envs.Count -gt 0) {
    Escribir-Ok "permisos revisados: $($envs.Count) archivo(s) .env y $($pems.Count) clave(s)"
  }
}

Escribir-Listo -Numero '2/4' -Texto "Las credenciales viven SOLO en $OdontoEnv y conectan." -Siguiente '.\30-desplegar.ps1'
