# =============================================================================
# OdontoCRM · 4/4 · Verificar el servidor (Windows)
#
# Comprueba el EFECTO, no los archivos: que cada credencial CONECTE, que cada servicio
# ESCUCHE y responda, que el proxy SIRVA la aplicación por HTTPS y que los aparatos de la
# LAN puedan entrar. Un archivo escrito no es una prueba.
#
# Solo lee: no cambia nada. Se puede ejecutar tantas veces como haga falta.
#
#   .\40-verificar.ps1            # todo
#   .\40-verificar.ps1 --rapido   # sin las comprobaciones de red
#
# Sale con código 0 si todo está bien y 1 si hay algo que arreglar.
#
# Espejo de `infra/fedora/instalar/40-verificar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Rapido = Test-Bandera $args 'rapido'
$Problemas = 0
function Fallo { param([string]$Texto) Escribir-Error $Texto; $script:Problemas++ }

Write-Host ''
Write-Host 'OdontoCRM · 4/4 · Verificar (Windows)' -ForegroundColor White
$Ip = Get-IpLan
$info = Get-Info

# Aceptar el certificado interno SOLO para estas comprobaciones locales (PS 5.1).
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
function Get-Codigo { param([string]$Url)
  try { return [int](Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8).StatusCode } catch { return 0 }
}

# ── 1/6 · Credenciales y usuarios ───────────────────────────────────────────
Escribir-Paso '1/6 · Credenciales y usuarios: cada credencial tiene que conectar'
if (-not (Test-Path (Join-Path $OdontoEnv 'odontocrm.env'))) {
  Fallo "no hay entorno en $OdontoEnv — falta ejecutar .\20-aprovisionar.ps1"
}
else {
  $aprovisionador = Join-Path $OdontoRepo 'infra\fedora\instalar\aprovisionar.mjs'
  $pgBin = Get-PgBin
  $argumentos = @($aprovisionador, "--env-dir=$OdontoEnv", "--data-dir=$OdontoDatos", "--keys-dir=$OdontoTls", '--solo-verificar')
  if ($pgBin) { $argumentos += "--pgbin=$pgBin" }
  & node @argumentos
  if ($LASTEXITCODE -eq 0) { Escribir-Ok 'las credenciales conectan y los secretos compartidos coinciden' }
  else {
    Fallo 'alguna credencial NO conecta (arriba se dice cuál y qué archivo revisar)'
    Escribir-Detalle 'se arregla volviendo a aprovisionar:  .\20-aprovisionar.ps1'
  }

  # ¿Y se puede ENTRAR? Un servidor con los servicios sanos y sin usuarios deja a la
  # consulta fuera, y el resumen diría «listo para la consulta». Se comprueba el EFECTO.
  $urlId = Get-ValorEnv -Archivo (Join-Path $OdontoEnv 'identity.env') -Clave 'DATABASE_URL'
  if (-not $urlId) { Escribir-Aviso 'no pude leer la credencial de identidad para contar los usuarios' }
  elseif (-not $pgBin) { Escribir-Aviso 'no encuentro psql para contar los usuarios' }
  else {
    try {
      $uri = [Uri]$urlId
      $usuario = $uri.UserInfo.Split(':')[0]
      $clave = [Uri]::UnescapeDataString($uri.UserInfo.Split(':')[1])
      $base = $uri.AbsolutePath.TrimStart('/')
      $anterior = $env:PGPASSWORD
      $env:PGPASSWORD = $clave
      try {
        $cuantos = & (Join-Path $pgBin 'psql.exe') -X -w -tAc 'select count(*) from users' -h 127.0.0.1 -p 5432 -U $usuario -d $base 2>$null
      }
      finally { if ($null -eq $anterior) { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $anterior } }
      if ($cuantos -match '^\d+$' -and [int]$cuantos -gt 0) { Escribir-Ok "hay $cuantos usuario(s) con los que entrar" }
      else { Fallo 'NO hay usuarios en la base de identidad: nadie puede iniciar sesión' }
    }
    catch { Escribir-Aviso "no pude contar los usuarios: $($_.Exception.Message)" }
  }
}

