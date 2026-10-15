# =============================================================================
# OdontoCRM · 3/4 · Desplegar el servidor (Windows)
#
# Pone en marcha la aplicación SOBRE las credenciales que ya aprovisionó la pieza 2.
# Nada de lo que hace aquí escribe un secreto: el código desplegado no contiene ninguno.
#
#   1. Código en C:\OdontoCRM (clon de git, sin .env ni claves)
#   2. Dependencias y compilación
#   3. Chromium de Playwright para los PDF (récipes, facturas, reportes)
#   4. Claves EdDSA de los JWT (si no existen; no se regeneran nunca solas)
#   5. Migraciones de las bases
#   6. Usuarios iniciales (contraseña temporal, se imprime UNA vez)
#   7. Servicio de PM2 (supervisión), el comando «odontocrm» y arranque de los servicios
#   8. Certificado TLS interno (mkcert) y confianza en el almacén de Windows
#   9. Proxy inverso (Caddy) y firewall: 80 y 443 para la LAN
#  10. Respaldos (rol dedicado) y tareas programadas
#
#   .\30-desplegar.ps1
#   .\30-desplegar.ps1 --ip=192.168.1.50
#   .\30-desplegar.ps1 --dry-run
#
# Espejo de `infra/fedora/instalar/30-desplegar.sh`.
# =============================================================================

. "$PSScriptRoot\comun.ps1"
trap { Escribir-Corte; exit 1 }

$Ayuda = @'

OdontoCRM · 3/4 · Desplegar (Windows)

USO
  .\30-desplegar.ps1 [--nombre-mdns=NOMBRE] [--ip=IP] [--dry-run]

Al terminar imprime la dirección por la que entran los aparatos de la consulta.
'@

if ((Test-Bandera $args 'ayuda') -or (Test-Bandera $args 'help')) { Write-Host $Ayuda; exit 0 }

$Nombre = Get-Argumento $args 'nombre-mdns'
$Ip = Get-Argumento $args 'ip'
$DryRun = Test-Bandera $args 'dry-run'
if (-not $DryRun) { Afirmar-Administrador }

# Las credenciales TIENEN que estar: si esta pieza genera algo, es que se saltó un paso.
if (-not $DryRun -and -not (Test-Path (Join-Path $OdontoEnv 'odontocrm.env'))) {
  Morir "no hay entorno aprovisionado en $OdontoEnv — ejecuta antes .\20-aprovisionar.ps1"
}

$Nombre = Get-Nombre -Pedido $Nombre
if (-not $Ip) { $Ip = Get-IpLan }
if (-not $Ip) { $Ip = '127.0.0.1' }
$info = Get-Info

Write-Host ''
Write-Host 'OdontoCRM · 3/4 · Desplegar (Windows)' -ForegroundColor White
Escribir-Detalle "código → $OdontoCode      secretos → $OdontoEnv"
Escribir-Detalle "nombre → $Nombre   IP → $Ip"
if ($DryRun) { Escribir-Aviso '--dry-run: no se cambia nada' }

# ════════════════════════════════════════════════════════════════════════════
# 1. Código en C:\OdontoCRM — un clon de git, y SIN secretos
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '1/10 · Código en C:\OdontoCRM'
#
# Se clona en vez de copiar a mano por dos razones: `git clone` **nunca** trae los archivos
# ignorados (`.env`, `.keys`, `node_modules`), que es justo donde viven los secretos; y
# `odontocrm actualizar` necesita que el destino sea un clon para traer versiones nuevas.
#
# El clon es --local (del repositorio de trabajo): no hace falta ni red ni credenciales.
# Si el repositorio de trabajo NO es un clon de git, se copia con robocopy excluyendo los
# archivos ignorados (una copia a mano arrastraría los `.env` al servidor).
$esGit = (Test-Comando git) -and (Test-Path (Join-Path $OdontoRepo '.git'))
$rama = 'main'
$commit = '?'
if ($esGit) {
  $rama = (& git -C $OdontoRepo rev-parse --abbrev-ref HEAD 2>$null)
  $commit = (& git -C $OdontoRepo rev-parse --short HEAD 2>$null)
}

