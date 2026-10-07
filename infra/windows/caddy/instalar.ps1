# =============================================================================
# OdontoCRM · instalar el reverse proxy con TLS interno (Windows · ADR 0050)
#
#   .\instalar.ps1 --nombre=odontocrm --ip=192.168.1.50
#
# Hace, en orden y de forma idempotente:
#   1. Copia el Caddyfile versionado sustituyendo los marcadores (__CA__, __TLS__, __CODE__).
#   2. Publica la CA en los formatos que pide cada aparato (crt, der y los dos scripts).
#   3. Registra Caddy como servicio de Windows (LocalService) y lo arranca o lo recarga.
#
# El certificado tiene que existir ANTES (lo emite 30-desplegar.ps1): este guion no lo
# emite, para no pisar un certificado propio de la clínica.
#
# Es el equivalente de `infra/fedora/nginx/instalar.sh`.
# =============================================================================

. "$PSScriptRoot\..\instalar\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Nombre = Get-Argumento $args 'nombre'
$Ip = Get-Argumento $args 'ip'
$DryRun = Test-Bandera $args 'dry-run'
if (-not $DryRun) { Afirmar-Administrador }
if ((-not $Nombre) -or (-not $Ip)) { Morir 'uso: instalar.ps1 --nombre=<nombre> --ip=<ip> [--dry-run]' }

$plantilla = Join-Path $PSScriptRoot 'Caddyfile'
$destinoConf = Join-Path $OdontoEtc 'Caddyfile'
$caddy = Join-Path $OdontoBin 'caddy.exe'
$cert = Join-Path $OdontoTls 'odontocrm.crt'
$clave = Join-Path $OdontoTls 'odontocrm.key'

if (-not (Test-Path $plantilla)) { Morir "no encuentro $plantilla" }
if ((-not (Test-Path $cert)) -or (-not (Test-Path $clave))) {
  if ($DryRun) {
    Escribir-Aviso "aún no hay certificado en $OdontoTls (lo emitiría 30-desplegar.ps1); sigo porque es --dry-run"
  }
  else {
    Morir "faltan el certificado o su clave ($cert, $clave): ejecuta antes 30-desplegar.ps1"
  }
}
if ((-not (Test-Path $caddy)) -and (-not $DryRun)) {
  Morir "no encuentro caddy.exe en $OdontoBin (lo baja 10-preparar.ps1)"
}

Write-Host ''
Write-Host 'OdontoCRM · reverse proxy (Caddy)' -ForegroundColor White
Escribir-Detalle "nombre → $Nombre   IP → $Ip"

# ── 1. El Caddyfile, con las rutas del despliegue ────────────────────────────
# Caddy escribe las rutas con barras normales, así que se pasan a `/` (no a `\`).
function A-Barras { param([string]$Ruta) return ($Ruta -replace '\\', '/') }

$contenido = Get-Content -Raw -Encoding UTF8 $plantilla
$contenido = $contenido.Replace('__CA__', (A-Barras $OdontoCaPub))
$contenido = $contenido.Replace('__TLS__', (A-Barras $OdontoTls))
$contenido = $contenido.Replace('__CODE__', (A-Barras $OdontoCode))

Invocar "escribir $destinoConf" {
  New-Item -ItemType Directory -Force -Path $OdontoEtc | Out-Null
  # Sin BOM: Caddy lee el archivo como UTF-8 y un BOM al principio rompe el primer bloque.
  [IO.File]::WriteAllText($destinoConf, $contenido, (New-Object System.Text.UTF8Encoding($false)))
}
if (-not $DryRun) {
  Escribir-Ok "Caddyfile instalado en $destinoConf"
  Proteger-Archivo -Ruta $destinoConf -LecturaServicio
}

# ── 2. La CA en los formatos de cada aparato ─────────────────────────────────
# La CA es un certificado PÚBLICO (no un secreto). Se sirve desde $OdontoCaPub, que es una
# carpeta legible por el servicio del proxy.
$origenCa = Join-Path $OdontoTls 'odontocrm-ca.crt'
if (Test-Path $origenCa) {
  if ($DryRun) {
    Escribir-Detalle "[dry-run] publicar la CA en $OdontoCaPub (crt, der y los dos scripts)"
  }
  else {
    New-Item -ItemType Directory -Force -Path $OdontoCaPub | Out-Null
    Copy-Item -Path $origenCa -Destination (Join-Path $OdontoCaPub 'odontocrm-ca.crt') -Force

    # DER para Windows (doble clic → Instalar certificado).
    try {
      $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($origenCa)
      $der = $x509.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
      [IO.File]::WriteAllBytes((Join-Path $OdontoCaPub 'odontocrm-ca.der'), $der)
      Escribir-Ok 'CA publicada en PEM y DER'
    }
    catch {
      Escribir-Aviso "no pude generar el DER de la CA (Windows tendrá que usar el .crt): $($_.Exception.Message)"
    }

    # Los scripts de un comando. Se escribe la IP con la que se sirve AHORA; si el servidor
    # cambia de red, `odontocrm red --arreglar` los vuelve a generar (Windows se entra por IP).
    $ps1 = @"
# OdontoCRM · instalar la CA interna en Windows (PowerShell COMO ADMINISTRADOR)
#   irm http://$Ip/ca-windows.ps1 | iex
`$ErrorActionPreference = 'Stop'
`$destino = Join-Path `$env:TEMP 'odontocrm-ca.der'
Invoke-WebRequest -Uri 'http://$Ip/ca.der' -OutFile `$destino -UseBasicParsing
Import-Certificate -FilePath `$destino -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Write-Host 'CA instalada. Cierra y vuelve a abrir el navegador.' -ForegroundColor Green
"@
    [IO.File]::WriteAllText((Join-Path $OdontoCaPub 'ca-windows.ps1'), $ps1, (New-Object System.Text.UTF8Encoding($true)))

    $sh = @"
#!/usr/bin/env bash
# OdontoCRM · instalar la CA interna en Linux (Fedora/RHEL y Debian/Ubuntu)
set -uo pipefail
[[ "`$(id -u)" == 0 ]] || { echo 'se necesita sudo'; exit 1; }
tmp="`$(mktemp -d)"; trap 'rm -rf "`$tmp"' EXIT
curl -fsSL --max-time 10 'http://$Ip/ca.crt' -o "`$tmp/odontocrm-ca.crt" || {
  echo '✖ No pude descargar la CA de http://$Ip' >&2; exit 1; }
if [[ -d /etc/pki/ca-trust/source/anchors ]]; then
  install -m 0644 "`$tmp/odontocrm-ca.crt" /etc/pki/ca-trust/source/anchors/ && update-ca-trust
elif [[ -d /usr/local/share/ca-certificates ]]; then
  install -m 0644 "`$tmp/odontocrm-ca.crt" /usr/local/share/ca-certificates/odontocrm-ca.crt && update-ca-certificates
else
  echo 'no encontré el almacén del sistema'; exit 1
fi
echo '✔ CA instalada.'
"@
    [IO.File]::WriteAllText((Join-Path $OdontoCaPub 'ca-linux.sh'), $sh, (New-Object System.Text.UTF8Encoding($false)))
    Escribir-Ok 'scripts de un comando publicados (ca-windows.ps1 y ca-linux.sh)'
  }
}
else {
  Escribir-Aviso "no encuentro la CA ($origenCa): los equipos no podrán quitarse el aviso"
}

