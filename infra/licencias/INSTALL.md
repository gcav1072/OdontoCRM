# Emisor de licencias — instalación (máquina del proveedor)

Herramientas con las que **el proveedor** emite, renueva y verifica licencias offline de OdontoCRM
([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)). El consultorio recibe
una licencia firmada y la activa; **nunca** ejecuta nada de esto.

> **Regla de oro:** este bot corre en una máquina **tuya**. La clave privada con la que se firman
> las licencias no se instala en un servidor de consultorio, no se versiona y no se pega en un chat.
> Sin ella no se puede emitir; con ella, cualquiera podría.

## Qué hay y dónde vive

| Pieza                      | Ubicación                                            | ¿Se versiona?          |
| -------------------------- | ---------------------------------------------------- | ---------------------- |
| CLI `npm run licencia`     | `tools/licencia.mjs` (este repo)                     | Sí (es código)         |
| Bot `npm run licencia:bot` | `tools/licencia-bot.mjs` (este repo)                 | Sí (es código)         |
| Clave **pública**          | `assets/licencias/licencia-publica.pem` (este repo)  | **Sí** (no es secreta) |
| Clave **privada**          | `~/.config/odontocrm/licencias/licencia-privada.pem` | **No**                 |
| Credenciales del bot       | `~/.config/odontocrm/licencias/licencia-bot.env`     | **No**                 |
| Registro y `.lic` emitidos | `~/.local/share/odontocrm/licencias/`                | **No**                 |

En Windows: `%APPDATA%\odontocrm\licencias\` (configuración) y `%LOCALAPPDATA%\odontocrm\licencias\`
(datos). Las rutas se pueden mover con `ODONTOCRM_LICENCIAS_CONFIG_DIR` y
`ODONTOCRM_LICENCIAS_DATA_DIR` (útil en un servidor dedicado).

## Requisitos

- Node.js **≥ 22.9** (el mismo que la app).
- Una copia **del repositorio** en esa máquina (para el CLI y el bot), actualizable con `git pull`.
- PM2 en Windows o systemd en Fedora para que el bot escuche siempre.
- Un **bot de Telegram nuevo y exclusivo** del proveedor (BotFather). No reutilices el bot de
  administración de un consultorio.

## 1. Preparar el repo

```bash
git clone <repo> odontocrm-proveedor      # o el clon que ya uses
cd odontocrm-proveedor
npm ci
npm run build:node                         # tools importa @odontocrm/contracts y @odontocrm/kernel
```

## 2. Generar el par de claves y publicar la pública

```bash
npm run licencia -- claves --publicar
```

- Deja la **privada** en el directorio de configuración con permisos de solo el usuario (0600), y la
  **pública** en el mismo directorio y en `assets/licencias/licencia-publica.pem` del repo.
- **Respalda la privada ya**, en dos copias offline (gestor de contraseñas, USB cifrado, caja fuerte).
  Si se pierde, no se pueden emitir más licencias (habría que generar otra y actualizar la app).
- Commitea el asset público y **despliega la app** en los consultorios: la verificación de la
  licencia usa esa clave.

Si necesitas regenerar el par: `npm run licencia -- claves --force`. Ojo: **invalida las licencias
ya emitidas** (la pública cambia), hay que reemitirlas, desplegar la app nueva y **reiniciar el bot**
(el bot cachea la clave con la que firma; al reiniciar toma la nueva).

## 3. Crear el bot de Telegram

1. En Telegram, habla con **@BotFather** → `/newbot` → guarda el **token** (`123456:ABC…`).
2. Abre el chat con el bot nuevo y envíale `/start` (así el bot puede responderte).
3. Comprueba tu **chat id** (por ejemplo con @userinfobot) y guárdalo.
4. Crea el archivo de credenciales, en el directorio de configuración:

   - Linux/Fedora: `~/.config/odontocrm/licencias/licencia-bot.env`
   - Windows: `%APPDATA%\odontocrm\licencias\licencia-bot.env`

   ```env
   LICENCIA_BOT_TOKEN=123456:ABC-DEF...
   LICENCIA_BOT_CHAT_ID=987654321
   # TELEGRAM_API_BASE=https://api.telegram.org   (solo si usas un proxy)
   ```

   Con permisos de solo el usuario (`chmod 600` en Linux). El bot **solo responde a ese chat**;
   cualquier otro mensaje se ignora en silencio.

## 4. Dejarlo corriendo

### Windows (PM2)

```powershell
pm2 start infra/licencias/ecosystem.config.cjs
pm2 save
pm2 startup          # una vez, para que arranque con el usuario
pm2 logs odontocrm-licencias
```

### Fedora (systemd)

```bash
mkdir -p ~/.config/odontocrm ~/.local/share/odontocrm   # el usuario que corre el bot

