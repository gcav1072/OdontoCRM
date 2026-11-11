# Licenciamiento offline y pruebas

Guía del **proveedor** para vender, emitir y renovar licencias de OdontoCRM, y
referencia de lo que ve el consultorio. La decisión está en el
[ADR 0075](adr/0075-licenciamiento-offline-y-modo-consulta.md).

> **Regla de oro.** La clave **privada** con la que se firman las licencias vive
> en una máquina del proveedor, fuera del repositorio y **nunca** en un servidor
> de consultorio. El consultorio solo tiene la clave **pública** (que viaja en la
> app) y puede verificar, no firmar.

## Qué se vende

El producto se vende **por tiempo, no por usuario ni por sillón**. Todos los
planes llevan el producto completo:

| Estado | Duración | Cómo se obtiene |
| :--- | :--- | :--- |
| **Prueba** | **30 días** desde la instalación | Automática: la crea la migración. No se emite nada |
| **Mensual** | 30 días | Licencia firmada |
| **Trimestral** | 90 días | Licencia firmada |
| **Anual** | 365 días | Licencia firmada |

La licencia se puede renovar antes de que venza: los días **se suman** al
vencimiento vigente (`max(ahora, vencimiento) + duración`), así que renovar
pronto no pierde días. No hay periodo de gracia: con la licencia o la prueba
vencida la instalación pasa a **modo consulta**.

## Qué pasa cuando vence (modo consulta)

No se bloquea el acceso a los datos: se deja de poder **escribir**.

- **Sí** se puede: entrar, ver pacientes, historia clínica, odontograma,
  facturas y reportes; **imprimir**; **exportar**; abrir los enlaces de
  verificación de récipes/expedientes; y **activar la licencia**.
- **No** se puede: crear o editar pacientes, citas, historia, cobros,
  configuración, usuarios, etc.

Técnicamente no hay un guardia nuevo en los servicios: el token de acceso se
emite con menos permisos (solo lectura, más `licensing:manage` para que el
titular pueda activar). Un token ya emitido conserva la escritura como máximo
15 minutos, hasta que la sesión se refresca.

## Piezas y dónde viven

| Pieza | Ubicación | ¿Se versiona? |
| :--- | :--- | :--- |
| Formato, reglas y estados | `packages/contracts/src/domain/licensing.ts` | Sí (código) |
| Verificación de la firma | `packages/kernel/src/licensing.ts` y `services/identity` | Sí (código) |
| Clave **pública** | `assets/licencias/licencia-publica.pem` | **Sí** (no es secreta) |
| Clave **privada** | `~/.config/odontocrm/licencias/licencia-privada.pem` (`%APPDATA%` en Windows) | **No** |
| Registro y `.lic` emitidos | `~/.local/share/odontocrm/licencias/` (`%LOCALAPPDATA%` en Windows) | **No** |
| CLI emisor | `tools/licencia.mjs` | Sí (código) |
| Bot emisor (proveedor) | `tools/licencia-bot.mjs` | Sí (código) |
| Instalación del bot emisor | [`infra/licencias/INSTALL.md`](../infra/licencias/INSTALL.md) | Sí (código) |

## Flujo completo

```
CONSULTORIO   /licencia (web) o /licencia (bot del consultorio)
              → muestra el estado, el `installationId` y la SOLICITUD ya armada
              con un código `ODO-REQ1.…` para reenviar
   │
   │  el dueño la manda por WhatsApp / correo
   ▼
PROVEEDOR     CLI (`npm run licencia`) o bot del proveedor
              → elige tipo, firma la licencia y devuelve un archivo `.lic`
   │
   │  se lo reenvía al dueño
   ▼
CONSULTORIO   activa de una de estas tres formas:
              · web  → /licencia → pegar el token o subir el .lic
              · bot  → reenviar el archivo .lic al bot de administración
              · consola → sudo odontocrm licencia activar /ruta/licencia.lic
              → la escritura vuelve sin reiniciar (el siguiente refresco de
                sesión emite permisos completos)
```

## Emitir desde la máquina del proveedor

Preparación (una sola vez): ver [`infra/licencias/INSTALL.md`](../infra/licencias/INSTALL.md)
y `npm run licencia -- claves --publicar`. La privada se respalda **ya**, en dos
copias offline; sin ella no se pueden emitir más licencias.

```bash
# Emitir la primera licencia de una instalación
npm run licencia -- emitir \
  --instalacion 5546502e-93af-4df5-b3b0-1a217cf2a4eb \
  --cliente "Consultorio Sonrisa" --rif J-12345678-9 \
  --tipo mensual

# Renovar (suma días al vencimiento del registro)
npm run licencia -- renovar --instalacion 5546502e-… --tipo anual

# Qué vence pronto (y qué ya venció)
npm run licencia -- pendientes --dias 30

# Comprobar un archivo o un token antes de mandarlo
npm run licencia -- verificar /ruta/licencia.lic
```

El CLI deja el `.lic` en `emitidas/` del directorio de datos y anota la emisión
en `registro.jsonl` (consultorio, instalación, tipo, fechas, licencia anterior).
Ese registro es la memoria comercial: **respáldalo** junto con la clave privada.

### Bot del proveedor

`npm run licencia:bot` escucha **solo tu chat** (`LICENCIA_BOT_CHAT_ID`, en
`licencia-bot.env`, nunca en el repo) y permite emitir desde el móvil:

```
/emitir <uuid> <mensual|trimestral|anual> [--cliente "…"] [--rif …]
/renovar <uuid> <tipo>
/licencia <uuid>
/pendientes [dias]
```

