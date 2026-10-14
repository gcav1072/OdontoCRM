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

> **PM2 en Windows es UNO por máquina.** Sus «pipes» tienen nombre fijo y global
> (`\\.\pipe\rpc.sock` y `\\.\pipe\pub.sock`; hay un `@todo` en `pm2/paths.js`), así que el demonio
> que los tiene atiende a **todos** los `pm2` —el CLI hace `pingDaemon` por el pipe y reutiliza al
> que escuche, sea cual sea su `PM2_HOME`—. Si esta misma máquina tiene además una instalación de
> producción ([`INSTALL.md`](INSTALL.md)), eso se nota en las dos direcciones:
>
> - Con el **servicio** de producción en marcha, `npm run stack:fijo` no arranca «tu» PM2: sus
>   órdenes van al demonio del servicio (que corre como `LocalService`), así que la pila de
>   desarrollo acabaría dentro de él y `pm2 save` escribiría en tu dump. Mezclarlos no tiene sentido.
> - Al revés: con un demonio de desarrollo vivo, el servicio de producción **no puede arrancar**
>   (`connect EPERM //./pipe/pub.sock` en `C:\ProgramData\pm2\service\service.log`) y `winsw` lo deja
>   en `Stopped` tras sus reintentos.
>
> Regla: **uno a la vez**. Antes de probar la producción, ningún `pm2` de desarrollo en marcha (el
> instalador se ocupa de quitar el que deje la propia instalación). Para volver a desarrollo, retira
> antes el servicio de producción con `infra\windows\instalar\desinstalar.ps1` y arranca
> `npm run stack:fijo`.

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
| El servicio `pm2.exe` está en `Stopped` o sale `connect EPERM //./pipe/pub.sock` | Otro PM2 (el de desarrollo, por ejemplo) tiene los «pipes», que en Windows son únicos: mira la nota de §3 y deja uno solo. |

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
