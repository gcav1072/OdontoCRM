# Arranca OdontoCRM en Windows (desarrollo) con PM2.
#
#   powershell -ExecutionPolicy Bypass -File infra/windows/start-services.ps1
#
# Compila, aplica migraciones y levanta los servicios. No instala nada.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

function Assert-Command([string] $name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Falta el comando '$name'. Revisa infra/windows/install.md."
  }
}

Assert-Command node
Assert-Command npm
Assert-Command pm2

if (-not (Test-Path (Join-Path $root '.env'))) {
  throw "No existe .env. Copia .env.example, completa PG_ADMIN_URL y vuelve a intentarlo."
}

if (-not (Test-Path (Join-Path $root 'services/identity/.env'))) {
  Write-Host '→ Generando bases y credenciales (db:bootstrap)…'
  npm run db:bootstrap
}

Write-Host '→ Compilando…'
npm run build

Write-Host '→ Aplicando migraciones…'
npm run db:migrate

Write-Host '→ Arrancando servicios con PM2…'
pm2 start infra/windows/ecosystem.config.cjs
pm2 save | Out-Null

Start-Sleep -Seconds 3
pm2 status

Write-Host ''
Write-Host 'Comprobaciones:'
foreach ($url in @(
    'http://127.0.0.1:8090/health',
    'http://127.0.0.1:8090/api/v1/auth/health',
    'http://127.0.0.1:4001/ready',
    'http://127.0.0.1:4002/ready',
    'http://127.0.0.1:4003/ready',
    'http://127.0.0.1:4004/ready',
    'http://127.0.0.1:4005/ready',
    'http://127.0.0.1:4006/ready',
    'http://127.0.0.1:4007/ready',
    'http://127.0.0.1:4008/ready'
  )) {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    Write-Host ("  ✔ {0} → {1}" -f $url, $response.StatusCode)
  }
  catch {
    Write-Host ("  ✖ {0} → {1}" -f $url, $_.Exception.Message)
  }
}

Write-Host ''
Write-Host 'Logs: pm2 logs odontocrm-gateway   ·   Detener: pm2 stop all'
