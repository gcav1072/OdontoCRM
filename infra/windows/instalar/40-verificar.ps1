# =============================================================================
# OdontoCRM · 4/4 · Verificar el servidor (Windows)
#
# Comprueba el EFECTO, no los archivos: que cada credencial CONECTE, que cada servicio
# ESCUCHE y responda, que el proxy SIRVA la aplicación por HTTPS, que los aparatos de la
# LAN puedan entrar y que el comando `odontocrm` se pueda teclear. Un archivo escrito no es
# una prueba.
#
# Solo lee: no cambia nada. Se puede ejecutar tantas veces como haga falta. (La comprobación
# de los imprimibles deja caer una tarea programada de un solo uso, que borra enseguida, para
# probar la escritura como LocalService — la cuenta real del servicio de PM2 —.)
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
# El código de la respuesta HTTP, VEÁNDOLO todo. `Invoke-WebRequest` no sirve para esto:
# sigue las redirecciones (http → https salía «200» donde hay un 301) y LANZA en los 4xx
# (el SSE sin token devuelve 401 y se veía como «0», como si la URL estuviera rota). Con
# `HttpWebRequest` se ve el código de la PRIMERA respuesta sin leer el cuerpo —que en un SSE
# no termina nunca— y los 4xx/5xx vuelven como números, no como excepciones.
function Get-Codigo { param([string]$Url)
  try {
    $peticion = [Net.HttpWebRequest]::Create($Url)
    $peticion.AllowAutoRedirect = $false
    $peticion.Timeout = 8000
    $peticion.ReadWriteTimeout = 8000
    try {
      $respuesta = $peticion.GetResponse()
      try { return [int]$respuesta.StatusCode } finally { $respuesta.Close() }
    }
    catch [Net.WebException] {
      if ($_.Exception.Response) {
        try { return [int]$_.Exception.Response.StatusCode } finally { $_.Exception.Response.Close() }
      }
      return 0
    }
  }
  catch { return 0 }
}

# ── 1/9 · Credenciales y usuarios ───────────────────────────────────────────
Escribir-Paso '1/9 · Credenciales y usuarios: cada credencial tiene que conectar'
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

# ── 2/9 · Los procesos ──────────────────────────────────────────────────────
Escribir-Paso "2/9 · Los $($info.procesos.Count) procesos (PM2)"
if ($Rapido) { Escribir-Detalle 'omitido (--rapido)' }
else {
  $crudo = $null
  # El `pm2` de la máquina: si esta comprobación corre en la MISMA sesión que acaba de instalar
  # PM2, el PATH de aquí es anterior al servicio y apuntaría al `pm2` del usuario.
  #
  # Y el servicio se comprueba ANTES de invocar nada: `pm2` arranca un demonio si no lo encuentra,
  # así que una comprobación no puede lanzarlo a la ligera —ese demonio sería de ESTA cuenta, se
  # quedaría con los «pipes» globales de PM2 y el servicio ya no podría arrancar—. Se informa en
  # vez de crearlo sin querer. Y la llamada va con techo de tiempo: este mismo `jlist` se quedó
  # colgado para siempre en la instalación del 2026-10-15.
  if (-not (Confirmar-ServicioPm2 -Segundos 3)) {
    Fallo 'el servicio de PM2 no está en marcha (Get-Service pm2*)'
  }
  else {
    $resultado = Invocar-Pm2 -Argumentos @('jlist') -Segundos 20
    if ($resultado.Codigo -eq 0) { $crudo = $resultado.Salida }
    elseif ($resultado.TiempoAgotado) {
      Fallo 'el demonio de PM2 no respondió a `pm2 jlist` (agotado el tiempo de espera)'
      $null = Clear-DemoniosSueltos
    }
    else { Fallo "«pm2 jlist» salió con código $($resultado.Codigo): no puedo leer los procesos" }
  }
  $lista = $null
  if ($crudo) {
    # El JSON COMPLETO de `pm2 jlist` no lo puede parsear PowerShell 5.1: el `env` de cada
    # proceso trae `username` y `USERNAME` —claves que solo difieren en mayúsculas— y
    # `ConvertFrom-Json` las da por duplicadas y LANZA. Se lo come Node (tools/pm2-resumen.mjs)
    # y de vuelta solo llega nombre y estado: esto dejó la verificación del 2026-10-15 diciendo
    # «no está en PM2» diez veces con los diez procesos en marcha.
    $resumen = Join-Path $OdontoRepo 'tools\pm2-resumen.mjs'
    if (Test-Path $resumen) {
      $salida = $crudo | & node $resumen 2>$null
      if ($LASTEXITCODE -eq 0 -and $salida) {
        try { $lista = ($salida -join "`n") | ConvertFrom-Json } catch { }
      }
      if (-not $lista) { Fallo 'no pude leer el resumen de `pm2 jlist` (tools\pm2-resumen.mjs): no compruebo los procesos uno a uno' }
    }
    else { Fallo "falta ${resumen}: no puedo leer la lista de procesos de PM2" }
  }

  $fallos = 0
  if ($crudo -and -not $lista) {
    # Sin lista no tiene sentido decir diez veces «no está en PM2»: el fallo ya está dicho arriba.
    $fallos = 1
  }
  else {
    foreach ($p in $info.procesos) {
      $nombre = $p.proceso
      $app = if ($lista) { $lista | Where-Object { $_.nombre -eq $nombre } | Select-Object -First 1 } else { $null }
      if (-not $app) { Fallo "$nombre no está en PM2"; $fallos++; continue }
      if ($app.estado -ne 'online') { Fallo "$nombre está en $($app.estado)"; $fallos++; continue }
      $health = Get-Codigo "http://127.0.0.1:$($p.puerto)/health"
      $ready = Get-Codigo "http://127.0.0.1:$($p.puerto)/ready"
      if ($health -eq 200 -and $ready -eq 200) { Escribir-Ok "$($p.nombre) :$($p.puerto) /health 200 · /ready 200" }
      else { Fallo "$($p.nombre) :$($p.puerto) /health $health · /ready $ready"; $fallos++ }
    }
    if ($fallos -eq 0) { Escribir-Ok "los $($info.procesos.Count) procesos están bien" }
  }
}