# ── 2/6 · Los procesos ──────────────────────────────────────────────────────
Escribir-Paso "2/6 · Los $($info.procesos.Count) procesos (PM2)"
if ($Rapido) { Escribir-Detalle 'omitido (--rapido)' }
else {
  $crudo = $null
  try { $crudo = & pm2 jlist 2>$null } catch { }
  $lista = $null
  if ($crudo) {
    $desde = $crudo.IndexOf('['); $hasta = $crudo.LastIndexOf(']')
    if ($desde -ge 0 -and $hasta -gt $desde) {
      try { $lista = $crudo.Substring($desde, $hasta - $desde + 1) | ConvertFrom-Json } catch { }
    }
  }

  $fallos = 0
  foreach ($p in $info.procesos) {
    $nombre = $p.proceso
    $app = if ($lista) { $lista | Where-Object { $_.name -eq $nombre } | Select-Object -First 1 } else { $null }
    if (-not $app) { Fallo "$nombre no está en PM2"; $fallos++; continue }
    if ($app.pm2_env.status -ne 'online') { Fallo "$nombre está en $($app.pm2_env.status)"; $fallos++; continue }
    $health = Get-Codigo "http://127.0.0.1:$($p.puerto)/health"
    $ready = Get-Codigo "http://127.0.0.1:$($p.puerto)/ready"
    if ($health -eq 200 -and $ready -eq 200) { Escribir-Ok "$($p.nombre) :$($p.puerto) /health 200 · /ready 200" }
    else { Fallo "$($p.nombre) :$($p.puerto) /health $health · /ready $ready"; $fallos++ }
  }
  if ($fallos -eq 0) { Escribir-Ok "los $($info.procesos.Count) procesos están bien" }
}

# ── 3/6 · La aplicación por HTTPS ───────────────────────────────────────────
Escribir-Paso '3/6 · La aplicación por HTTPS'
if ($Rapido) { Escribir-Detalle 'omitido (--rapido)' }
else {
  $servicio = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
  if (-not $servicio -or $servicio.Status -ne 'Running') { Fallo 'el servicio de Caddy no está corriendo' }
  else { Escribir-Ok 'servicio caddy activo' }

  $spa = Get-Codigo 'https://127.0.0.1/'
  $api = Get-Codigo 'https://127.0.0.1/api/v1/meta'
  $redirect = Get-Codigo 'http://127.0.0.1/'
  if ($spa -eq 200) { Escribir-Ok 'la interfaz se sirve por HTTPS (200)' } else { Fallo "la interfaz devolvió $spa" }
  if ($api -eq 200) { Escribir-Ok 'la API llega al gateway por el proxy (200)' } else { Fallo "la API devolvió $api" }
  if ($redirect -eq 301 -or $redirect -eq 308) { Escribir-Ok "http redirige a https ($redirect)" } else { Escribir-Aviso "http devolvió $redirect (se esperaba 301)" }

  # La CA en los formatos que piden los aparatos: si esto falla, cada equipo tendría que
  # copiarla a mano y el aviso de certificado no se quitaría nunca.
  $ca = Get-Codigo 'http://127.0.0.1/ca.crt'
  if ($ca -eq 200) { Escribir-Ok 'la CA se descarga desde http://<servidor>/ca.crt' } else { Fallo "no pude descargar la CA ($ca)" }
  foreach ($formato in @('ca.der', 'ca-windows.ps1', 'ca-linux.sh')) {
    $c = Get-Codigo "http://127.0.0.1/$formato"
    if ($c -eq 200) { Escribir-Ok "  /$formato disponible" } else { Escribir-Aviso "  /$formato devolvió $c" }
  }

  # El SSE de las pantallas: sin búfer, o la pantalla de la sala se queda congelada.
  $sse = Get-Codigo 'https://127.0.0.1/api/v1/screens/lobby/stream'
  if ($sse -in @(200, 401, 403)) { Escribir-Ok "las pantallas SSE llegan al servicio ($sse sin token: correcto)" }
  else { Escribir-Aviso "el SSE devolvió $sse" }
}

