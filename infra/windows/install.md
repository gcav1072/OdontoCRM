# OdontoCRM en Windows (desarrollo y pruebas)

Windows es el entorno de **desarrollo y pruebas**. Producción será Fedora Linux
(ver [`../fedora/INSTALL.md`](../fedora/INSTALL.md)).

## 1. Lo que ya está instalado en esta máquina

| Componente | Estado | Detalle |
| :--- | :--- | :--- |
| Node.js | ✅ | v26.7.0 (`C:\Program Files\nodejs`) |
| npm | ✅ | 11.19.0 |
| Git | ✅ | 2.55 |
| PostgreSQL | ✅ | **18**, servicio `postgresql-x64-18`, puerto 5432 |
| PM2 | ✅ | global (`C:\Users\Admin\AppData\Roaming\npm`) |
| Playwright + Chromium | ⏳ | se instala en la Fase 7 (PDF del récipe) |

Los binarios de PostgreSQL no están en el `PATH`. Para usarlos en una consola:

```powershell
$env:Path += ';C:\Program Files\PostgreSQL\18\bin'
psql --version
```

## 2. Puesta en marcha

```powershell
# Desde la raíz del repositorio
copy .env.example .env
notepad .env                 # completa PG_ADMIN_URL con la contraseña de postgres
npm install
npm run db:bootstrap          # crea las 8 bases, sus roles y las credenciales
npm run build
npm run db:migrate
npm run dev                   # compilación vigilada + gateway + identity
```

Si la contraseña de `postgres` contiene `@`, `:`, `/`, `?` o `#`, hay que
**codificarla en porcentaje** dentro de la URL (`@` → `%40`). Si prefieres no
tocarla, se puede usar `PGPASSWORD` en lugar de la URL; avísame y lo ajustamos.

## 3. Operación con PM2

```powershell
npm run build
npm run db:migrate
pm2 start infra/windows/ecosystem.config.cjs
pm2 status
pm2 logs odontocrm-gateway
pm2 save                       # recuerda la lista de procesos
```

Para que PM2 arranque solo al iniciar Windows, se necesita el instalador de
servicios (`npm i -g pm2-installer` o NSSM). Queda documentado y se deja
configurado en la Fase 10, junto con los respaldos.

También hay un atajo: `powershell -ExecutionPolicy Bypass -File infra/windows/start-services.ps1`.

## 4. Verificación

```powershell
curl http://127.0.0.1:8090/health               # gateway vivo
curl http://127.0.0.1:8090/api/v1/auth/health   # proxy hacia identity
curl http://127.0.0.1:4001/ready                # identity + PostgreSQL
```

Salidas esperadas:

- `/health` → `{"service":"gateway","status":"ok",...}`
- `/api/v1/auth/health` → `{"service":"identity","status":"ok",...}`
- `/ready` → `{"status":"ok","checks":[{"name":"database","status":"ok",...}]}`

## 5. Problemas frecuentes

| Síntoma | Causa y solución |
| :--- | :--- |
| `Configuración inválida para el servicio "identity"` | Falta `DATABASE_URL`: ejecuta `npm run db:bootstrap`. |
| `Falta PG_ADMIN_URL` | No existe el `.env` de la raíz o está sin completar. |
| `/ready` responde 503 con `database` en error | PostgreSQL no está corriendo: `Get-Service postgresql-x64-18`. |
| `error: password authentication failed` | Contraseña incorrecta o mal codificada en la URL. |
| `Falta services/identity/dist/db/migrate.js` | Compila primero: `npm run build`. |
| El gateway no arranca con `listen EACCES` | En esta máquina el **8080** lo ocupa el servicio de red del host (`hns`/Hyper-V). El proyecto usa **8090**; comprueba con `Get-NetTCPConnection -LocalPort 8090` y cambia `GATEWAY_PORT` en el `.env` si hiciera falta. |

## 6. Qué NO se instala

Nada de Docker, RabbitMQ, Redis ni MinIO: la mensajería usa *outbox* + `pg-boss`
sobre el propio PostgreSQL y las contraseñas usan `scrypt` de Node, así que
tampoco hace falta Visual Studio Build Tools.
