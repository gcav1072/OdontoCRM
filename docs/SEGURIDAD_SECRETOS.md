# Política de secretos y tokens — OdontoCRM

> **Regla número uno: un secreto no entra al repositorio, no se pega en un chat y no se muestra en pantalla compartida.**
> Vive en un archivo del entorno, se lee por el proceso que lo necesita y se rota cuando hay dudas.

Este documento responde a la pregunta «¿cómo te paso el token del bot con la mejor práctica posible?» y aplica a **todos** los secretos del sistema.

---

## 1. Cómo me pasas el token del bot (y la contraseña de PostgreSQL)

**No me lo escribas en el chat.** Aunque la conversación parezca privada, el secreto queda en un historial de texto del que no se puede borrar. El procedimiento correcto es:

1. Yo dejo creado el archivo con los **nombres** de las variables y valores de ejemplo (`.env.example`), y el `.gitignore` que impide que el archivo real entre a Git.
2. **Tú** creas el archivo real y pegas el valor **en tu equipo**:
   - Contraseña del superusuario de PostgreSQL → `C:\Users\Admin\Documents\OdontoCRM\.env`
   - Token del bot → `C:\Users\Admin\Documents\OdontoCRM\services\notifications\.env`
3. Yo **leo el archivo desde el proceso** (nunca lo imprimo, nunca lo copio a un documento, nunca lo incluyo en un commit) y ejecuto lo que haga falta.
4. Si en algún momento sospechas que un secreto se filtró (lo pegaste en un chat, en una captura o en un issue), se **rota**: nuevo token en BotFather con `/revoke`, o nueva contraseña, y se actualiza solo el archivo.

### Procedimiento exacto para el bot de Telegram