# ── 3/9 · Los imprimibles (Chromium) ────────────────────────────────────────
# El PDF del récipe, la factura y los reportes se componen con Chromium (Playwright).
# Que `chrome.exe` exista no prueba nada: lo que importa es que el SERVICIO pueda usarlo.
# El 2026-10-15 los imprimibles volvían con «EPERM … mkdtemp '…\Temp\playwright-artifacts…'»:
# los procesos de PM2 heredaban el `%TEMP%` de la consola del administrador que los lanzó y
# LocalService (su cuenta) no puede escribir ahí. Por eso se comprueba el EFECTO: (a) que el
# servicio escriba de verdad en la carpeta temporal y (b) que salga un PDF con el MISMO
# entorno que tendrán los procesos (`ecosystem.produccion.config.cjs` fija TMP/TEMP/TMPDIR
# en data\tmp).
Escribir-Paso '3/9 · Los imprimibles (récipe, factura y reportes: Chromium)'
if (-not (Test-Navegador)) {
  Fallo "no hay Chromium en ${OdontoPlaywright}: los PDF devolverán 503"
  Escribir-Detalle 'se baja con la pieza 3:  .\30-desplegar.ps1'
}
elseif (-not (Test-EscrituraServicio -Ruta $OdontoTmp)) {
  Fallo "LocalService no puede escribir en ${OdontoTmp}: los PDF fallarán con «EPERM … mkdtemp»"
  Escribir-Detalle 'se arregla con la pieza 1:  .\10-preparar.ps1  (crea la carpeta con su permiso)'
}
elseif (-not (Probar-Pdf -Titulo 'el PDF de prueba')) {
  Fallo 'Chromium no pudo componer el PDF de prueba: los imprimibles fallarán'
  Escribir-Detalle 'repite la pieza 3:  .\30-desplegar.ps1  (el error exacto queda arriba)'
}

# ── 4/9 · La aplicación por HTTPS ───────────────────────────────────────────
Escribir-Paso '4/9 · La aplicación por HTTPS'
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