Si le reenvías una solicitud `ODO-REQ1.…` del consultorio, la decodifica y te
pregunta el tipo; respondes `/mensual`, `/trimestral` o `/anual` y te devuelve el
`.lic` listo para reenviar. Telegram no deja que un bot le escriba a otro: el
archivo lo reenvía una persona.

## Activar en el consultorio

- **Web**: `/licencia` (solo el administrador). Pega el token o sube el `.lic`.
  Tras activar se refresca la sesión y vuelven los permisos de escritura.
- **Bot del consultorio**: el dueño reenvía el archivo `.lic` al chat del bot de
  administración; el bot verifica la firma y confirma tipo y vencimiento. El
  bot **no puede emitir ni revocar**: no tiene la clave privada.
- **Consola del servidor** (instalación asistida y soporte):

```bash
sudo odontocrm licencia                       # estado + instalación + solicitud
sudo odontocrm licencia solicitud             # solo el código ODO-REQ1.…
sudo odontocrm licencia activar /ruta/licencia.lic
```

Los tres caminos escriben el mismo estado (en la base de identity), quedan en
la **auditoría** (`license_activated`) y no requieren reiniciar nada.

## Renovar, revocar y reinstalar

- **Renovar** = emitir una licencia nueva. Si llega antes del vencimiento, suma
  días; si llega después, empieza a contar desde «ahora».
- **Revocar** = **no renovar**. En offline no existe una revocación remota: la
  licencia es un documento firmado con fecha y el cliente controla su servidor.
  Si algún día hace falta corte inmediato o telemetría, se añade validación en
  línea reutilizando el mismo formato.
- **Reinstalar de cero** crea una instalación nueva (trial nuevo) y la licencia
  vieja **no sirve** en ella: está atada al `installationId`. Emite una nueva.
- **Restaurar un respaldo o mudar el disco** conserva la instalación y la
  licencia: no hay que hacer nada.
- **Una licencia filtrada** no sirve en otra instalación (claim `instalacion`).
- Si el consultorio tiene que reinstalar y quiere conservar la licencia, lo
  correcto es restaurar el respaldo; si no, se emite otra.

## Reloj atrasado

La instalación guarda `last_seen_at` y solo lo hace avanzar. Si el reloj del
servidor retrocede más de 24 h respecto al último uso, la instalación pasa a
modo consulta y lo avisa: estirar la prueba cambiando la hora no funciona.
Adelantar el reloj solo acorta la licencia. La solución es poner la hora bien
(NTP) y volver a entrar.

## Rotación de claves

Si la clave privada se pierde o se compromete:

1. `npm run licencia -- claves --force --publicar` (nueva privada fuera del repo,
   nueva pública en `assets/licencias/licencia-publica.pem`).
2. Commit y despliegue de la app en los consultorios (`sudo odontocrm actualizar`).
3. Reemitir las licencias activas con la clave nueva.
4. Reiniciar el bot del proveedor (cachea la clave con la que firma).

Una vez publicada una clave nueva, las licencias emitidas con la anterior dejan
de verificar: por eso la rotación incluye reemisión.

## Puesta en marcha por consultorio (checklist)

1. Instalar la app (Fedora o Windows) → el trial de 30 días arranca solo.
2. Entrar como titular y completar la identidad del consultorio (nombre y RIF
   aparecen en la solicitud).
3. Abrir `/licencia`, copiar la solicitud (`installationId` + `ODO-REQ1.…`) y
   mandarla al proveedor **antes** de que acabe la prueba.
4. Recibir el `.lic` y activarlo (web, bot o consola).
5. Verificar: `/licencia` muestra «Licencia mensual/trimestral/anual vigente
   hasta …» y `sudo odontocrm licencia` lo confirma.

Para instalaciones que ya estaban en uso: emitir su licencia **antes** de
desplegar esta versión; la migración no debe convertir en prueba a un cliente
que ya pagó.

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
| :--- | :--- | :--- |
| La activación responde «Esta instalación no tiene la clave pública…» | Falta `assets/licencias/licencia-publica.pem` en el despliegue | Publicar la clave (`claves --publicar`), commit y `sudo odontocrm actualizar` |
| «La licencia pertenece a otra instalación» | El `.lic` se emitió para otro `installationId` | Emitir para el UUID que muestra `/licencia` |
| «La licencia ya venció» | El `.lic` es viejo | Emitir una renovación |
| «La licencia no es válida» | Archivo dañado/cortado o firmado con otra clave | Reenviar el `.lic` original; verificar con `npm run licencia -- verificar` |
| El banner dice modo consulta y no vuelve | La sesión no se ha refrescado | Recargar la página o volver a entrar (el token dura 15 min) |
| `sudo odontocrm licencia` no conecta | Los servicios no están arriba o falta el secreto interno | `sudo odontocrm estado`; el comando lee `/etc/odontocrm` como root |

## Notas de seguridad

- La licencia es **disuasión**, no DRM: quien tiene `root` sobre el servidor del
  consultorio puede parchear la app. El objetivo es ordenar la renovación con
  clientes honestos y evitar copias fáciles entre instalaciones.
- Nunca se instala la clave privada, el token del bot emisor ni el registro de
  clientes en un servidor de consultorio. La app y las herramientas del
  consultorio solo llevan la clave pública.
- El `.lic` no es un secreto: es un documento firmado. Se puede enviar por
  WhatsApp o correo; no sirve en otra instalación ni se puede alterar.
