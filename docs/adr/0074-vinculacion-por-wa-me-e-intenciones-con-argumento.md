# 0074 — Vinculación por `wa.me` e intenciones con argumento en canales sin comandos

- **Fecha:** 2026-10-29 · **Estado:** propuesta (implementación en curso)

## Contexto

En Telegram la vinculación usa un deep link `t.me/<bot>?start=<código>`, y el
asistente entiende `/start <código>` porque Telegram tiene comandos con barra.
WhatsApp no tiene comandos: su enlace equivalente es
`https://wa.me/<número>?text=...`. Además, el paciente puede escribir
`estado #000123` o `cancelar #000123` sin barra, y hasta ahora `detectIntent`
solo reconocía la frase completa, no «frase + argumento».

## Decisión

1. `POST /api/v1/notifications/channels/link-code` devuelve, además del enlace
   de Telegram, un **`whatsappLink`** (`https://wa.me/<número>?text=VINCULAR%20<código>`)
   y su QR cuando la sesión de Baileys está `conectado` y se conoce el número.
2. `detectIntent` acepta, en canales sin comandos, **frase de intención +
   argumento** para las intenciones que lo admiten (`start`, `estado`,
   `cancelar`). La frase `vincular` se añade a `start`. La coincidencia exacta
   tiene prioridad, para no partir «cancelar mi cita».
3. `DELETE /api/v1/notifications/channels/:patientId` acepta
   `?channel=telegram|whatsapp`: un paciente con dos canales puede desvincular
   uno sin bloquear el otro.
4. La tarjeta de vinculación muestra los dos QR (Telegram y WhatsApp) y la
   tabla usa una clave por `(patientId, channel)`, porque un paciente puede
   tener los dos.

## Consecuencias

- El paciente que llega por WhatsApp se vincula con el mismo mecanismo de
  código que el de Telegram; no hay una segunda tabla ni un segundo flujo.
- El enlace `wa.me` no necesita webhook ni túnel: lo abre el paciente en su
  propio WhatsApp y el mensaje entra por el socket.
- La vinculación en frío sigue prohibida (ADR 0072): el enlace solo lo usa el
  paciente que ya está hablando con el consultorio.
