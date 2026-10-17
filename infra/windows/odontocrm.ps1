# =============================================================================
# OdontoCRM · comandos del servidor (una sola puerta) — Windows
#
#   odontocrm                 # ayuda
#   odontocrm estado          # tablero completo (con el entorno de producción)
#   odontocrm alertas         # solo los problemas; código 1 si hay alguno
#   odontocrm respaldar       # respaldo ahora (bases + configuración)
#   odontocrm restaurar --from DIR --all --yes   # restaura bases + almacén y reinicia
#   odontocrm recuperar --from DIR   # recuperación completa (bases + almacén + arranque)
#   odontocrm purgar-prueba   # quita las cuentas de PRUEBA sembradas (recepcion/prueba)
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

# El `pm2` de la MÁQUINA (el del servicio), no el que pueda tener el usuario en `%APPDATA%\npm`:
# `odontocrm` corre en consolas que pueden ser anteriores a la instalación de PM2 —o tener un pm2
# de desarrollo— y hablarle al PM2 equivocado sería peor que fallar. Es también el «reinicia la
# terminal» que pide `pm2-installer`: aquí se resuelve solo.
#
# Y antes de usarlo se confirma el SERVICIO, por el motivo de siempre: en Windows PM2 usa «pipes»
# globales y solo puede haber un demonio por máquina. Si no hay ninguno, `pm2` (esta consola es de
# Administrador) arrancaría uno de NUESTRA cuenta, se quedaría con los pipes y el servicio —que
# corre como LocalService— ya no podría arrancar. Se resuelve una sola vez por ejecución.
$Pm2Cmd = $null
$Pm2Confirmado = $false
function Get-Pm2 {
  if (-not $Pm2Cmd) { $script:Pm2Cmd = Get-Pm2Cmd }
  if (-not $Pm2Confirmado) {
    $script:Pm2Confirmado = $true
    if (-not (Confirmar-ServicioPm2 -Segundos 5)) {
      Escribir-Aviso 'el servicio de PM2 no está en marcha: no puedo hablar con los procesos'
    }
  }
  return $script:Pm2Cmd
}

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
  Write-Host '                            Con --all repone ADEMÁS el almacén (radiografías y PDF) y su'
  Write-Host '                            clave, y reinicia: reimprimir un récipe funciona al terminar.'
  Write-Host '  odontocrm recuperar --from DIR'
  Write-Host '                            RECUPERACIÓN COMPLETA en un comando: para los servicios,'
  Write-Host '                            restaura las bases, repone el almacén (y reconcilia su'
  Write-Host '                            clave), y arranca (servidor nuevo o fallo físico).'
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
  Write-Host '  odontocrm purgar-prueba [--si] [--desactivar|--borrar]'
  Write-Host '                            Quita las cuentas de PRUEBA que el seed creaba (recepcion y'
  Write-Host '                            el odontólogo de clinic.ts). Sin --si solo enseña qué haría.'
  Write-Host "  Directorio del código: $OdontoCode" -ForegroundColor DarkGray
  Write-Host "  Configuración:         $OdontoEnv" -ForegroundColor DarkGray
  Write-Host ''
}