# ── 3. El servicio de Windows ────────────────────────────────────────────────
# Caddy en Windows no se «recarga» como servicio: se le dice a Caddy directamente
# (`caddy reload`), que es lo que documenta el propio proyecto. El servicio solo lo mantiene vivo.
$servicio = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
$binPath = "`"$caddy`" run --config `"$destinoConf`""

if ($DryRun) {
  if ($servicio) { Escribir-Detalle "[dry-run] sc.exe config caddy binPath= $binPath && restart" }
  else { Escribir-Detalle "[dry-run] sc.exe create caddy start= auto binPath= $binPath obj= LocalService" }
}
else {
  # Validar ANTES de tocar el servicio: un Caddyfile roto dejaría el proxy caído.
  & $caddy validate --config $destinoConf *> (Join-Path $env:TEMP 'odontocrm-caddy-validate.log')
  if ($LASTEXITCODE -ne 0) {
    Get-Content (Join-Path $env:TEMP 'odontocrm-caddy-validate.log') -Tail 10 -ErrorAction SilentlyContinue |
      ForEach-Object { Escribir-Detalle $_ }
    Morir 'el Caddyfile no es válido: no toco el servicio'
  }
  Escribir-Ok 'Caddyfile válido'

  if ($servicio) {
    Invocar 'actualizar el binPath del servicio caddy' {
      & sc.exe config caddy binPath= $binPath | Out-Null
    }
    Restart-Service -Name 'caddy' -Force
    Escribir-Ok 'servicio caddy reiniciado'
  }
  else {
    Invocar 'crear el servicio caddy (arranque automático, LocalService)' {
      # `sc.exe` quiere espacio DESPUÉS de cada `=`; es una rareza de su sintaxis.
      & sc.exe create caddy start= auto binPath= $binPath obj= 'NT AUTHORITY\LocalService' | Out-Null
      & sc.exe description caddy 'OdontoCRM · reverse proxy con TLS interno (Caddy)' | Out-Null
    }
    Start-Service -Name 'caddy'
    Escribir-Ok 'servicio caddy creado y arrancado'
  }

  # Recargar el proxy si ya estaba corriendo (aplica el Caddyfile nuevo sin cortar).
  & $caddy reload --config $destinoConf *> $null
}

# ── Comprobación rápida (sin sesión) ────────────────────────────────────────
if (-not $DryRun) {
  Start-Sleep -Seconds 2

  # La comprobación es contra 127.0.0.1 con el certificado interno, que el propio servidor
  # ya tiene por bueno en el almacén; aun así, en PowerShell 5.1 `Invoke-WebRequest` puede
  # quejarse. Se acepta el certificado SOLO para esta comprobación local.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    try {
      Add-Type -TypeDefinition @'
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class OdontoTrustAll : ICertificatePolicy {
  public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problema) { return true; }
}
'@ -ErrorAction SilentlyContinue
      [System.Net.ServicePointManager]::CertificatePolicy = New-Object OdontoTrustAll
    }
    catch { }
  }

  function Get-CodigoLocal {
    param([string]$Url)
    try { return [int](Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 6).StatusCode }
    catch { return 0 }
  }

  $spa = Get-CodigoLocal 'https://127.0.0.1/'
  if ($spa -eq 200) { Escribir-Ok 'la SPA se sirve por https' } else { Escribir-Aviso "la SPA devolvió $spa" }

  $api = Get-CodigoLocal 'https://127.0.0.1/api/v1/meta'
  if ($api -eq 200) { Escribir-Ok 'la API llega por el proxy' } else { Escribir-Aviso "la API devolvió $api (¿el gateway arrancado?)" }

  $ca = Get-CodigoLocal 'http://127.0.0.1/ca.crt'
  if ($ca -eq 200) { Escribir-Ok 'la CA se descarga en http://<servidor>/ca.crt' } else { Escribir-Aviso "la CA respondió $ca" }
}