function Copiar-Codigo {
  param([string]$Origen, [string]$Destino)
  if ($esGit) {
    $temporal = "$Destino.clon-nuevo"
    if (Test-Path $temporal) { Remove-Item -Recurse -Force $temporal }
    # `--no-hardlinks`: copia los objetos en vez de enlazarlos (en Windows los enlaces
    # entre unidades distintas fallan). El coste, para este repositorio, es de segundos.
    & git clone --local --no-hardlinks --quiet $Origen $temporal
    if ($LASTEXITCODE -ne 0) { Morir "no pude clonar el repositorio en $temporal" }
    if ($rama -and $rama -ne 'HEAD') {
      & git -C $temporal checkout --quiet -B $rama $commit 2>$null
    }
    # El contenido del clon se COPIA encima del destino; NO se borra el destino para mover la
    # carpeta en su lugar. En Windows el destino ya trae las carpetas del instalador (datos,
    # logs y respaldos, con sus permisos), así que un `Remove-Item -Recurse -Force` borraría el
    # almacén entero —radiografías incluidas— y volvería a dejar los datos sin permiso.
    # robocopy arrastra también los archivos con punto (`.gitattributes`), que un comodín de
    # PowerShell no toca, y **no borra lo que no está en el origen** (eso sería `/MIR`).
    New-Item -ItemType Directory -Force -Path $Destino | Out-Null
    & robocopy $temporal $Destino /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
      Morir "robocopy falló (código $LASTEXITCODE) al poner el código en $Destino"
    }
    Remove-Item -Recurse -Force $temporal
    Escribir-Ok "código clonado en $Destino (rama $rama, commit $commit)"
  }
  else {
    Escribir-Aviso 'el repositorio de trabajo no es un clon de git: copio con robocopy'
    $excluir = @('.git', 'node_modules', 'logs', 'dist', 'tmp', 'storage')
    & robocopy $Origen $Destino /MIR /XD @excluir /XF '.env' '*.env' /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Morir "robocopy falló (código $LASTEXITCODE) al copiar el código" }
    Escribir-Ok "código copiado en $Destino (sin .env ni node_modules)"
  }
  # El código lo LEE LocalService (PM2); los permisos los puso 10-preparar.ps1 en la carpeta.
}

# Las carpetas de datos/logs/respaldos que ya creó la pieza 1 dentro de $OdontoCode NO cuentan
# como «algo dentro»: el código y los datos comparten carpeta en Windows (ver comun.ps1).
$propias = Get-CarpetasPropiasDelCodigo
$aijenas = @()
if (Test-Path $OdontoCode) {
  $aijenas = @(Get-ChildItem -Path $OdontoCode -Force -ErrorAction SilentlyContinue |
      Where-Object { $propias -notcontains $_.Name })
}

if ($DryRun) {
  Escribir-Detalle "[dry-run] clonar $OdontoRepo → $OdontoCode (rama $rama, commit $commit)"
}
elseif (Test-Path (Join-Path $OdontoCode '.git')) {
  Escribir-Ok "ya hay un clon en $OdontoCode (rama $rama, commit $commit): se conserva"
}
elseif ($aijenas.Count -gt 0) {
  # El mensaje va entre PARÉNTESIS: en PowerShell los argumentos de un comando se separan por
  # espacios, así que `Morir "a" + "b"` le pasaría el `+` como un argumento suelto.
  Morir ("$OdontoCode tiene cosas que no puso el instalador y no lo borro por si acaso:`n" +
    "    $(($aijenas | ForEach-Object { $_.Name }) -join ', ')`n" +
    "    Muévelas aparte (p. ej. Rename-Item $OdontoCode ${OdontoCode}.viejo) y vuelve a ejecutar.")
}
else {
  Copiar-Codigo -Origen $OdontoRepo -Destino $OdontoCode
}

# El código se clona JUNTO a las carpetas propias, así que git las ve como «sin seguimiento». Se
# dice una vez, para que nadie se asuste al mirar `git status` en el servidor (y para que quede
# claro que no se versionan: el `.gitignore` de la raíz ya ignora datos, logs y respaldos).
if (-not $DryRun -and $propias.Count -gt 0) {
  Escribir-Detalle "carpetas del instalador conservadas en $OdontoCode\: $($propias -join ', ')"
}