# ── 4/6 · El certificado ────────────────────────────────────────────────────
Escribir-Paso '4/6 · Certificado'
$cert = Join-Path $OdontoTls 'odontocrm.crt'
if (-not (Test-Path $cert)) {
  Fallo "no hay certificado en $cert — ejecuta .\30-desplegar.ps1"
}
else {
  try {
    $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert)
    Escribir-Ok "certificado válido hasta $($x509.NotAfter.ToString('yyyy-MM-dd'))"
    $san = $x509.Extensions | Where-Object { $_.Oid.FriendlyName -like '*Subject Alternative Name*' }
    $textoSan = if ($san) { $san.Format($false) } else { '' }
    foreach ($esperado in @($Ip)) {
      if ($esperado -and $textoSan -like "*$esperado*") { Escribir-Ok "  cubre $esperado" }
      elseif ($esperado) { Fallo "  NO cubre ${esperado}: los equipos que entren así verán un aviso" }
    }
  }
  catch {
    Fallo "el certificado no se puede leer: $($_.Exception.Message)"
  }
}

# ── 5/6 · Firewall: abierto lo que debe, cerrado lo que no ──────────────────
Escribir-Paso '5/6 · Firewall'
if ($Rapido) { Escribir-Detalle 'omitido (--rapido)' }
else {
  foreach ($regla in @('OdontoCRM Web (HTTP)', 'OdontoCRM Web (HTTPS)')) {
    if (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue) { Escribir-Ok "regla presente: $regla" }
    else { Fallo "falta la regla de firewall «$regla»: desde otro aparato no cargará" }
  }

  # Lo que NO debe estar publicado: la base, cada servicio y la puerta. Se mira a qué
  # dirección escucha cada puerto; lo que solo está en 127.0.0.1/::1 está bien.
  $publicados = 0
  foreach ($puerto in $info.puertosInternos) {
    $oyentes = Get-NetTCPConnection -State Listen -LocalPort $puerto -ErrorAction SilentlyContinue
    foreach ($o in $oyentes) {
      if ($o.LocalAddress -notin @('127.0.0.1', '::1')) {
        Fallo "el puerto $puerto escucha en $($o.LocalAddress) y no debería (va por dentro)"
        $publicados++
      }
    }
  }
  if ($publicados -eq 0) { Escribir-Ok 'la base de datos y los servicios internos NO están publicados' }
}

# ── 6/6 · Sin secretos en el código ─────────────────────────────────────────
Escribir-Paso '6/6 · Secretos'
if (-not (Test-Path $OdontoCode)) { Escribir-Aviso "todavía no hay código desplegado en $OdontoCode" }
else {
  $filtrados = Get-ChildItem -Path $OdontoCode -Recurse -Depth 3 -Filter '.env' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*node_modules*' } | Select-Object -First 5
  if ($filtrados) {
    Fallo "hay .env dentro de ${OdontoCode}: los secretos viven SOLO en $OdontoEnv"
    $filtrados | ForEach-Object { Escribir-Detalle $_.FullName }
  }
  else { Escribir-Ok "el código de $OdontoCode no contiene secretos (ni un .env)" }
}

# ── Resumen ─────────────────────────────────────────────────────────────────
Write-Host ''
if ($Problemas -eq 0) {
  Write-Host '✔ Todo correcto. El servidor está listo para la consulta.' -ForegroundColor Green
  Write-Host ''
}
else {
  Write-Host "✖ $Problemas problema(s). Arriba está cada uno con lo que le falta." -ForegroundColor Red
}

Write-Host 'Cómo entrar desde los demás aparatos' -ForegroundColor White
Write-Host '  1. En cada equipo, abre esta dirección UNA vez para instalar el certificado:'
Write-Host "       http://$Ip/ca.crt            (Android, Linux)"
Write-Host "       http://$Ip/ca.der            (Windows: doble clic)"
Write-Host "       o en PowerShell:  irm http://$Ip/ca-windows.ps1 | iex"
Write-Host '  2. Y entra en la aplicación:'
Write-Host "       https://$Ip"
Write-Host ''
Write-Host '  Para mirar cómo va:  .\40-verificar.ps1  ·  pm2 status' -ForegroundColor DarkGray
Write-Host ''

if ($Problemas -eq 0) { exit 0 } else { exit 1 }
