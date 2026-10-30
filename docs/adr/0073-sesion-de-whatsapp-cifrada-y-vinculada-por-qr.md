# 0073 — La sesión de WhatsApp vive cifrada en la base y se vincula por QR

- **Fecha:** 2026-10-29 · **Estado:** propuesta (implementación en curso)

## Contexto

Baileys necesita conservar entre reinicios las credenciales Signal del
dispositivo vinculado (creds, pre-keys, sesiones, sender-keys, app-state y el
mapeo LID↔PN). `useMultiFileAuthState` escribe decenas de ficheros sueltos, no
se recomienda para producción y queda fuera del respaldo nocturno. Esa sesión
equivale a la cuenta de WhatsApp del consultorio: quien la robe puede leer y
enviar mensajes como el consultorio.

## Decisión

1. La sesión se guarda en **`odonto_notifications`**, en la tabla
   `whatsapp_auth` (clave `session_id`, `categoria`, `clave`) y en
   `whatsapp_session` (estado legible y contadores del limitador).
2. Cada valor de `whatsapp_auth` se cifra con `STORAGE_ENCRYPTION_KEY` usando
   AES-256-GCM de `@odontocrm/storage`; se guarda como `enc:<base64>` y, solo en
   desarrollo sin clave, como `plain:<json>`. Las escrituras van en una
   transacción.
3. La sesión entra en el **respaldo nocturno** porque es una tabla más de la
   base de notificaciones. No se copian ficheros ni se añaden scripts.
4. La vinculación se hace desde **Configuración → Canales** (solo
   `settings:manage`): QR refrescado por polling o código de emparejamiento.
   También hay una CLI (`npm run whatsapp:vincular`) que pinta el QR en la
   terminal para instalaciones sin navegador.
5. Máquina de estados: `desactivado`, `sin_vincular`, `esperando_qr`,
   `conectando`, `conectado`, `reconectando`, `sesion_cerrada` y `reemplazada`.
   Reglas: `loggedOut`/`badSession` borran la sesión y avisan; `440` no
   reconecta sola; `515`/caídas reconectan con backoff; una caída mayor que
   `WHATSAPP_ALERT_AFTER_MINUTES` avisa al bot de administración.
6. `notifications` sigue siendo **instancia única** (PM2 `fork`). Nunca se usa
   el mismo número en desarrollo y producción: la segunda instancia recibe
   `connectionReplaced` y no pelea por la sesión.
7. Vincular y cerrar quedan **auditados** (`whatsapp_session_paired`,
   `whatsapp_session_logged_out`, `whatsapp_session_lost`).
8. Al restaurar un respaldo antiguo, si la sesión no conecta porque las claves
   Signal quedaron desfasadas, el runbook manda «Cerrar sesión» y volver a
   vincular; el respaldo de la base conserva todo lo demás.

## Consecuencias

- La sesión se protege como un secreto: cifrada, sin rutas públicas y con
  auditoría. Si se filtra, se cierra desde el teléfono (Dispositivos
  vinculados) y se vuelve a vincular.
- Rotar `STORAGE_ENCRYPTION_KEY` exige re-cifrar la sesión o volver a vincular;
  no se hace en caliente.
- El QR concede el control de la cuenta: por eso las rutas exigen
  `settings:manage` y el gateway no las expone sin JWT.
- El respaldo y la restauración no necesitan cambios: `odontocrm restaurar
  --all` y `odontocrm recuperar` reponen la clave también en
  `notifications.env`.