# ════════════════════════════════════════════════════════════════════════════
# 2. Dependencias y compilación
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '2/10 · Dependencias y compilación'
if ($DryRun) {
  Escribir-Detalle "[dry-run] (cd $OdontoCode && npm ci && npm run build)"
}
else {
  Push-Location $OdontoCode
  try {
    $registro = Join-Path $env:TEMP 'odontocrm-npm-ci.log'
    & npm ci --silent *> $registro
    if ($LASTEXITCODE -ne 0) {
      Get-Content $registro -Tail 20 | ForEach-Object { Escribir-Detalle $_ }
      Morir "falló «npm ci» (registro: $registro). ¿Hay conexión a internet?"
    }
    Escribir-Ok 'dependencias instaladas (npm ci)'

    $registro = Join-Path $env:TEMP 'odontocrm-build.log'
    & npm run build *> $registro
    if ($LASTEXITCODE -ne 0) {
      Get-Content $registro -Tail 25 | ForEach-Object { Escribir-Detalle $_ }
      Morir "falló la compilación (registro: $registro)"
    }
    Escribir-Ok 'compilado: servicios, paquetes y la interfaz web'
    $faltan = Get-EntrypointsFaltantes
    if (@($faltan).Count -gt 0) {
      foreach ($f in $faltan) { Escribir-Error "no se compiló: $f" }
      Morir "la compilación quedó incompleta (registro: $registro): prueba «npm run build» a mano"
    }
    Escribir-Ok "los $($info.servicios.Count) servicios y el gateway tienen su dist/index.js"
  }
  finally { Pop-Location }
}

# ════════════════════════════════════════════════════════════════════════════
# 3. Chromium de Playwright (récipe A5, factura, recibo y reportes)
# ════════════════════════════════════════════════════════════════════════════
# El navegador NO viene con el código: Playwright lo descarga aparte, y los servicios lo
# buscan en `PLAYWRIGHT_BROWSERS_PATH` ($OdontoPlaywright). Antes lo bajaba solo una persona,
# a mano; una instalación nueva —o una actualización que nunca lo tuvo— se quedaba sin
# récipes, sin facturas en PDF y sin reportes (el endpoint devolvía un 503/500 del servidor).
# Se baja aquí, idempotente: si ya está, ni se toca ni se gasta red.
Escribir-Paso '3/10 · Chromium para los PDF'

