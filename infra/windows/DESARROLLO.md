# OdontoCRM en Windows (desarrollo y pruebas)

> **Esto es la guía de DESARROLLO.** Para dejar un **servidor de la clínica** en Windows, mira
> [`INSTALL.md`](INSTALL.md). Windows es hoy **destino de desarrollo y también de producción**
> ([ADR 0050](../../docs/adr/0050-windows-segundo-destino-de-produccion.md)).

## 1. Lo que se necesita en la máquina

| Componente | Estado esperado | Detalle |
| :--- | :--- | :--- |
| Node.js | ✅ | 22.9 o superior (aquí, v26) |
| npm | ✅ | viene con Node |
| Git | ✅ | |
| PostgreSQL | ✅ | **18**, servicio `postgresql-x64-18`, puerto 5432 |
| PM2 | opcional | para la pila «fija» (`npm run stack:fijo`) |
| Playwright + Chromium | ⏳ | para el PDF del récipe y las pruebas `e2e` |

Los binarios de PostgreSQL **no están en el `PATH`** por defecto. Para usarlos en una consola:

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
npm run db:bootstrap          # crea las bases, sus roles y las credenciales
npm run build
npm run db:migrate
npm run dev                   # compilación vigilada + servicios + interfaz
```

Si la contraseña de `postgres` contiene `@`, `:`, `/`, `?` o `#`, hay que **codificarla en
porcentaje** dentro de la URL (`@` → `%40`).

> **Nunca** pongas aquí la contraseña de una instalación de producción: los `.env` del
> repositorio son **solo de desarrollo**. En el servidor los secretos viven en
> `C:\ProgramData\OdontoCRM\env` (mira [`INSTALL.md`](INSTALL.md)).

## 3. Operación con PM2 (pila «fija» de desarrollo)

```powershell
npm run build
npm run db:migrate
npm run stack:fijo             # arranca la pila con PM2 (sobrevive a la terminal)
npm run stack:status           # ¿qué está corriendo?
npm run stack:down             # la para
```

`stack:fijo` usa `infra/windows/ecosystem.config.cjs` (rutas relativas al repositorio). **No lo
confundas con la producción**: el servidor usa
`infra/windows/ecosystem.produccion.config.cjs` (rutas absolutas y secretos en ProgramData).

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
| El gateway no arranca con `listen EACCES` | En algunas máquinas el **8080** lo ocupa el servicio de red del host (`hns`/Hyper-V). El proyecto usa **8090**; comprueba con `Get-NetTCPConnection -LocalPort 8090`. |
| Los PDF devuelven 503 | Falta Chromium: `npx playwright install chromium` (en el servidor lo baja `30-desplegar.ps1`). |

## 6. Qué NO se instala

Nada de Docker, RabbitMQ, Redis ni MinIO: la mensajería usa *outbox* + `pg-boss` sobre el
propio PostgreSQL y las contraseñas usan `scrypt` de Node, así que tampoco hacen falta Visual
Studio Build Tools.

## 7. Notas para escribir guiones de PowerShell

Los guiones del instalador (`infra\windows\instalar\`) siguen estas reglas, aprendidas a golpes:

- **Guarda los `.ps1` como UTF-8 CON BOM.** PowerShell 5.1 lee sin BOM como ANSI y destroza los
  acentos (hasta romper el parser). `comun.ps1` pone la consola en UTF-8 para la salida.
- **No pongas `$ErrorActionPreference = 'Stop'`** en un guion que llame a órdenes nativas
  (`npm`, `git`, `psql`…): en 5.1, la salida de error de una orden nativa se vuelve un error
  terminante y el guion aborta. Comprueba `$LASTEXITCODE`.
- **Cuidado con `"$variable: …"`**: PowerShell lo lee como *scope qualifier*. Usa `"${variable}: …"`.
- Concede permisos **por SID** (`*S-1-5-32-544`, `*S-1-5-19`, `*S-1-5-18`), no por nombre.
