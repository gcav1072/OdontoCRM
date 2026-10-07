# =============================================================================
# OdontoCRM · comandos del servidor (una sola puerta) — Windows
#
#   odontocrm                 # ayuda
#   odontocrm estado          # tablero completo (con el entorno de producción)
#   odontocrm alertas         # solo los problemas; código 1 si hay alguno
#   odontocrm respaldar       # respaldo ahora (bases + configuración)
#   odontocrm verificar       # los procesos, HTTPS y la CA
#   odontocrm servicios       # estado de los procesos con PM2
#   odontocrm logs clinical   # últimos registros de un servicio
#   odontocrm actualizar      # traer el código nuevo y reiniciar
#
# Existe para que en la clínica no haya que recordar rutas, «Ejecutar como
# administrador» ni en qué orden se carga todo. Cada orden delega en el guion que ya
# está probado: aquí solo se pone el entorno correcto y se dice qué se está haciendo.
#
# Espejo de `infra/fedora/odontocrm`.
# =============================================================================

# La biblioteca vive en el código desplegado (el lanzador instalado apunta aquí).
$__code = if ($env:ODONTOCRM_CODE_DIR) { $env:ODONTOCRM_CODE_DIR } else { 'C:\OdontoCRM' }
$__comun = Join-Path $PSScriptRoot 'instalar\comun.ps1'
if (-not (Test-Path $__comun)) { $__comun = Join-Path $__code 'infra\windows\instalar\comun.ps1' }
if (-not (Test-Path $__comun)) {
  Write-Host "  ✖ no encuentro comun.ps1 (busqué junto a este comando y en $__code\infra\windows\instalar)" -ForegroundColor Red
  Write-Host '    el código desplegado está incompleto: vuelve a ejecutar 30-desplegar.ps1' -ForegroundColor DarkGray
  exit 1
}
. $__comun
trap { Escribir-Corte; exit 1 }

$Orden = if ($args.Count -gt 0) { $args[0] } else { 'ayuda' }
$Resto = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

$info = Get-Info
$puertoGateway = $info.puertoGateway

# Apunta con qué IP quedó todo adaptado: la tarea programada (`red --arreglar --si-cambio`)
# lo mira para no reemitir el certificado ni reiniciar nada mientras la red no cambie.
function Guardar-IpRed {
  param([string]$Ip)
  try {
    if (-not (Test-Path $OdontoDatos)) { New-Item -ItemType Directory -Force -Path $OdontoDatos | Out-Null }
    Set-Content -Path (Join-Path $OdontoDatos 'red-ultima-ip') -Value $Ip -Encoding ASCII
  }
  catch { }
}

function Ayuda {
  Write-Host ''
  Write-Host 'OdontoCRM · comandos del servidor (Windows)' -ForegroundColor White
  Write-Host ''
  Write-Host '  odontocrm estado          Tablero completo: procesos, bases, cola, outbox y alertas.'
  Write-Host '  odontocrm alertas         Solo los problemas. Sale con 1 si hay alguno.'
  Write-Host '  odontocrm respaldar       Respaldo ahora de las bases y de la configuración'
  Write-Host '                            (CONTINENE SECRETOS: custodiar el medio).'
  Write-Host '  odontocrm restaurar ...   Restaurar desde un respaldo (mira --help del guion).'
  Write-Host '  odontocrm verificar       Los procesos, HTTPS, la CA y el firewall.'
  Write-Host '  odontocrm servicios       Estado de los procesos con PM2.'
  Write-Host '  odontocrm logs <servicio|gateway|caddy|postgres> [líneas]'
  Write-Host '  odontocrm actualizar      Trae el código nuevo, compila, migra y reinicia.'
  Write-Host '  odontocrm certificado     Muestra el certificado y la CA, y cómo instalarla'
  Write-Host '                            en tablets, móviles y TVs.'
  Write-Host '  odontocrm credenciales    Comprueba que cada credencial CONECTA (no cambia nada).'
  Write-Host '  odontocrm red [--arreglar]  En qué IP se está sirviendo; --arreglar reemite el'
  Write-Host '                            certificado y actualiza CORS y el proxy con la IP de ahora.'
  Write-Host '  odontocrm con-entorno <servicio> -- <comando>'
  Write-Host '                            Ejecuta una herramienta con el entorno de producción.'
  Write-Host '  odontocrm parar [--todo]  Detiene los servicios (el gateway primero).'
  Write-Host '  odontocrm arrancar        Arranca lo que falte y comprueba.'
  Write-Host '  odontocrm reiniciar       Reinicia todo (aplica configuración).'
  Write-Host '  odontocrm compilar        Solo compila.  ·  odontocrm recompilar  Compila y reinicia.'
  Write-Host '  odontocrm modo-test <on|off|estado>'
  Write-Host ''
  Write-Host "  Directorio del código: $OdontoCode" -ForegroundColor DarkGray
  Write-Host "  Configuración:         $OdontoEnv" -ForegroundColor DarkGray
  Write-Host ''
}