if ($DryRun) {
  Escribir-Detalle "[dry-run] verificaría/bajaría el Chromium de Playwright en $OdontoPlaywright"
}
elseif (Test-Navegador) {
  Escribir-Ok "navegador de Chromium ya presente en $OdontoPlaywright"
}
else {
  Escribir-Detalle 'bajando Chromium para los PDF (una sola vez; necesita conexión)'
  $playwright = Join-Path $OdontoCode 'node_modules\.bin\playwright.cmd'
  if (-not (Test-Path $playwright)) {
    Escribir-Aviso 'no encuentro el ejecutable de Playwright: ¿terminó «npm ci»?'
  }
  else {
    $registro = Join-Path $env:TEMP 'odontocrm-playwright.log'
    $anterior = $env:PLAYWRIGHT_BROWSERS_PATH
    try {
      $env:PLAYWRIGHT_BROWSERS_PATH = $OdontoPlaywright
      & $playwright install chromium *> $registro
    }
    finally {
      if ($null -eq $anterior) { Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue }
      else { $env:PLAYWRIGHT_BROWSERS_PATH = $anterior }
    }
    if ($LASTEXITCODE -eq 0 -and (Test-Navegador)) {
      Otorgar-Acceso -Ruta $OdontoPlaywright -Acceso 'Escritura'
      Escribir-Ok "Chromium instalado en $OdontoPlaywright"
    }
    else {
      Escribir-Aviso 'no pude dejar el navegador de Chromium: los PDF (récipe, factura, reportes) fallarán'
      Get-Content $registro -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Escribir-Detalle $_ }
      Escribir-Detalle 'repítelo a mano, como Administrador:'
      Escribir-Detalle "  `$env:PLAYWRIGHT_BROWSERS_PATH='$OdontoPlaywright'"
      Escribir-Detalle "  & `"$playwright`" install chromium"
    }
  }
}

# ════════════════════════════════════════════════════════════════════════════
# 4. Claves EdDSA de los JWT
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '4/10 · Claves de firma de los JWT'
$clavePriv = Join-Path $OdontoTls 'jwt-private.pem'
$clavePub = Join-Path $OdontoTls 'jwt-public.pem'
if ((Test-Path $clavePriv) -and (Test-Path $clavePub)) {
  Escribir-Ok 'ya existen las dos: se conservan (regenerarlas cerraría todas las sesiones abiertas)'
}
elseif ($DryRun) {
  Escribir-Detalle "[dry-run] generaría $OdontoTls\jwt-{private,public}.pem"
}
else {
  # Se usa el generador del propio proyecto, con el entorno del servicio, para que el
  # formato sea exactamente el que espera el código (no uno parecido). El aprovisionador
  # ya dejó en `identity.env` las rutas de las claves hacia $OdontoTls.
  Push-Location $OdontoCode
  try {
    & node tools/con-entorno.mjs $OdontoEnv identity -- node services/identity/dist/keys.js *> (Join-Path $env:TEMP 'odontocrm-keys.log')
  }
  finally { Pop-Location }

  # Si `keys.js` cayó a su ruta por defecto, habría escrito la clave privada DENTRO del
  # código (justo lo que el ADR 0043 prohíbe). Se comprueba DÓNDE quedó.
  $perdida = Join-Path $OdontoCode 'services\identity\.keys\jwt-private.pem'
  if (-not (Test-Path $clavePriv)) {
    if (Test-Path $perdida) { Remove-Item -Recurse -Force (Join-Path $OdontoCode 'services\identity\.keys') }
    Morir "las claves no quedaron en $OdontoTls. Se habrían escrito dentro del código
    (que es lo que NO debe pasar: los secretos no viven en $OdontoCode)."
  }
  Proteger-Archivo -Ruta $clavePriv -LecturaServicio
  Proteger-Archivo -Ruta $clavePub -LecturaServicio
  Escribir-Ok "claves nuevas en $OdontoTls"
}

# ════════════════════════════════════════════════════════════════════════════
# 5. Migraciones — con el entorno de C:\ProgramData\OdontoCRM\env
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso "5/10 · Migraciones de las $($info.servicios.Count) bases"
#
# `tools/con-entorno.mjs` carga los .env SIN interpretarlos como shell. Es importante: con
# `source`/dot-source los valores se rompen en silencio (una contraseña con `$` se expande).
if ($DryRun) {
  foreach ($s in $info.servicios) { Escribir-Detalle "[dry-run] migrar $($s.nombre)" }
}
else {
  # Antes de migrar: ¿está PostgreSQL escuchando? Si no, lo que se ve es un ECONNREFUSED
  # dentro de una traza larga de Node, que no dice qué hacer.
  if (-not (Esperar-Puerto -Puerto 5432 -Segundos 5)) {
    Escribir-Aviso 'PostgreSQL no está escuchando en 127.0.0.1:5432'
    Escribir-Detalle 'arráncalo y repite:  Start-Service postgresql-x64-18'
    Morir 'no puedo migrar sin base de datos'
  }
  Push-Location $OdontoCode
  try {
    foreach ($s in $info.servicios) {
      $registro = Join-Path $env:TEMP "odontocrm-migrar-$($s.nombre).log"
      & node tools/con-entorno.mjs $OdontoEnv $s.nombre -- node "services/$($s.nombre)/dist/db/migrate.js" *> $registro
      if ($LASTEXITCODE -ne 0) {
        Write-Host "    --- $registro ---"
        Get-Content $registro -Tail 25 | ForEach-Object { Write-Host "    $_" }
        Morir "fallaron las migraciones de $($s.nombre)"
      }
      Escribir-Ok "migraciones de $($s.nombre)"
    }
  }
  finally { Pop-Location }
}

# ════════════════════════════════════════════════════════════════════════════
# 6. Usuarios iniciales
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '6/10 · Usuarios iniciales'
if ($DryRun) {
  Escribir-Detalle '[dry-run] sembraría las cuentas iniciales (por defecto, «admin»)'
}
else {
  # El seed EXIGE la clave de cada cuenta en el entorno (`SEED_PASSWORD_<USUARIO>`, mínimo
  # 10 caracteres); sin ella no siembra nada. Si el instalador recogió la del admin, se
  # pasa; si no, se genera una temporal y se imprime UNA vez.
  # Por defecto SOLO `admin` (el resto del personal se da de alta en /usuarios). El juego
  # completo de desarrollo —`admin`, `recepcion` y los odontólogos de `clinic.ts`— se pide con
  # `USUARIOS_SEED=all`: la misma convención que en Fedora.
  $pedido = if ($env:USUARIOS_SEED) { $env:USUARIOS_SEED } else { 'admin' }
  if ($pedido -eq 'all') {
    $odontologos = @()
    $clinicTs = Join-Path $OdontoCode 'packages\contracts\src\clinic.ts'
    if (Test-Path $clinicTs) {
      $odontologos = @((Select-String -Path $clinicTs -Pattern "username:\s*'([^']+)'" -AllMatches).Matches |
        ForEach-Object { $_.Groups[1].Value })
    }
    $usuarios = (@('admin', 'recepcion') + $odontologos | Sort-Object -Unique) -join ','
  }
  else { $usuarios = $pedido }

  $claveAdmin = $env:SEED_PASSWORD_ADMIN
  $generada = $false
  if (-not $claveAdmin -or $claveAdmin.Length -lt 10) {
    $claveAdmin = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    $generada = $true
  }

  # Cada cuenta necesita su `SEED_PASSWORD_<USUARIO>` (el seed las exige en producción). Se usa
  # la misma temporal para las que no traigan una puesta, como hace el despliegue de Fedora.
  foreach ($u in ($usuarios -split ',')) {
    $nombre = $u.Trim()
    if (-not $nombre) { continue }
    $var = "SEED_PASSWORD_$($nombre.ToUpper())"
    if (-not [Environment]::GetEnvironmentVariable($var) -or [Environment]::GetEnvironmentVariable($var).Length -lt 10) {
      Set-Item -Path "Env:\$var" -Value $claveAdmin
    }
  }

  Push-Location $OdontoCode
  try {
    $env:SEED_PASSWORD_ADMIN = $claveAdmin
    $salida = & node tools/con-entorno.mjs $OdontoEnv identity -- node services/identity/dist/seed.js "--usuarios=$usuarios" 2>&1
    $codigo = $LASTEXITCODE
    $salida | ForEach-Object { Escribir-Detalle $_ }
    if ($codigo -ne 0) {
      Escribir-Error 'NO se pudieron sembrar los usuarios: sin usuarios no se puede entrar'
      Morir 'no lo des por bueno hasta sembrarlos (mira RUNBOOK §5)'
    }
    Escribir-Ok "usuarios al día: $usuarios"
    if ($generada) {
      # La temporal se deja en un archivo de Administradores (0600 equivalente) y se imprime.
      $informe = Join-Path $OdontoEtc 'contrasena-inicial.txt'
      "Contraseña temporal de $usuarios : $claveAdmin" | Set-Content -Path $informe -Encoding UTF8
      Proteger-Archivo -Ruta $informe
      Write-Host ''
      Write-Host "  Contraseña temporal: $claveAdmin" -ForegroundColor Yellow
      Write-Host '  (se pide cambiarla al primer ingreso; queda en ' -NoNewline
      Write-Host $informe -NoNewline
      Write-Host ')'
      Write-Host ''
    }
  }
  finally { Pop-Location }
}

# ════════════════════════════════════════════════════════════════════════════
# 7. Servicio de PM2 y arranque de los servicios
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '7/10 · Supervisión (PM2) y el comando del servidor'
$instaladorPm2 = Join-Path $OdontoRepo 'infra\windows\servicios\instalar-pm2.ps1'
if (-not (Test-Path $instaladorPm2)) {
  Escribir-Aviso "no encuentro servicios\instalar-pm2.ps1 (se instalará PM2 a mano)"
}
elseif ($DryRun) {
  Escribir-Detalle '[dry-run] instalaría el servicio de PM2 y arrancaría los procesos'
}
else {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $instaladorPm2
  if ($LASTEXITCODE -ne 0) { Escribir-Aviso 'la instalación del servicio de PM2 reportó un problema' }

  # `pm2-installer` deja `PM2_HOME` en el entorno de MÁQUINA y pide abrir una consola nueva: aquí
  # no se puede (esta sesión sigue instalando), así que se trae lo que dejó y se usa el `pm2` de
  # la máquina. Sin esto, los procesos se arrancarían en el PM2 del USUARIO —otro home distinto—
  # y el servicio (LocalService) no vería ninguno.
  $pm2 = Get-Pm2Cmd
  Escribir-Detalle "pm2 → $pm2   ·   PM2_HOME → $env:PM2_HOME"

  # OJO: si el servicio de PM2 NO está en marcha, `pm2 delete all`/`pm2 start` aquí arrancarían
  # un demonio de ESTA cuenta (Administrador): se quedaría con los «pipes» globales, los
  # procesos correrían sin supervisión y el servicio ya no podría arrancar nunca. Pasó el
  # 2026-10-14: «npm run setup» falló, el instalador siguió igual y todo quedó «funcionando»
  # sin servicio detrás. Ahora se comprueba ANTES y, sin servicio, no se toca PM2.
  if (-not (Confirmar-ServicioPm2)) {
    Escribir-Error 'el servicio de PM2 no está en marcha: NO arranco los procesos (sería sin supervisión)'
    Escribir-Detalle "mira $env:ProgramData\pm2\service\service.log y repite:  .\servicios\instalar-pm2.ps1 --forzar"
    Morir 'sin el servicio de PM2 los procesos no reviven solos ni arrancan con Windows'
  }

  # La lista de procesos se fija para que el servicio la restaure al arrancar Windows. Todo por
  # `Invocar-Pm2` (con techo de tiempo): `pm2` se espera a su demonio sin prisa y ya colgó una
  # instalación entera aquí (2026-10-15).
  Push-Location $OdontoCode
  try {
    $null = Invocar-Pm2 -Argumentos @('delete', 'all') -Segundos 60 -Directorio $OdontoCode
    $arranque = Invocar-Pm2 -Argumentos @('start', (Join-Path $OdontoRepo 'infra\windows\ecosystem.produccion.config.cjs')) `
      -Segundos 120 -Directorio $OdontoCode
    if ($arranque.TiempoAgotado) {
      Escribir-Aviso '«pm2 start» no respondió en dos minutos: miro abajo cuáles escuchan de verdad'
    }
    elseif ($arranque.Codigo -ne 0) {
      Escribir-Aviso "«pm2 start» salió con código $($arranque.Codigo)"
    }
    $null = Invocar-Pm2 -Argumentos @('save') -Segundos 30
    Escribir-Ok "los $($info.procesos.Count) procesos arrancados y fijados (pm2 save)"
  }
  finally { Pop-Location }

  # Se espera a que los puertos internos escuchen (los servicios no tardan todos lo mismo).
  Escribir-Detalle 'esperando a que escuchen…'
  $listos = 0
  foreach ($p in $info.procesos) {
    if (Esperar-Puerto -Puerto $p.puerto -Segundos 20) { $listos++ }
  }
  if ($listos -ge $info.procesos.Count) { Escribir-Ok "los $listos puertos internos escuchan" }
  else { Escribir-Aviso "solo $listos de $($info.procesos.Count) escuchan: mira  .\40-verificar.ps1" }
}