# Ejecuta una herramienta de `tools/` con el entorno de producción y desde el código.
#
# OJO con cómo se devuelve el código de salida: por la variable `$script:CodigoDeSalida`,
# NUNCA por `return` envuelto en `exit (Invocar-Node …)`. Ese patrón captura TODO el flujo
# de éxito de la función —el tablero entero de `estado`— dentro de la expresión de `exit`,
# que lo descarta al convertirlo a entero: la salida desaparecía completa y además SIEMPRE
# se salía con 0 (2026-10-17). Si la llamada va a nivel de instrucción, la salida de node
# fluye sola a la consola (o a donde redirija quien llame al comando).
$script:CodigoDeSalida = 1
function Invocar-Node {
  param([string[]]$Argumentos)
  Push-Location $OdontoCode
  try {
    $anteriorDir = $env:ODONTOCRM_ENV_DIR
    $anteriorNodeEnv = $env:NODE_ENV
    $env:ODONTOCRM_ENV_DIR = $OdontoEnv
    $env:NODE_ENV = 'production'
    & node @Argumentos
    $script:CodigoDeSalida = $LASTEXITCODE
  }
  finally {
    # Se RESTAURAN y no se borran (2026-10-15): invocado en la misma sesión —un `.ps1` a
    # secas, sin pasar por el `.cmd`—, estas variables se quedaban puestas en la consola, y un
    # `npm ci` posterior con `NODE_ENV=production` dejaba node_modules SIN devDependencies:
    # la instalación moría con «'tsc' no se reconoce como un comando interno o externo».
    if ($null -eq $anteriorDir) { Remove-Item Env:\ODONTOCRM_ENV_DIR -ErrorAction SilentlyContinue }
    else { $env:ODONTOCRM_ENV_DIR = $anteriorDir }
    if ($null -eq $anteriorNodeEnv) { Remove-Item Env:\NODE_ENV -ErrorAction SilentlyContinue }
    else { $env:NODE_ENV = $anteriorNodeEnv }
    Pop-Location
  }
}