# Ajusta User=, Group= y WorkingDirectory= en el archivo antes de instalarlo
sudo install -m 0644 -o root -g root \
  infra/licencias/odontocrm-licencias.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now odontocrm-licencias.service
journalctl -u odontocrm-licencias -n 50 --no-pager
```

### Comprobación rápida

```bash
node tools/licencia-bot.mjs --ayuda     # no necesita token ni red
node tools/licencia-bot.mjs --una-vez   # lee actualizaciones pendientes y sale
```

Luego escribe `/ayuda` al bot en Telegram: debe responder con los comandos.

## 5. Uso diario

### Por Telegram (el bot del proveedor)

- Reenvía al bot un mensaje que empiece por `ODO-REQ1.…` (lo genera el consultorio en `/licencia` o
  en su bot). El bot muestra el consultorio y la instalación, y pregunta el tipo.
- Responde **`/mensual`**, **`/trimestral`**, **`/anual`** o **`/vitalicia`**. El bot emite, anota el registro y te
  manda el `.lic` como documento.
- Reenvía ese archivo al consultorio (por WhatsApp o Telegram): allí lo reenvían al **bot de
  administración** o lo suben en `/licencia` de la app, y queda activado.
- `/renovar <uuid> <tipo>` renueva sumando días al vencimiento vigente.
- `/pendientes` (o `/pendientes 60`) te dice a quién hay que renovar.
- `/licencia <uuid>` muestra la última licencia de esa instalación.

### Por consola

```bash
npm run licencia -- emitir --instalacion <uuid> --cliente "Clínica X" --rif J-12345678-9 --tipo mensual
npm run licencia -- renovar --instalacion <uuid> --tipo anual
npm run licencia -- pendientes --dias 30
npm run licencia -- verificar ~/.local/share/odontocrm/licencias/emitidas/LIC-2026-0001.lic
```

Los tipos son `mensual` (30 días), `trimestral` (90), `anual` (365) y `vitalicia` (sin vencimiento). Renovar antes de tiempo
**suma** los días: si renuevas 5 días antes, el nuevo vencimiento parte del actual.

## 6. Actualizar

```bash
cd odontocrm-proveedor
git pull
npm ci
npm run build:node
# Windows:
pm2 restart odontocrm-licencias
# Fedora:
sudo systemctl restart odontocrm-licencias.service
```

El formato de licencia y los claims viven en `@odontocrm/contracts`; emisor y app comparten repo, así
que actualizar el emisor y desplegar la app van juntos cuando cambie el formato (lo avisa el
CHANGELOG).

## 7. Respaldo (importante)

Copia fuera de la máquina, cifrado:

1. `licencia-privada.pem` — **sin ella no hay más emisiones**.
2. `licencia-bot.env` — se puede regenerar con BotFather.
3. `registro.jsonl` y `emitidas/*.lic` — la memoria comercial (a quién se le emitió y hasta cuándo).

Si pierdes la clave privada: genera un par nuevo con `--force`, publica la pública en el repo,
despliega la app y **reemite** la licencia de cada consultorio (las viejas dejan de verificar).

## 8. Problemas frecuentes

- **El bot no responde:** revisa que el proceso esté vivo (`pm2 status` / `systemctl status`), que
  `licencia-bot.env` esté en el directorio correcto y que el chat id sea el tuyo. Al arrancar sin
  credenciales el proceso sale con 0 a propósito (`--una-vez`) o queda reintentando cada 60 s.
- **`/emitir` pide `--cliente`:** es la primera licencia de esa instalación y no hay solicitud
  pendiente ni registro previo que indique el nombre; pásalo explícitamente.
- **`verificar` dice que no es válida:** archivo incompleto o manipulado, o no es la clave pública
  correcta (`--publica`). La app rechaza igual de claro al activar.
- **El consultorio dice «licencia de otra instalación»:** se emitió con otro UUID; mira el que
  muestra su `/licencia` y vuelve a emitir.
- **Un `.lic` filtrado no sirve en otro consultorio:** la licencia está atada al `installation_id`.

## Nunca

- No instales este bot en un servidor de consultorio.
- No subas `licencia-privada.pem` ni `licencia-bot.env` al repo, a un chat o a una copia
  compartida.
- No uses el bot de administración del consultorio para emitir: allí no está la clave (ni debe
  estar) y solo puede **activar** lo que le reenvíen.