# ── El comando del servidor: una sola puerta para el día a día en la clínica ──
# Se copia a la carpeta que está en el PATH (la puso 10-preparar.ps1), así que a partir de
# aquí se teclea `odontocrm estado`, `odontocrm respaldar`, … sin recordar rutas.
$cliOrigen = Join-Path $OdontoRepo 'infra\windows\odontocrm.ps1'
$cmdOrigen = Join-Path $OdontoRepo 'infra\windows\odontocrm.cmd'
if ($DryRun) {
  Escribir-Detalle "[dry-run] instalaría el comando «odontocrm» en $OdontoCmd"
}
else {
  New-Item -ItemType Directory -Force -Path $OdontoCmd | Out-Null
  if (Test-Path $cliOrigen) { Copy-Item $cliOrigen (Join-Path $OdontoCmd 'odontocrm.ps1') -Force }
  if (Test-Path $cmdOrigen) { Copy-Item $cmdOrigen (Join-Path $OdontoCmd 'odontocrm.cmd') -Force }
  Otorgar-Acceso -Ruta $OdontoCmd -Acceso 'Lectura'
  Escribir-Ok "comando «odontocrm» instalado en $OdontoCmd"
}

# ════════════════════════════════════════════════════════════════════════════
# 8. Certificado TLS interno
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '8/10 · Certificado TLS interno'
#
# Con TLS interno el navegador avisa la primera vez hasta que se instala la CA en cada
# aparato. No es un fallo: la CA se descarga desde el propio servidor y se instala una sola
# vez por equipo. Se usa **mkcert**, la MISMA herramienta y la misma CA que en Fedora, para
# que un equipo que ya confía en un servidor OdontoCRM valide también el otro.
$cert = Join-Path $OdontoTls 'odontocrm.crt'
$clave = Join-Path $OdontoTls 'odontocrm.key'
$mkcert = Join-Path $OdontoBin 'mkcert.exe'
$nombres = @($Nombre, 'localhost', '127.0.0.1', $Ip) | Where-Object { $_ } | Select-Object -Unique