# Repone el almacén (radiografías/PDF) y reconcilia la clave del respaldo. Es lo que hace que
# los récipes y las radiografías restaurados se puedan abrir: reimprimir un récipe LEE el PDF
# archivado, y si no está —o está cifrado con otra clave— no se puede. Devuelve $false solo si
# los ARCHIVOS no se pudieron reponer (eso sí es grave).
function Restaurar-Almacen {
  param([string]$StorageZip, [string]$ConfigZip)
  if (-not $StorageZip -or -not (Test-Path $StorageZip)) {
    Escribir-Aviso 'este respaldo no trae el almacén (storage.zip)'
    return $true
  }
  New-Item -ItemType Directory -Force -Path $OdontoStorage | Out-Null
  try {
    # `| Out-Null`: si un cmdlet escribiera algo, se colaría en el valor de retorno de la
    # función (que solo debe ser $true/$false) y rompería el `if` que la usa.
    Expand-Archive -Path $StorageZip -DestinationPath $OdontoStorage -Force | Out-Null
    Escribir-Ok "almacén repuesto en $OdontoStorage"
  }
  catch {
    Escribir-Error "no pude extraer ${StorageZip}: $($_.Exception.Message)"
    return $false
  }

  # La clave con la que se cifraron los archivos: la del respaldo (config.zip) o, si no viene,
  # la del respaldo de la desinstalación. Sin ella, un almacén cifrado queda ilegible.
  $clave = $null
  $buscar = @()
  $tmp = $null
  if ($ConfigZip -and (Test-Path $ConfigZip)) {
    $tmp = Join-Path $OdontoTmp ('clave-almacen_' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try { Expand-Archive -Path $ConfigZip -DestinationPath $tmp -Force | Out-Null } catch { }
    $buscar += $tmp
  }
  foreach ($g in (Get-ChildItem -Path 'C:\' -Directory -Filter 'OdontoCRM-antes-de-desinstalar-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
    $dirEnv = Join-Path $g.FullName 'env'
    if (Test-Path $dirEnv) { $buscar += $dirEnv }
  }
  foreach ($dir in $buscar) {
    foreach ($f in 'patients', 'clinical', 'billing', 'identity') {
      $ruta = Join-Path $dir "${f}.env"
      if (Test-Path $ruta) {
        $linea = (Get-Content -Path $ruta -ErrorAction SilentlyContinue | Where-Object { $_ -match '^STORAGE_ENCRYPTION_KEY=' } | Select-Object -First 1)
        if ($linea) { $clave = ($linea -replace '^STORAGE_ENCRYPTION_KEY=', '').Trim(); break }
      }
    }
    if ($clave) { break }
  }
  if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

  $actual = $null
  foreach ($f in 'patients', 'clinical', 'billing', 'identity') {
    $ruta = Join-Path $OdontoEnv "${f}.env"
    if (Test-Path $ruta) {
      $linea = (Get-Content -Path $ruta -ErrorAction SilentlyContinue | Where-Object { $_ -match '^STORAGE_ENCRYPTION_KEY=' } | Select-Object -First 1)
      if ($linea) { $actual = ($linea -replace '^STORAGE_ENCRYPTION_KEY=', '').Trim(); break }
    }
  }

  if (-not $clave) {
    Escribir-Aviso 'no pude averiguar la clave del almacén: si está cifrado, quedará ilegible (RUNBOOK)'
  }
  elseif ($clave -eq $actual) {
    Escribir-Ok 'la clave del almacén ya es la del respaldo'
  }
  else {
    # `| Out-Host` es IMPORTANTE: la salida de un programa nativo entra en el flujo de la
    # función y se colaría en el valor de retorno ($true/$false), rompiendo el `if` que la usa.
    & node (Join-Path $OdontoCode 'infra\fedora\instalar\aprovisionar.mjs') "--env-dir=$OdontoEnv" "--clave-almacen=$clave" | Out-Host
    if ($LASTEXITCODE -eq 0) { Escribir-Ok 'clave del almacén repuesta (para que los documentos restaurados se lean)' }
    else { Escribir-Aviso 'no pude reponer la clave del almacén en los .env' }
  }

  # La prueba que importa: que un archivo de muestra se descifre de verdad. La herramienta
  # encuentra los .env por ODONTOCRM_ENV_DIR, así que se pasa y se restaura.
  $anteriorEnv = $env:ODONTOCRM_ENV_DIR
  $env:ODONTOCRM_ENV_DIR = $OdontoEnv
  try {
    & node (Join-Path $OdontoCode 'tools\verificar-almacen.mjs') --estado | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Escribir-Aviso 'la verificación del almacén avisó de algo: revísalo antes de dar por bueno el sistema'
    }
  }
  finally {
    if ($null -eq $anteriorEnv) { Remove-Item Env:\ODONTOCRM_ENV_DIR -ErrorAction SilentlyContinue }
    else { $env:ODONTOCRM_ENV_DIR = $anteriorEnv }
  }
  return $true
}

switch ($Orden) {
  { $_ -in @('ayuda', '-h', '--help', 'help') } { Ayuda; exit 0 }

  { $_ -in @('estado', 'status') } {
    Afirmar-Administrador
    # A nivel de instrucción (NO `exit (…)`): la salida de node va directa a la consola y
    # el código de sale por la variable. Con `exit (Invocar-Node …)` el tablero entero se
    # tragaba y el comando salía siempre con 0.
    Invocar-Node (@((Join-Path $OdontoCode 'tools\estado.mjs')) + $Resto)
    exit $script:CodigoDeSalida
  }

  'alertas' {
    Afirmar-Administrador
    # El código de salida es el contrato: 0 = sin problemas, 1 = hay alertas (el
    # temporizador y los guiones lo comprueban). Igual que arriba, sin `exit (…)`.
    Invocar-Node (@((Join-Path $OdontoCode 'tools\estado.mjs'), '--alertas') + $Resto)
    exit $script:CodigoDeSalida
  }

  { $_ -in @('respaldar', 'respaldo') } {
    Afirmar-Administrador
    $guion = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-backup.ps1'
    if (-not (Test-Path $guion)) { $guion = Join-Path $OdontoCode 'infra\windows\backup\odontocrm-backup.ps1' }
    # --include-storage: el almacén (radiografías/PDFs) entra por defecto; sin él, un fallo
    # físico del disco dejaría la base recuperable pero los adjuntos perdidos.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guion --include-config --include-storage @Resto
    exit $LASTEXITCODE
  }

  'recuperar' {
    Afirmar-Administrador
    # **Recuperación completa en un comando** (RUNBOOK §"Recuperación completa"): parar →
    # restaurar las bases → reponer el almacén → arrancar. Es el flujo de un servidor nuevo o
    # de un fallo físico, partiendo del pendrive o de la carpeta del respaldo. No reimplementa
    # nada: reutiliza `parar`, el restaurador y `arrancar`.
    #
    # OJO con la configuración: NO se repone salvo `--con-config`. Sobre una máquina nueva,
    # los `.env` del respaldo traen las contraseñas y rutas de la ANTERIOR y pisarían las que
    # el instalador acaba de crear (los servicios no conectarían). Pero si el almacén está
    # cifrado, el `STORAGE_ENCRYPTION_KEY` tiene que venir de esa config: mira el aviso final.
    $desde = Get-Argumento $Resto 'from'
    $asumir = Test-Bandera $Resto 'yes'
    $dry = Test-Bandera $Resto 'dry-run'
    $conConfig = Test-Bandera $Resto 'con-config'
    if (-not $desde) { Morir 'uso: odontocrm recuperar --from DIR [--yes] [--dry-run] [--con-config]' }
    if (-not (Test-Path $desde)) { Morir "no encuentro el respaldo en $desde" }
    $dumps = @(Get-ChildItem -Path $desde -Filter '*.dump' -File -ErrorAction SilentlyContinue)
    if ($dumps.Count -eq 0) { Morir "no hay volcados (.dump) en ${desde}: ¿es un directorio de respaldo?" }

    $storageZip = Join-Path $desde 'storage.zip'
    $configZip = Join-Path $desde 'config.zip'
    $restaurador = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-restore.ps1'
    if (-not (Test-Path $restaurador)) { $restaurador = Join-Path $OdontoCode 'infra\windows\backup\odontocrm-restore.ps1' }

    Write-Host ''
    Write-Host "Recuperación desde $desde" -ForegroundColor White
    Escribir-Detalle "bases    : $($dumps.Count) volcado(s)"
    if (Test-Path $storageZip) { Escribir-Detalle "almacén  : $storageZip" }
    else { Escribir-Detalle 'almacén  : no viene en este respaldo (se conserva el actual)' }
    if ($conConfig) { Escribir-Detalle "config   : $configZip" }
    else { Escribir-Detalle 'config   : no se toca (usa --con-config; ver el aviso final)' }
    Escribir-Detalle 'PostgreSQL queda arriba: la restauración necesita conectarse.'

    if ($dry) {
      Escribir-Aviso '[dry-run] pararía los servicios, restauraría las bases, repondría el almacén y arrancaría'
      exit 0
    }
    if (-not $asumir) {
      Write-Host ''
      Escribir-Error 'esto SUSTITUYE las bases actuales por las del respaldo.'
      Escribir-Detalle 'las actuales se conservan como «<base>__antes_de_restaurar_<fecha>».'
      Write-Host "      para confirmarlo:  odontocrm recuperar --from `"$desde`" --yes"
      exit 10
    }

    # 1) Parar los servicios (PostgreSQL se queda arriba). Se reusa el mismo camino que
    #    «odontocrm parar» re-invocando el propio comando.
    Escribir-Paso '1/4 · Parar'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath parar
    if ($LASTEXITCODE -ne 0) { Morir 'no pude parar los servicios' }

    # 2) Las bases (el restaurador verifica cada volcado en una base temporal antes de la real).
    Escribir-Paso '2/4 · Bases'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $restaurador --from $desde --all --keep-old --yes
    if ($LASTEXITCODE -ne 0) { Morir 'falló la restauración de las bases (revisa lo de arriba)' }

    # 3) El almacén (radiografías y PDFs) + su clave de cifrado, y comprobación de que se lee.
    Escribir-Paso '3/4 · Almacén'
    if (-not (Restaurar-Almacen -StorageZip $storageZip -ConfigZip $configZip)) {
      Escribir-Aviso 'no pude reponer el almacén: míralo a mano (RUNBOOK)'
    }

    # 4) La configuración, solo si se pide a propósito.
    Escribir-Paso '4/4 · Configuración'
    if ($conConfig) {
      if (Test-Path $configZip) {
        Escribir-Aviso 'repones la configuración: revisa DESPUÉS las rutas y las contraseñas de los .env'
        try {
          # El zip trae el CONTENIDO de la carpeta `env`, así que se extrae ahí (no en el padre).
          Expand-Archive -Path $configZip -DestinationPath $OdontoEnv -Force
          # Los .env vueltos a poner pierden la ACL: se vuelve a proteger (Administradores + LocalService).
          Get-ChildItem -Path $OdontoEnv -Filter '*.env' -ErrorAction SilentlyContinue |
            ForEach-Object { Proteger-Archivo -Ruta $_.FullName -LecturaServicio }
          Escribir-Ok "configuración y secretos repuestos en $OdontoEnv"
        }
        catch { Escribir-Aviso "no pude extraer ${configZip}: repónla a mano (RUNBOOK)" }
      }
      else { Escribir-Aviso 'este respaldo no trae la configuración (config.zip)' }
    }
    else {
      Escribir-Aviso 'no se toca la configuración (a propósito): los .env del respaldo son de la máquina ANTERIOR.'
      Escribir-Detalle 'la CLAVE del almacén sí se reconcilió en el paso 3, para que los documentos'
      Escribir-Detalle 'restaurados se lean; el resto es la configuración que generó el instalador.'
      Escribir-Detalle "para reponerla entera:  odontocrm recuperar --from `"$desde`" --con-config --yes"
    }

    # 5) Arrancar y verificar (arrancar ya termina verificando).
    Escribir-Paso 'Arranque'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath arrancar
    exit $LASTEXITCODE
  }

  'restaurar' {
    Afirmar-Administrador
    $guion = Join-Path $OdontoRepo 'infra\windows\backup\odontocrm-restore.ps1'
    if (-not (Test-Path $guion)) { $guion = Join-Path $OdontoCode 'infra\windows\backup\odontocrm-restore.ps1' }

    # Como en Fedora: si el respaldo es COMPLETO (`--all`) y trae el almacén, restaura las bases,
    # repone el almacén Y su clave, y reinicia. Así, al terminar, reimprimir un récipe funciona.
    # `--db <una>` y `--list` siguen siendo solo-bases.
    $desde = Get-Argumento $Resto 'from'
    $conTodo = Test-Bandera $Resto 'all'
    $asumir = Test-Bandera $Resto 'yes'
    $dry = Test-Bandera $Resto 'dry-run'
    $storageZip = if ($desde) { Join-Path $desde 'storage.zip' } else { $null }
    $configZip = if ($desde) { Join-Path $desde 'config.zip' } else { $null }

    if (-not $conTodo -or -not $desde -or -not (Test-Path $storageZip) -or $dry -or -not $asumir) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $guion @Resto
      exit $LASTEXITCODE
    }

    Write-Host ''
    Write-Host "Restauración completa desde $desde" -ForegroundColor White
    Escribir-Detalle 'bases    : todas (la anterior se conserva como «<base>__antes_de_restaurar_<fecha>»)'
    Escribir-Detalle "almacén  : $(Split-Path $storageZip -Leaf)"

    Escribir-Paso '1/3 · Parar'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath parar
    if ($LASTEXITCODE -ne 0) { Morir 'no pude parar los servicios' }

    Escribir-Paso '2/3 · Bases'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guion @Resto
    if ($LASTEXITCODE -ne 0) { Morir 'falló la restauración de las bases (revisa lo de arriba)' }

    Escribir-Paso '3/3 · Almacén'
    # Se AVISA y se sigue: las bases ya están restauradas, y dejar los servicios parados por el
    # almacén sería peor. El operador lo ve y lo repone a mano si hace falta.
    if (-not (Restaurar-Almacen -StorageZip $storageZip -ConfigZip $configZip)) {
      Escribir-Aviso 'no pude reponer el almacén: míralo a mano (RUNBOOK)'
    }

    Escribir-Paso 'Arranque'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath arrancar
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
    & (Get-Pm2) list
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
      { $_ -in @('gateway', 'web') } { & (Get-Pm2) logs odontocrm-$que --lines $lineas --nostream }
      default { & (Get-Pm2) logs "odontocrm-$que" --lines $lineas --nostream }
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
    # El despliegue NO debe sembrar las cuentas de PRUEBA («recepcion», «Odontólogo prueba»):
    # solo el `admin`. El resto del personal se da de alta en /usuarios. (Sin esta variable
    # `30-desplegar.ps1` ya usa `admin`, pero fijarlo aquí lo hace explícito y a prueba de fallos.)
    $env:USUARIOS_SEED = 'admin'
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

    # 1) Perfil de la red: las reglas solo abren el PRIVADO y Windows clasifica como pública
    #    cualquier red nueva; con la red en «Público» nadie entra CON las reglas puestas.
    $publicas = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.NetworkCategory -eq 'Public' })
    foreach ($red in $publicas) {
      Escribir-Aviso "la red «$($red.Name)» está en perfil PÚBLICO: Windows bloquea el 80/443"; $problemas++
    }
    if ($publicas.Count -eq 0) { Escribir-Ok 'la red activa está en perfil privado' }

    # 2) Firewall: las reglas del 80 y 443 en el perfil privado.
    foreach ($regla in @('OdontoCRM Web (HTTP)', 'OdontoCRM Web (HTTPS)')) {
      if (Get-NetFirewallRule -DisplayName $regla -ErrorAction SilentlyContinue) { Escribir-Ok "firewall: «$regla» presente" }
      else { Escribir-Aviso "falta la regla «$regla»: nadie de la red podrá entrar"; $problemas++ }
    }

    # 3) Certificado: ¿cubre la IP de ahora? El SAN se lee por OID (2.5.29.17): el
    #    `FriendlyName` está localizado en Windows en español y este chequeo decía «NO incluye»
    #    con el certificado bien (el mismo arreglo que en 40-verificar.ps1 el 2026-10-14).
    $cert = Join-Path $OdontoTls 'odontocrm.crt'
    $cubre = $false
    if (Test-Path $cert) {
      try {
        $x509 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cert)
        $san = ($x509.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
        $textoSan = if ($san) { $san.Format($false) } else { '' }
        $cubre = $textoSan -like "*$ip*"
      }
      catch { }
    }
    if ($cubre) { Escribir-Ok "el certificado incluye $ip" }
    else { Escribir-Aviso "el certificado NO incluye $ip (se emitió para la red anterior)"; $problemas++ }

    # 4) CORS: ¿WEB_ORIGIN admite esa dirección? Si no, el login falla sin decir por qué.
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

    # a) Perfil de la red: privado, que es donde las reglas dejan entrar.
    foreach ($red in $publicas) {
      try {
        Set-NetConnectionProfile -InterfaceIndex $red.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
        Escribir-Ok "red «$($red.Name)» pasa a perfil PRIVADO"
      }
      catch { Escribir-Aviso "no pude cambiar el perfil de «$($red.Name)»: $($_.Exception.Message)" }
    }

    # b) Firewall: recrear las reglas si faltan.
    foreach ($par in @(@('OdontoCRM Web (HTTP)', 80), @('OdontoCRM Web (HTTPS)', 443))) {
      if (-not (Get-NetFirewallRule -DisplayName $par[0] -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $par[0] -Direction Inbound -LocalPort $par[1] `
          -Protocol TCP -Action Allow -Profile Private | Out-Null
        Escribir-Ok "firewall: «$($par[0])» restaurada"
      }
    }

    # c) Certificado reemitido con la IP de ahora. MISMA CA: los equipos que ya la tengan
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

    # d) CORS: el nombre y la IP de ahora.
    $archivo = Join-Path $OdontoEnv 'odontocrm.env'
    if (Test-Path $archivo) {
      $texto = Get-Content -Raw $archivo
      $nuevo = $texto -replace '(?m)^WEB_ORIGIN=.*$', "WEB_ORIGIN=https://$nombre, https://$ip"
      [IO.File]::WriteAllText($archivo, $nuevo, (New-Object System.Text.UTF8Encoding($false)))
      Proteger-Archivo -Ruta $archivo -LecturaServicio
      Escribir-Ok "WEB_ORIGIN=https://$nombre, https://$ip"
      & (Get-Pm2) restart odontocrm-identity odontocrm-clinical odontocrm-gateway *> $null
      Escribir-Ok 'identity, clinical y el gateway reiniciados (leen el origen permitido)'
    }

    # e) El proxy: regenerar la CA/scripts con la IP de ahora y recargar.
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

  { $_ -in @('purgar-prueba', 'limpiar-cuentas-prueba') } {
    Afirmar-Administrador
    # Borra (o desactiva) las cuentas de PRUEBA que el seed creaba en el servidor: «recepcion»
    # y el odontólogo de `CLINIC.dentists` («Odontólogo prueba»). El personal real no se toca.
    # Sin `--si` solo enseña qué haría.
    Push-Location $OdontoCode
    try {
      & node (Join-Path $OdontoCode 'tools\con-entorno.mjs') $OdontoEnv identity -- `
        node (Join-Path $OdontoCode 'tools\purgar-cuentas-prueba.mjs') @Resto
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
    & (Get-Pm2) stop odontocrm-gateway *> $null
    Escribir-Ok 'gateway detenido (la puerta)'
    # El recuento va por el CÓDIGO de salida de `pm2`, no por su salida: con `*> $null` un
    # `if (& pm2 …)` siempre era falso y se decía «0 servicio(s) detenido(s)» con la pila
    # entera parada (2026-10-17).
    $parados = 0
    foreach ($s in $info.servicios) {
      & (Get-Pm2) stop "odontocrm-$($s.nombre)" *> $null
      if ($LASTEXITCODE -eq 0) { $parados++ }
    }
    Escribir-Ok "parada pedida a $parados servicio(s)"

    # La comprobación que importa es por EFECTO: ningún puerto del sistema debe seguir
    # escuchando. `pm2 stop` puede no aceptar la orden o el proceso volver a levantarse, y
    # un «detenido» que sigue sirviendo es peor que un aviso. Se da un margen y se miran
    # los puertos, no el estado que diga PM2.
    $enMarcha = @()
    foreach ($intento in 1..10) {
      $enMarcha = @()
      foreach ($p in $info.procesos) {
        if (Get-NetTCPConnection -State Listen -LocalPort $p.puerto -ErrorAction SilentlyContinue) {
          $enMarcha += "$($p.nombre) ($($p.puerto))"
        }
      }
      if ($enMarcha.Count -eq 0) { break }
      Start-Sleep -Milliseconds 700
    }
    if ($enMarcha.Count -eq 0) {
      Escribir-Ok 'verificado: ningún proceso del sistema sigue escuchando'
    }
    else {
      Escribir-Aviso ('siguen escuchando: ' + ($enMarcha -join ', '))
      Escribir-Aviso 'revísalo con «odontocrm servicios»: PM2 puede haberlos vuelto a levantar'
    }

    # Las alertas se SILENCIAN con el apagado intencional (decisión del 2026-10-14): un
    # `parar` a propósito no sonaba como avería, y la tarea «OdontoCRM · alertas» (cada
    # 5 min) no dejaba de avisar de que «no funciona ningún servicio». Se DESACTIVA (no
    # solo se detiene) para que aguante un reinicio de Windows; `arrancar` la reactiva.
    $tareaAlertas = Get-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue
    if ($tareaAlertas) {
      Disable-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue | Out-Null
      Escribir-Ok 'alertas silenciadas hasta «odontocrm arrancar»'
    }

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
    & (Get-Pm2) start all *> $null
    Escribir-Ok 'servicios arrancados; comprobando…'
    # Las alertas vuelven con el arrancar: eran las que `parar` silenció a propósito.
    $tareaAlertas = Get-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue
    if ($tareaAlertas) {
      Enable-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue | Out-Null
      Escribir-Ok 'alertas reactivadas'
    }
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
    & (Get-Pm2) restart all *> $null
    Escribir-Ok 'servicios reiniciados; comprobando…'
    # Igual que en `arrancar`: si antes hubo un `parar`, las alertas quedaron silenciadas.
    $tareaAlertas = Get-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue
    if ($tareaAlertas -and $tareaAlertas.State -ne 'Ready') {
      Enable-ScheduledTask -TaskName 'OdontoCRM · alertas' -ErrorAction SilentlyContinue | Out-Null
      Escribir-Ok 'alertas reactivadas'
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OdontoCode 'infra\windows\instalar\40-verificar.ps1') --rapido
    exit $LASTEXITCODE
  }

  { $_ -in @('compilar', 'build') } {
    Afirmar-Administrador
    Push-Location $OdontoCode
    try {
      & git rev-parse --short HEAD 2>$null | ForEach-Object { Escribir-Ok "versión en el disco: $_" }
      # Entorno limpio: si la consola trae NODE_ENV=production, `npm ci` BORRA las
      # devDependencies y la compilación muere sin `tsc` (ver Con-EntornoNpmLimpio).
      Con-EntornoNpmLimpio {
        & npm ci --silent
        if ($LASTEXITCODE -ne 0) { Morir 'falló npm ci' }
        $registro = Join-Path $env:TEMP 'odontocrm-build.log'
        & npm run build *> $registro
        if ($LASTEXITCODE -ne 0) {
          Get-Content $registro -Tail 30 | ForEach-Object { Escribir-Detalle $_ }
          Morir "falló la compilación (registro: $registro)"
        }
      }
      Escribir-Ok 'compilado (TypeScript → dist/ y la SPA en apps/web/dist)'
      $faltan = Get-EntrypointsFaltantes
      if (@($faltan).Count -gt 0) {
        foreach ($f in $faltan) { Escribir-Error "no se compiló: $f" }
        Morir 'la compilación quedó incompleta: vuelve a ejecutar «odontocrm compilar»'
      }
      Escribir-Aviso 'los servicios siguen con el código anterior hasta que se reinicien: usa «odontocrm reiniciar»'
    }
    finally { Pop-Location }
    exit 0
  }

  { $_ -in @('recompilar', 'rebuild') } {
    Afirmar-Administrador
    Push-Location $OdontoCode
    try {
      # Entorno limpio: si la consola trae NODE_ENV=production, `npm ci` BORRA las
      # devDependencies y la compilación muere sin `tsc` (ver Con-EntornoNpmLimpio).
      Con-EntornoNpmLimpio {
        & npm ci --silent
        if ($LASTEXITCODE -ne 0) { Morir 'falló npm ci' }
        $registro = Join-Path $env:TEMP 'odontocrm-build.log'
        & npm run build *> $registro
        if ($LASTEXITCODE -ne 0) {
          Get-Content $registro -Tail 30 | ForEach-Object { Escribir-Detalle $_ }
          Morir "falló la compilación (registro: $registro)"
        }
      }
      Escribir-Ok 'compilado (TypeScript → dist/)'
      $faltan = Get-EntrypointsFaltantes
      if (@($faltan).Count -gt 0) {
        foreach ($f in $faltan) { Escribir-Error "no se compiló: $f" }
        Morir 'la compilación quedó incompleta: vuelve a ejecutar «odontocrm recompilar»'
      }
    }
    finally { Pop-Location }
    & (Get-Pm2) restart all *> $null
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
        & (Get-Pm2) restart all *> $null
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