# Ejecuta una herramienta de `tools/` con el entorno de producción y desde el código.
function Invocar-Node {
  param([string[]]$Argumentos)
  Push-Location $OdontoCode
  try {
    $env:ODONTOCRM_ENV_DIR = $OdontoEnv
    $env:NODE_ENV = 'production'
    & node @Argumentos
    return $LASTEXITCODE
  }
  finally {
    Remove-Item Env:\ODONTOCRM_ENV_DIR -ErrorAction SilentlyContinue
    Pop-Location
  }
}

switch ($Orden) {
  { $_ -in @('ayuda', '-h', '--help', 'help') } { Ayuda; exit 0 }

  { $_ -in @('estado', 'status') } {
    Afirmar-Administrador
    exit (Invocar-Node @((Join-Path $OdontoCode 'tools\estado.mjs')) + $Resto)
  }

  'alertas' {
    Afirmar-Administrador
    exit (Invocar-Node @((Join-Path $OdontoCode 'tools\estado.mjs'), '--alertas') + $Resto)
  }

  { $_ -in @('respaldar', 'respaldo') } {
    Afirmar-Administrador
    $guion = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-backup.ps1'
    if (-not (Test-Path $guion)) { $guion = Join-Path $OdontoCode 'infra\windows\backup\odontocrm-backup.ps1' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guion --include-config @Resto
    exit $LASTEXITCODE
  }

  'restaurar' {
    Afirmar-Administrador
    $guion = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-restore.ps1'
    if (-not (Test-Path $guion)) { $guion = Join-Path $OdontoCode 'infra\windows\backup\odontocrm-restore.ps1' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guion @Resto
    exit $LASTEXITCODE
  }

  'verificar' {
    Afirmar-Administrador
    $guion = Join-Path $OdontoRepo 'infra\windows\instalar\40-verificar.ps1'
    if (-not (Test-Path $guion)) { $guion = Join-Path $OdontoCode 'infra\windows\instalar\40-verificar.ps1' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guion @Resto
    exit $LASTEXITCODE
  }

  { $_ -in @('servicios', 'ps') } {
    Afirmar-Administrador
    & pm2 list
    Write-Host ''
    Get-Service -Name 'pm2*', 'caddy', 'postgresql*' -ErrorAction SilentlyContinue |
      Format-Table Name, Status, StartType -AutoSize
    exit 0
  }

  'logs' {
    Afirmar-Administrador
    $que = if ($Resto.Count -ge 1) { $Resto[0] } else { 'clinical' }
    $lineas = if ($Resto.Count -ge 2) { $Resto[1] } else { '50' }
    switch ($que) {
      'caddy' { Get-Content (Join-Path $OdontoEtc 'caddy.log') -Tail ([int]$lineas) -ErrorAction SilentlyContinue }
      { $_ -in @('postgres', 'postgresql') } {
        Get-EventLog -LogName Application -Source '*postgres*' -Newest ([int]$lineas) -ErrorAction SilentlyContinue
      }
      { $_ -in @('gateway', 'web') } { & pm2 logs odontocrm-$que --lines $lineas --nostream }
      default { & pm2 logs "odontocrm-$que" --lines $lineas --nostream }
    }
    exit 0
  }

  'actualizar' {
    Afirmar-Administrador
    Push-Location $OdontoCode
    try {
      $rama = 'main'
      foreach ($arg in $Resto) { if ($arg -like '--rama=*') { $rama = $arg.Substring(7) } }
      Write-Host "Actualizando $OdontoCode (rama $rama)" -ForegroundColor White
      & git fetch --prune origin
      if ($LASTEXITCODE -ne 0) { Morir 'no pude traer el código nuevo (¿hay red y remoto?)' }
      & git checkout -B $rama "origin/$rama"
      if ($LASTEXITCODE -ne 0) { Morir "no pude cambiar a la rama '$rama'" }
      Escribir-Ok "rama $rama · código en $(& git rev-parse --short HEAD)"
    }
    finally { Pop-Location }

    # La MISMA pieza del instalador pone al día compilación, migraciones, servicio, certificado
    # y proxy. Es idempotente y NO toca las credenciales (ADR 0043).
    $desplegar = Join-Path $OdontoCode 'infra\windows\instalar\30-desplegar.ps1'
    if (-not (Test-Path $desplegar)) { Morir "no encuentro $desplegar en el código desplegado" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $desplegar
    if ($LASTEXITCODE -ne 0) { Escribir-Aviso 'el despliegue reportó un problema: revisa la salida de arriba' }
    exit $LASTEXITCODE
  }

  'certificado' {
    Afirmar-Administrador
    Write-Host ''
    Write-Host 'Certificado interno (TLS)' -ForegroundColor White
    $cert = Join-Path $OdontoTls 'odontocrm.crt'
    if (Test-Path $cert) {
      $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert)
      Escribir-Ok "servidor: $cert (válido hasta $($x509.NotAfter.ToString('yyyy-MM-dd')))"
    }
    else { Escribir-Error "no está el certificado del servidor: ejecuta 30-desplegar.ps1" }

    $ca = Join-Path $OdontoTls 'odontocrm-ca.crt'
    if (Test-Path $ca) {
      Escribir-Ok "autoridad (CA) interna: $ca"
    }
    else { Escribir-Error 'no encuentro la CA interna (la crea 30-desplegar.ps1)' }

    $ip = Get-IpLan
    Write-Host ''
    Write-Host 'En cada aparato (el certificado se instala una vez):' -ForegroundColor White
    Write-Host "  Android     http://$ip/ca.crt → Ajustes → Seguridad → Cifrado y credenciales"
    Write-Host '              → Instalar un certificado → Certificado de CA → elegir el archivo'
    Write-Host "  iPhone/iPad http://$ip/ca.crt  (abrir con Safari) → Ajustes → Perfil descargado"
    Write-Host '              → y Ajustes → General → Información → Ajustes de confianza → ACTIVAR'
    Write-Host "  Windows     http://$ip/ca.der  (doble clic → Instalar certificado →"
    Write-Host '              Equipo local → Entidades de certificación raíz de confianza)'
    Write-Host '              o en PowerShell como administrador:'
    Write-Host "                irm http://$ip/ca-windows.ps1 | iex"
    Write-Host "  Linux       curl -fsSL http://$ip/ca-linux.sh | sudo bash"
    Write-Host '              (Firefox tiene su propio almacén: security.enterprise_roots.enabled)'
    Write-Host ''
    exit 0
  }

  'credenciales' {
    Afirmar-Administrador
    $aprovisionador = Join-Path $OdontoCode 'infra\fedora\instalar\aprovisionar.mjs'
    $pgBin = Get-PgBin
    $argumentos = @($aprovisionador, "--env-dir=$OdontoEnv", "--data-dir=$OdontoDatos", "--keys-dir=$OdontoTls", '--solo-verificar')
    if ($pgBin) { $argumentos += "--pgbin=$pgBin" }
    if (& node @argumentos) { Escribir-Ok 'las credenciales conectan: los archivos y la base están de acuerdo' }
    else {
      Escribir-Aviso 'alguna credencial NO conecta (arriba se dice cuál y qué archivo mirar)'
      Escribir-Aviso '  se arregla volviendo a aprovisionar:  .\20-aprovisionar.ps1'
      exit 1
    }
    exit 0
  }

  { $_ -in @('red', 'ip', 'lan') } {
    Afirmar-Administrador
    $arreglar = $false
    $siCambio = $false
    foreach ($arg in $Resto) {
      if ($arg -in @('--arreglar', '-a', '--si')) { $arreglar = $true }
      if ($arg -in @('--si-cambio', '--vigilar')) { $siCambio = $true }
    }
    $ip = Get-IpLan
    $nombre = Get-Nombre

    # `--si-cambio` lo usa la TAREA programada: si la IP es la misma con la que ya se adaptó
    # todo, sale en silencio sin reemitir el certificado ni reiniciar nada. En la clínica,
    # con IP fija, nunca hace nada; en un portátil que cambia de red, deja todo al día.
    $archivoIp = Join-Path $OdontoDatos 'red-ultima-ip'
    if ($siCambio -and (Test-Path $archivoIp)) {
      $ultima = (Get-Content $archivoIp -Raw -ErrorAction SilentlyContinue).Trim()
      if ($ultima -eq $ip) { exit 0 }
    }

    Write-Host ''
    Write-Host 'Direcciones para entrar al sistema' -ForegroundColor White
    Write-Host "  https://$ip      (por la IP de esta máquina en la red actual)" -ForegroundColor White
    Write-Host '  https://127.0.0.1      (desde el propio servidor)'
    Write-Host ''

    $problemas = 0

    # 1) Firewall: las reglas del 80 y 443 en el perfil privado.
    foreach ($regla in @('OdontoCRM Web (HTTP)', 'OdontoCRM Web (HTTPS)')) {
      if (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue) { Escribir-Ok "firewall: «$regla» presente" }
      else { Escribir-Aviso "falta la regla «$regla»: nadie de la red podrá entrar"; $problemas++ }
    }

    # 2) Certificado: ¿cubre la IP de ahora?
    $cert = Join-Path $OdontoTls 'odontocrm.crt'
    $cubre = $false
    if (Test-Path $cert) {
      try {
        $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert)
        $san = ($x509.Extensions | Where-Object { $_.Oid.FriendlyName -like '*Subject Alternative Name*' })
        $textoSan = if ($san) { $san.Format($false) } else { '' }
        $cubre = $textoSan -like "*$ip*"
      }
      catch { }
    }
    if ($cubre) { Escribir-Ok "el certificado incluye $ip" }
    else { Escribir-Aviso "el certificado NO incluye $ip (se emitió para la red anterior)"; $problemas++ }

    # 3) CORS: ¿WEB_ORIGIN admite esa dirección? Si no, el login falla sin decir por qué.
    $origenes = Get-ValorEnv -Archivo (Join-Path $OdontoEnv 'odontocrm.env') -Clave 'WEB_ORIGIN'
    if ($origenes -and $origenes -like "*$ip*") { Escribir-Ok 'WEB_ORIGIN admite la IP actual' }
    else { Escribir-Aviso "WEB_ORIGIN no incluye https://$ip (hoy: $origenes)"; $problemas++ }

    Write-Host ''
    if ($problemas -eq 0) {
      Escribir-Ok 'todo apunta a la red actual: se puede entrar desde otro equipo'
      Write-Host "    Recuerda instalar el certificado en cada equipo:  http://$ip/ca.crt"
      Guardar-IpRed $ip
      exit 0
    }
    if (-not $arreglar) {
      Escribir-Aviso "$problemas cosa(s) apuntan a la red anterior. Se arreglan con:"
      Write-Host '      odontocrm red --arreglar'
      exit 2
    }

    # ── Arreglo automático ───────────────────────────────────────────────────
    Write-Host 'Arreglando la red actual' -ForegroundColor White

    # a) Firewall: recrear las reglas si faltan.
    foreach ($par in @(@('OdontoCRM Web (HTTP)', 80), @('OdontoCRM Web (HTTPS)', 443))) {
      if (-not (Get-NetFirewallRule -DisplayName $par[0] -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $par[0] -Direction Inbound -LocalPort $par[1] `
          -Protocol TCP -Action Allow -Profile Private | Out-Null
        Escribir-Ok "firewall: «$($par[0])» restaurada"
      }
    }

    # b) Certificado reemitido con la IP de ahora. MISMA CA: los equipos que ya la tengan
    #    instalada no tienen que hacer nada.
    $mkcert = Join-Path $OdontoBin 'mkcert.exe'
    if (Test-Path $mkcert) {
      $nombres = @($nombre, 'localhost', '127.0.0.1', $ip) | Where-Object { $_ } | Select-Object -Unique
      & $mkcert -key-file (Join-Path $OdontoTls 'odontocrm.key') -cert-file $cert @nombres 2>&1 | Out-Null
      if (Test-Path $cert) {
        Proteger-Archivo -Ruta (Join-Path $OdontoTls 'odontocrm.key') -LecturaServicio
        Escribir-Ok "certificado reemitido para: $($nombres -join ' ')"
      }
      else { Escribir-Aviso 'no pude reemitir el certificado' }
    }

    # c) CORS: el nombre y la IP de ahora.
    $archivo = Join-Path $OdontoEnv 'odontocrm.env'
    if (Test-Path $archivo) {
      $texto = Get-Content -Raw $archivo
      $nuevo = $texto -replace '(?m)^WEB_ORIGIN=.*$', "WEB_ORIGIN=https://$nombre, https://$ip"
      [IO.File]::WriteAllText($archivo, $nuevo, (New-Object System.Text.UTF8Encoding($false)))
      Proteger-Archivo -Ruta $archivo -LecturaServicio
      Escribir-Ok "WEB_ORIGIN=https://$nombre, https://$ip"
      & pm2 restart odontocrm-identity odontocrm-clinical odontocrm-gateway *> $null
      Escribir-Ok 'identity, clinical y el gateway reiniciados (leen el origen permitido)'
    }

    # d) El proxy: regenerar la CA/scripts con la IP de ahora y recargar.
    $instaladorCaddy = Join-Path $OdontoCode 'infra\windows\caddy\instalar.ps1'
    if (Test-Path $instaladorCaddy) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $instaladorCaddy "--nombre=$nombre" "--ip=$ip"
    }
    Guardar-IpRed $ip
    Write-Host ''
    Escribir-Ok 'red actualizada. Comprueba con:  odontocrm red'
    exit 0
  }

  'con-entorno' {
    Afirmar-Administrador
    if ($Resto.Count -lt 3 -or $Resto[1] -ne '--') {
      Morir "uso: odontocrm con-entorno <servicio> -- <comando>  (servicios: $(($info.servicios.nombre) -join ', '), gateway)"
    }
    $servicio = $Resto[0]
    if (-not (Test-Path (Join-Path $OdontoEnv "$servicio.env"))) { Morir "no existe $OdontoEnv\$servicio.env" }
    $comando = $Resto[2..($Resto.Count - 1)]
    Push-Location $OdontoCode
    try {
      & node (Join-Path $OdontoCode 'tools\con-entorno.mjs') $OdontoEnv $servicio -- @comando
      exit $LASTEXITCODE
    }
    finally { Pop-Location }
  }

  { $_ -in @('parar', 'stop', 'detener') } {
    Afirmar-Administrador
    $todo = $false
    foreach ($arg in $Resto) { if ($arg -in @('--todo', '--con-base')) { $todo = $true } }

    # El gateway PRIMERO: es la puerta. Si se para al final, las peticiones en curso se
    # quedan colgadas contra servicios que ya no están.
    & pm2 stop odontocrm-gateway *> $null
    Escribir-Ok 'gateway detenido (la puerta)'
    $parados = 0
    foreach ($s in $info.servicios) { if (& pm2 stop "odontocrm-$($s.nombre)" *> $null) { $parados++ } }
    Escribir-Ok "$parados servicio(s) detenido(s)"

    if ($todo) {
      # Al final y a propósito: los servicios ya están parados.
      Stop-Service -Name 'caddy' -ErrorAction SilentlyContinue
      $svcPg = Get-ServicioPostgres
      if ($svcPg) { Stop-Service -Name $svcPg.Name -ErrorAction SilentlyContinue }
      Escribir-Ok 'Caddy y PostgreSQL detenidos (--todo): el sistema queda completamente parado'
    }
    else {
      Escribir-Aviso 'Caddy y PostgreSQL siguen en marcha (el proxy dará 502 mientras tanto)'
      Escribir-Aviso 'para pararlo TODO:  odontocrm parar --todo'
    }
    exit 0
  }

  { $_ -in @('arrancar', 'start') } {
    Afirmar-Administrador
    $svcPg = Get-ServicioPostgres
    if ($svcPg -and $svcPg.Status -ne 'Running') { Start-Service -Name $svcPg.Name }
    if (Esperar-Puerto -Puerto 5432 -Segundos 20) { Escribir-Ok 'PostgreSQL en marcha' }
    else { Escribir-Aviso 'PostgreSQL no respondió en el 5432' }
    $svcCaddy = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
    if ($svcCaddy -and $svcCaddy.Status -ne 'Running') { Start-Service -Name 'caddy' }
    Escribir-Ok 'Caddy en marcha'
    & pm2 start all *> $null
    Escribir-Ok 'servicios arrancados; comprobando…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OdontoCode 'infra\windows\instalar\40-verificar.ps1') --rapido
    exit $LASTEXITCODE
  }

  { $_ -in @('reiniciar', 'restart', 'reinicio') } {
    Afirmar-Administrador
    # Vale igual si el sistema estaba corriendo o si se paró antes con `parar --todo`.
    $svcPg = Get-ServicioPostgres
    if ($svcPg -and $svcPg.Status -ne 'Running') { Start-Service -Name $svcPg.Name; Escribir-Ok 'PostgreSQL estaba parado: arrancado' }
    $svcCaddy = Get-Service -Name 'caddy' -ErrorAction SilentlyContinue
    if ($svcCaddy -and $svcCaddy.Status -ne 'Running') { Start-Service -Name 'caddy'; Escribir-Ok 'Caddy estaba parado: arrancado' }
    & pm2 restart all *> $null
    Escribir-Ok 'servicios reiniciados; comprobando…'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OdontoCode 'infra\windows\instalar\40-verificar.ps1') --rapido
    exit $LASTEXITCODE
  }

  { $_ -in @('compilar', 'build') } {
    Afirmar-Administrador
    Push-Location $OdontoCode
    try {
      & git rev-parse --short HEAD 2>$null | ForEach-Object { Escribir-Ok "versión en el disco: $_" }
      & npm ci --silent
      if ($LASTEXITCODE -ne 0) { Morir 'falló npm ci' }
      $registro = Join-Path $env:TEMP 'odontocrm-build.log'
      & npm run build *> $registro
      if ($LASTEXITCODE -ne 0) {
        Get-Content $registro -Tail 30 | ForEach-Object { Escribir-Detalle $_ }
        Morir "falló la compilación (registro: $registro)"
      }
      Escribir-Ok 'compilado (TypeScript → dist/ y la SPA en apps/web/dist)'
      Escribir-Aviso 'los servicios siguen con el código anterior hasta que se reinicien: usa «odontocrm reiniciar»'
    }
    finally { Pop-Location }
    exit 0
  }

  { $_ -in @('recompilar', 'rebuild') } {
    Afirmar-Administrador
    Push-Location $OdontoCode
    try {
      & npm ci --silent
      if ($LASTEXITCODE -ne 0) { Morir 'falló npm ci' }
      $registro = Join-Path $env:TEMP 'odontocrm-build.log'
      & npm run build *> $registro
      if ($LASTEXITCODE -ne 0) {
        Get-Content $registro -Tail 30 | ForEach-Object { Escribir-Detalle $_ }
        Morir "falló la compilación (registro: $registro)"
      }
      Escribir-Ok 'compilado (TypeScript → dist/)'
    }
    finally { Pop-Location }
    & pm2 restart all *> $null
    Escribir-Aviso 'no se aplicaron migraciones: si el cambio toca el esquema, usa «odontocrm actualizar»'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OdontoCode 'infra\windows\instalar\40-verificar.ps1') --rapido
    exit $LASTEXITCODE
  }

  'modo-test' {
    Afirmar-Administrador
    $accion = if ($Resto.Count -ge 1) { $Resto[0] } else { 'estado' }
    $archivo = Join-Path $OdontoEnv 'odontocrm.env'
    switch ($accion) {
      { $_ -in @('on', 'off') } {
        $valor = if ($accion -eq 'on') { 'true' } else { 'false' }
        $texto = Get-Content -Raw $archivo
        $texto = $texto -replace '(?m)^TEST_MODE=.*$', "TEST_MODE=$valor"
        $texto = $texto -replace '(?m)^ALLOW_TEST_MODE=.*$', "ALLOW_TEST_MODE=$valor"
        [IO.File]::WriteAllText($archivo, $texto, (New-Object System.Text.UTF8Encoding($false)))
        Proteger-Archivo -Ruta $archivo -LecturaServicio
        if ($valor -eq 'true') { Escribir-Aviso 'ojo: con NODE_ENV=production el modo test sigue bloqueado (ADR 0020)' }
        Escribir-Ok "modo test $accion en odontocrm.env (reiniciando los servicios…)"
        & pm2 restart all *> $null
      }
      'estado' {
        Select-String -Path $archivo -Pattern '^(TEST_MODE|ALLOW_TEST_MODE)=' -ErrorAction SilentlyContinue |
          ForEach-Object { Write-Host "  $($_.Line)" }
        try {
          $meta = Invoke-WebRequest -Uri "http://127.0.0.1:$puertoGateway/api/v1/meta" -UseBasicParsing -TimeoutSec 4
          $json = $meta.Content | ConvertFrom-Json
          Write-Host "  el gateway dice: $($json.testMode)"
        }
        catch { }
      }
      default { Morir 'uso: odontocrm modo-test <on|off|estado>' }
    }
    exit 0
  }

  default {
    Escribir-Error "orden desconocida: $Orden"
    Ayuda
    exit 2
  }
}