# ¿El certificado existente cubre los nombres de AHORA? El nombre mDNS y la IP cambian de
# red en red: un certificado de una instalación anterior ya no vale y la verificación lo
# señala («NO cubre 192.168.x.x: los equipos que entren así verán un aviso»).
function Test-CertificadoCubre {
  param([string]$Ruta, [string[]]$Esperados)
  if (-not (Test-Path $Ruta)) { return $false }
  try {
    $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Ruta)
    # El SAN se busca por OID (2.5.29.17), NO por `FriendlyName`: en Windows en español el
    # nombre amigable es «Nombre alternativo del sujeto» y el patrón inglés no engancha
    # (quedaba `$textoSan` vacío y el certificado «no cubría» nada aunque lo cubriera).
    $san = $x509.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
    $textoSan = if ($san) { $san.Format($false) } else { '' }
    foreach ($n in $Esperados) { if ($n -and $textoSan -notlike "*$n*") { return $false } }
    return $true
  }
  catch { return $false }
}

$reemitir = $false
if ((Test-Path $cert) -and (Test-Path $clave)) {
  if (Test-CertificadoCubre -Ruta $cert -Esperados $nombres) {
    Escribir-Ok "ya hay un certificado en ${cert} y cubre los nombres de ahora: se conserva"
  }
  else {
    Escribir-Aviso "el certificado de ${cert} NO cubre «$($nombres -join ', ')» (¿otra IP u otro nombre?): se reemite"
    $reemitir = $true
  }
}
elseif ($DryRun) {
  Escribir-Detalle "[dry-run] mkcert -install && mkcert $($nombres -join ' ')"
}
elseif (-not (Test-Path $mkcert)) {
  Escribir-Aviso "mkcert no está en $OdontoBin (lo baja 10-preparar.ps1): sin certificado, el proxy no arranca"
}
else {
  $reemitir = $true
}