# ── 5/9 · El certificado ────────────────────────────────────────────────────
Escribir-Paso '5/9 · Certificado'
$cert = Join-Path $OdontoTls 'odontocrm.crt'
if (-not (Test-Path $cert)) {
  Fallo "no hay certificado en $cert — ejecuta .\30-desplegar.ps1"
}
else {
  try {
    $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert)
    Escribir-Ok "certificado válido hasta $($x509.NotAfter.ToString('yyyy-MM-dd'))"
    # Por OID (2.5.29.17): `FriendlyName` está localizado en Windows en español («Nombre
    # alternativo del sujeto») y el patrón inglés no engancha: todo parecía «NO cubierto».
    $san = $x509.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
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

# ── 6/9 · Firewall: abierto lo que debe, cerrado lo que no ──────────────────
Escribir-Paso '6/9 · Firewall'
if ($Rapido) { Escribir-Detalle 'omitido (--rapido)' }
else {
  foreach ($regla in @('OdontoCRM Web (HTTP)', 'OdontoCRM Web (HTTPS)')) {
    if (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue) { Escribir-Ok "regla presente: $regla" }
    else { Fallo "falta la regla de firewall «$regla»: desde otro aparato no cargará" }
  }

  # ¿La red ACTIVA está en un perfil que las reglas cubren? Las reglas solo abren el perfil
  # PRIVADO (a propósito: el servidor no se publica en redes ajenas), y Windows clasifica como
  # pública cualquier red nueva. Con la red en «Público» el 80/443 quedan cerrados CON las dos
  # reglas presentes: las reglas estaban y de la LAN no se llegaba (2026-10-15).
  $publicas = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
      Where-Object { $_.NetworkCategory -eq 'Public' })
  foreach ($red in $publicas) {
    Fallo "la red «$($red.Name)» está en perfil PÚBLICO: las reglas solo abren el privado y desde la LAN no se llega"
    Escribir-Detalle "arreglar:  Set-NetConnectionProfile -InterfaceIndex $($red.InterfaceIndex) -NetworkCategory Private"
    Escribir-Detalle '(o repite .\30-desplegar.ps1, que lo pone solo)'
  }
  if ($publicas.Count -eq 0) { Escribir-Ok 'la red activa está en perfil privado: las reglas la cubren' }

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

# ── 7/9 · Sin secretos en el código ─────────────────────────────────────────
Escribir-Paso '7/9 · Secretos'
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

# ── ¿El código compilado es el del disco? ───────────────────────────────────
# Un `git reset --hard` (o un `checkout`) en el código cambia el FUENTE pero no recompila: el
# servicio sigue con el `dist` viejo. La marca la escribe `npm run postbuild`; si no cuadra,
# se avisa (no es un fallo: el servidor funciona, pero con el código de otro commit).
$avisoDist = Get-AvisoDistViejo
if ($avisoDist) {
  Escribir-Aviso "el código compilado NO es el del disco: $avisoDist"
  Escribir-Detalle 'recompila:  odontocrm recompilar   (o «npm run build» en el código)'
}
elseif (Test-Path (Join-Path $OdontoCode '.odontocrm-build-commit')) {
  Escribir-Ok 'el código compilado es el del disco'
}

# ── 8/9 · Cifrado del almacén y respaldos restaurables ───────────────────────
# Dos comprobaciones que **no** cambian nada: informan de en qué estado está lo que protege
# los datos. El cifrado del almacén se activa solo; migrar los archivos viejos lo decide el
# operador (por eso aquí se informa y no se falla).
Escribir-Paso '8/9 · Cifrado del almacén y respaldos restaurables'

# ¿Tienen los servicios que guardan archivos su clave de cifrado?
$sinClave = @()
$conAlmacen = @()
# El campo es `nombre` (no `name`): con `Set-StrictMode` `$info.servicios.name` lanza
# «no se encuentra la propiedad 'name'» y la verificación MORÍA en mitad del último paso
# (2026-10-14).
foreach ($servicio in @($info.servicios | ForEach-Object { $_.nombre })) {
  $archivo = Join-Path $OdontoEnv "$servicio.env"
  if (-not (Test-Path $archivo)) { continue }
  $contenido = Get-Content $archivo -Raw -ErrorAction SilentlyContinue
  if ($contenido -notmatch '(?m)^STORAGE_DIR=') { continue }
  $conAlmacen += $servicio
  if ($contenido -notmatch '(?m)^STORAGE_ENCRYPTION_KEY=.{20,}') { $sinClave += $servicio }
}
if ($conAlmacen.Count -eq 0) {
  Escribir-Aviso 'ningún servicio declara STORAGE_DIR: el almacén se escribe donde diga el código'
}
elseif ($sinClave.Count -eq 0) {
  Escribir-Ok "cifrado en reposo configurado ($($conAlmacen -join ', '))"
}
else {
  Fallo "sin STORAGE_ENCRYPTION_KEY: $($sinClave -join ', ') — los archivos se guardan SIN cifrar"
  Escribir-Detalle 'el aprovisionador la escribe; si falta, corre .\20-aprovisionar.ps1 otra vez'
}

# ¿Cuántos archivos del almacén quedan en claro? Migrar es decisión del operador.
$almacen = Join-Path $OdontoDatos 'storage'
if (Test-Path $almacen) {
  $archivos = Get-ChildItem -Path $almacen -Recurse -File -ErrorAction SilentlyContinue
  $total = @($archivos).Count
  # Los archivos cifrados empiezan por `ODBLOB`; cualquier otro está en claro. Se leen los
  # primeros seis bytes de cada uno.
  $enClaro = 0
  foreach ($archivo in $archivos) {
    try {
      $fs = [IO.File]::OpenRead($archivo.FullName)
      $buffer = New-Object byte[] 6
      $leidos = $fs.Read($buffer, 0, 6)
      $fs.Close()
      if ($leidos -lt 6 -or [Text.Encoding]::ASCII.GetString($buffer) -ne 'ODBLOB') { $enClaro++ }
    }
    catch { $enClaro++ }
  }
  if ($total -eq 0) { Escribir-Detalle 'el almacén está vacío (todavía no hay radiografías ni PDFs)' }
  elseif ($enClaro -eq 0) { Escribir-Ok "el almacén está cifrado entero ($total archivo(s))" }
  else {
    Escribir-Aviso "$enClaro de $total archivo(s) del almacén siguen en claro"
    Escribir-Detalle 'para pasarlos:  node tools\recifrar-almacen.mjs'
    Escribir-Detalle 'primero mira qué hay:  node tools\recifrar-almacen.mjs --estado'
  }
}
else { Escribir-Detalle "no hay almacén todavía en $almacen" }

# ¿Se puede restaurar el último respaldo? Con **una** base (la de pacientes): el simulacro
# completo es el trabajo del temporizador semanal; aquí se comprueba que el camino funciona.
$nodeVerificar = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodeVerificar) {
  $respaldos = Get-ChildItem -Path $OdontoBackups -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object Name -Descending
  if (-not $respaldos) {
    Escribir-Aviso 'no hay ningún respaldo que probar todavía (el primero corre de madrugada)'
    Escribir-Detalle 'para probarlo a mano:  node tools\verify-backup.mjs'
  }
  else {
    $ultimo = $respaldos[0]
    $salida = & $nodeVerificar (Join-Path $OdontoRepo 'tools\verify-backup.mjs') `
      --from $ultimo.FullName --db odonto_patients --sin-aviso 2>&1
    if ($LASTEXITCODE -eq 0) {
      Escribir-Ok "el último respaldo ($($ultimo.Name)) se restaura y los datos están"
    }
    else {
      Fallo "el último respaldo ($($ultimo.Name)) NO se pudo restaurar"
      Escribir-Detalle "míralo:  node tools\verify-backup.mjs --from \"$($ultimo.FullName)\""
    }
    $salida | Select-Object -Last 3 | ForEach-Object { Escribir-Detalle "  $_" }
  }
}
else { Escribir-Aviso 'no encuentro node: no puedo probar el respaldo' }

# ── 9/9 · El comando odontocrm ───────────────────────────────────────────────
# El día a día del servidor se maneja con `odontocrm` (estado, respaldar, alertas…), y «la
# instalación terminó sin errores» no basta: el lanzador tiene que estar EN EL PATH de la
# máquina y su guion tiene que viajar con él. El 2026-10-16 una instalación limpia dejó
# `C:\ProgramData\OdontoCRM\bin\cmd` fuera del PATH —10-preparar.ps1 la registraba antes de
# crearla y `Add-RutaAlPath` la ignoraba en silencio— y teclear «odontocrm» no servía.
Escribir-Paso '9/9 · El comando odontocrm'
$lanzador = Join-Path $OdontoCmd 'odontocrm.cmd'
$guionCli = Join-Path $OdontoCmd 'odontocrm.ps1'
if (-not (Test-Path $lanzador) -or -not (Test-Path $guionCli)) {
  Fallo "el comando odontocrm no está instalado en $OdontoCmd"
  Escribir-Detalle 'lo instala la pieza 3:  .\30-desplegar.ps1'
}
elseif (-not (([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') -contains $OdontoCmd)) {
  Fallo "$OdontoCmd no está en el PATH de la máquina: «odontocrm» no se reconoce al teclearlo"
  Escribir-Detalle 'se arregla con la pieza 1:  .\10-preparar.ps1   (luego abre una consola nueva)'
}
elseif (-not (Test-Comando odontocrm)) {
  Escribir-Aviso 'el PATH está bien, pero esta consola es anterior al cambio: ábrela de nuevo'
  Escribir-Detalle "el comando está instalado en $lanzador"
}
else {
  Escribir-Ok "«odontocrm» se teclea y responde (desde $OdontoCmd)"
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