1. Abre Telegram y busca **@BotFather**.
2. `/newbot` → nombre visible: `Consultorio - Od. Erika Gómez` (este nombre **sí se cambia después** cuando quieras con `/setname`).
3. Te pedirá un **usuario** terminado en `bot`, por ejemplo `ConsultorioErikaGomezBot`. El `@usuario` también se puede cambiar con `/setusername`, pero **cambiar el `@usuario` rompe los enlaces `t.me/...` que ya hayas compartido**. Si eso llegara a pasar, se crea otro bot y se reemplaza el token: nada más se pierde.
4. BotFather responde con una línea tipo `123456789:AA...` — **ese es el token**. Cópialo.
5. En tu equipo: abre `C:\Users\Admin\Documents\OdontoCRM\services\notifications\.env` y pega:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_BOT_USERNAME=ConsultorioErikaGomezBot
   ```
6. Aviso: el bot **solo puede escribirle a quien le haya escrito primero** (`/start`). De ahí el *deep link* `t.me/<usuario>?start=<codigo>` para vincular pacientes registrados en recepción.
7. `/setprivacy` se deja en el valor por defecto; no necesitamos leer mensajes de grupo.

### Procedimiento exacto para PostgreSQL

1. Abre `C:\Users\Admin\Documents\OdontoCRM\.env` y escribe **una sola línea**:
   ```
   PG_ADMIN_URL=postgres://postgres:TU_PASSWORD@127.0.0.1:5432/postgres
   ```
   (la contraseña es la que definiste al instalar PostgreSQL 18; en un password con caracteres especiales como `@`, `:` o `/` hay que *codificarlos* — si te da error, dime y lo resolvemos con `PGPASSWORD` en lugar de la URL).
2. Yo ejecuto `npm run db:bootstrap`. Ese script:
   - crea las 8 bases y los 8 roles con **contraseñas aleatorias de 32 bytes** generadas en el momento;
   - escribe `services/<servicio>/.env` con la cadena de conexión de **ese** servicio (archivo ignorado por Git);
   - **no imprime** ninguna contraseña en pantalla ni en los logs.
3. La contraseña del superusuario solo se usa una vez, para el bootstrap. El día a día usa los roles por servicio, cada uno con privilegios **solo** sobre su propia base.

---

## 2. Inventario de secretos

| Secreto | Dónde vive (desarrollo) | Dónde vive (Fedora) | Quién lo genera |
| :--- | :--- | :--- | :--- |
| `PG_ADMIN_URL` (superusuario) | `.env` raíz (ignorado) | se usa una vez y se guarda en el gestor de contraseñas del administrador | tú, al instalar PostgreSQL |
| Credenciales de los 8 servicios | `services/<svc>/.env` | `/etc/odontocrm/<svc>.env` | `npm run db:bootstrap` (aleatorias) |
| `TELEGRAM_BOT_TOKEN` | `services/notifications/.env` | `/etc/odontocrm/notifications.env` | tú, vía BotFather |
| Clave privada JWT (EdDSA) | `services/identity/.keys/jwt-private.pem` (ignorado) | `/etc/odontocrm/keys/jwt-private.pem` (`0600`) | `npm run keys:generate` (Fase 1) |
| `INTERNAL_SERVICE_SECRET` | `.env` por servicio | `/etc/odontocrm/internal-secret.env` | bootstrap |
| `COOKIE_SECRET` | `.env` de identity | `/etc/odontocrm/identity.env` | bootstrap |
| Token de dispositivo de cada pantalla | se genera desde el panel `/pantallas` y se guarda **hasheado** en la BD | igual | el sistema (Fase 5) |
| `WHATSAPP_TOKEN` (Cloud API) | `services/notifications/.env` | `/etc/odontocrm/notifications.env` | tú, en Meta for Developers |
| `WHATSAPP_VERIFY_TOKEN` | `services/notifications/.env` | igual | tú, al dar de alta el webhook |
| `WHATSAPP_APP_SECRET` | `services/notifications/.env` | igual | Meta (app → configuración básica) |

**El webhook de WhatsApp es la única ruta pública además de la salud y el login.** Meta no manda
JWT, así que la autenticación es la **firma** `x-hub-signature-256`: HMAC-SHA256 del **cuerpo crudo**
con el `app_secret`. El adaptador la verifica en tiempo constante **antes** de procesar nada y
rechaza con 401 lo que no la traiga; el `app_secret` y el `verify_token` no salen del `.env`. Si el
webhook se expone a internet por el túnel, el resto de la API sigue cerrada tras el gateway y el JWT.

**Nunca son secretos configurables por el usuario** (van en `.env.example` sin valor): puertos, URLs internas, zona horaria, nombre de la clínica. Eso no es sensible y ayuda a desplegar.

**El token de una pantalla kiosko** se muestra **una sola vez** al registrarla y en la base queda su
hash (como el de refresco de una sesión). La pantalla lo canjea en `POST /api/v1/auth/device` —ruta
pública, porque el televisor no tiene usuario ni cookie— por un JWT de 15 minutos con el rol
`pantalla` y el único permiso `screens:display`; el token de larga vida nunca viaja en cada petición.
El enlace de configuración lleva el token en la consulta y la pantalla lo **borra de la barra de
direcciones** en cuanto lo guarda. Desactivar la pantalla en `/pantallas` corta el acceso al
instante, aunque el token siga vigente.

---

## 3. Reglas técnicas

- El `.gitignore` raíz excluye `.env`, `.env.*`, `!.env.example`, `*.pem`, `*.key`, `.keys/`, y cualquier variante local.
- `tools/check-secrets.mjs` se ejecuta antes de cada commit (`npm run check-secrets`): busca patrones de token de Telegram (`\d{8,10}:[A-Za-z0-9_-]{35}`), cadenas de conexión con contraseña, claves PEM y archivos `.env` que se hayan colado en el *staging*.
- Los servicios leen la configuración con **Zod** (`packages/kernel/config.ts`): si falta una variable obligatoria, el servicio **no arranca** y dice cuál falta; si una variable trae un valor por defecto inseguro en producción, también falla.
- Los logs usan una lista de campos censurados (`password`, `token`, `authorization`, `cookie`, `secret`, `pgAdminUrl`) — `packages/kernel/logger.ts`.
- Los mensajes de error **nunca** incluyen la cadena de conexión ni el contenido del `.env`.
- Las contraseñas de usuario del CRM se guardan con **scrypt** (`node:crypto`), jamás en texto plano ni con hash reversible.
- En Fedora, `/etc/odontocrm` es `root:root 0700` y cada `.env` es `root:odontocrm 0640`, con la unidad `systemd` leyéndolos por `EnvironmentFile=`. El usuario `odontocrm` no puede modificarlos, solo leerlos.
- El directorio de *storage* y los respaldos también quedan fuera de cualquier sincronización con repositorios o servicios en la nube.

---

## 4. Si algo se filtra

1. **Rotar de inmediato**, no borrar mensajes: asumir que el secreto es público.
   - Bot: BotFather → `/revoke` (o `/token`) y actualizar `services/notifications/.env`; reiniciar el servicio.
   - Base de datos: `ALTER ROLE <rol> WITH PASSWORD '<nueva>'` y actualizar el `.env` correspondiente.
   - JWT: regenerar el par de claves (invalida todas las sesiones).
2. Revisar la auditoría (`/auditoria`) por accesos o cambios no reconocidos en la ventana de exposición.
3. Anotar el incidente en `CHANGELOG.md` con fecha, secreto afectado y medida tomada (sin escribir el valor).

---

## 5. Lo que yo (el agente) hago y no hago

- **Leo** los archivos `.env` cuando necesito ejecutar algo, porque forman parte del entorno de trabajo.
- **No los imprimo** en la conversación, no copio valores a documentos, no los incluyo en commits ni en resúmenes.
- Si necesito verificar que un secreto está bien definido, compruebo **longitud y prefijo** (`TELEGRAM_BOT_TOKEN definido: sí, 46 caracteres`), nunca el valor.
- Si detecto un secreto versionado o pegado en el chat, **lo digo de inmediato** y propongo rotarlo.