if ($reemitir -and -not $DryRun) {
  if (-not (Test-Path $mkcert)) {
    Escribir-Aviso "mkcert no está en $OdontoBin (lo baja 10-preparar.ps1): no puedo reemitir el certificado"
  }
  else {
    # La CA de mkcert vive en el perfil del usuario que la crea; se fija una carpeta estable
    # para que entre en el respaldo de configuración y no dependa del perfil.
    $env:CAROOT = Join-Path $OdontoTls 'ca'
    New-Item -ItemType Directory -Force -Path $env:CAROOT | Out-Null
    & $mkcert -install 2>&1 | Out-Null
    & $mkcert -key-file $clave -cert-file $cert @nombres 2>&1 | Out-Null
    if (Test-Path $cert) {
      Proteger-Archivo -Ruta $clave -LecturaServicio
      Proteger-Archivo -Ruta $cert -LecturaServicio
      Escribir-Ok "certificado emitido para: $($nombres -join ' ')"
    }
    else {
      Escribir-Aviso 'no pude emitir el certificado con mkcert'
    }

    # La CA interna: sin ella no se puede quitar el aviso en los aparatos, y si se pierde hay
    # que emitir certificados nuevos en TODOS. Se guarda junto al resto de la configuración.
    $raizCa = Join-Path $env:CAROOT 'rootCA.pem'
    if (Test-Path $raizCa) {
      Copy-Item -Path $raizCa -Destination (Join-Path $OdontoTls 'odontocrm-ca.crt') -Force
      Escribir-Ok 'CA interna guardada en la carpeta de TLS (entra en el respaldo de configuración)'
    }
    else {
      Escribir-Aviso "no encuentro la CA de mkcert en $raizCa"
    }
  }
}

# Confianza en el propio servidor: así el proxy y los equipos de esta máquina no avisan.
if (-not $DryRun -and (Test-Path (Join-Path $OdontoTls 'odontocrm-ca.crt'))) {
  Invocar 'certutil -addstore -f Root odontocrm-ca.crt (almacén del sistema)' {
    & certutil -addstore -f 'Root' (Join-Path $OdontoTls 'odontocrm-ca.crt') 2>&1 | Out-Null
  }
  Escribir-Ok 'CA de confianza en el almacén del servidor (Edge, Chrome y Windows confían)'
}

# ════════════════════════════════════════════════════════════════════════════
# 9. Proxy inverso (Caddy) y firewall
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '9/10 · Proxy inverso y firewall'

$instaladorCaddy = Join-Path $OdontoRepo 'infra\windows\caddy\instalar.ps1'
if ($DryRun) {
  Escribir-Detalle "[dry-run] Caddyfile con server_name «$Nombre $Ip» y 80/443 abiertos a la LAN"
}
elseif (Test-Path $instaladorCaddy) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $instaladorCaddy "--nombre=$Nombre" "--ip=$Ip"
  if ($LASTEXITCODE -ne 0) { Escribir-Aviso 'el instalador del proxy reportó un problema' }
}
else {
  Escribir-Aviso 'no encuentro caddy\instalar.ps1 en el código'
}

# El firewall: se abren SOLO el 80 y el 443, y solo en la red privada. El gateway y los
# servicios escuchan en 127.0.0.1 y NO se publican: los aparatos entran por el proxy.
# Idempotente: se comprueba por nombre ANTES de crear, como enseña la lección de Fedora.
function Asegurar-ReglaFirewall {
  param([string]$Nombre, [int]$Puerto)
  $existente = Get-NetFirewallRule -DisplayName $Nombre -ErrorAction SilentlyContinue
  if ($existente) {
    Escribir-Ok "regla de firewall ya presente: $Nombre"
    return
  }
  Invocar "New-NetFirewallRule $Nombre (tcp $Puerto, perfil privado)" {
    New-NetFirewallRule -DisplayName $Nombre -Direction Inbound -LocalPort $Puerto -Protocol TCP `
      -Action Allow -Profile Private | Out-Null
  }
  Escribir-Ok "80 y 443 abiertos para la LAN — regla «$Nombre»"
}

if (-not $DryRun) {
  Asegurar-ReglaFirewall -Nombre 'OdontoCRM Web (HTTP)' -Puerto 80
  Asegurar-ReglaFirewall -Nombre 'OdontoCRM Web (HTTPS)' -Puerto 443
}

# ════════════════════════════════════════════════════════════════════════════
# 10. Respaldos y tareas programadas
# ════════════════════════════════════════════════════════════════════════════
Escribir-Paso '10/10 · Respaldos y tareas programadas'

if ($DryRun) {
  Escribir-Detalle '[dry-run] crearía el rol odonto_backup, backup.env y las cuatro tareas'
}
else {
  # El rol de respaldo se conecta por TCP con .pgpass: el respaldo no depende de que el
  # usuario del sistema se llame como un rol de PostgreSQL.
  $rolRespaldo = Join-Path $OdontoRepo 'infra\windows\backup\crear-rol-respaldo.ps1'
  if ((Test-Path $rolRespaldo) -and $env:PG_ADMIN_URL) {
    # La URL del administrador NO viaja como argumento: lleva la contraseña y en la lista de
    # procesos la vería cualquiera de la máquina. El hijo hereda `PG_ADMIN_URL` del entorno.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $rolRespaldo
    if ($LASTEXITCODE -ne 0) { Escribir-Aviso 'no pude preparar el rol de respaldo' }
  }
  elseif (-not $env:PG_ADMIN_URL) {
    Escribir-Aviso 'sin PG_ADMIN_URL no puedo crear el rol de respaldo: hazlo con'
    Escribir-Detalle '    .\infra\windows\backup\crear-rol-respaldo.ps1   (pide la contraseña de postgres)'
  }

  # Las cuatro tareas: respaldo diario, alertas cada 5 min, adaptación de la red cada 5 min
  # y el simulacro de restauración los domingos.
  $tareas = Join-Path $OdontoRepo 'infra\windows\tareas\registrar-tareas.ps1'
  if (Test-Path $tareas) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $tareas
    if ($LASTEXITCODE -ne 0) { Escribir-Aviso 'no pude registrar las tareas programadas' }
  }
  else { Escribir-Aviso 'no encuentro tareas\registrar-tareas.ps1 en el código' }
}

# ── Que el código desplegado no contenga secretos ────────────────────────────
if (-not $DryRun) {
  $filtrados = Get-ChildItem -Path $OdontoCode -Recurse -Depth 3 -Filter '.env' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*node_modules*' } | Select-Object -First 5
  if ($filtrados) {
    Escribir-Aviso 'hay archivos .env dentro del código desplegado (no deberían estar aquí):'
    $filtrados | ForEach-Object { Escribir-Detalle $_.FullName }
    Escribir-Detalle "los secretos viven SOLO en $OdontoEnv"
  }
  else {
    Escribir-Ok "el código de $OdontoCode no contiene secretos (ni un .env)"
  }
}

Escribir-Listo -Numero '3/4' -Texto 'El servidor está desplegado y arrancado.' -Siguiente '.\40-verificar.ps1'
