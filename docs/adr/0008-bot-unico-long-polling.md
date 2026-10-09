# ADR 0008 — Un solo bot de Telegram con long polling, deep link y plan B manual

- **Fecha:** 2026-10-02 · **Estado:** aceptada (aclaración del usuario el mismo día)

## Contexto

El canal inicial de solicitudes de cita es un bot de Telegram. Telegram ofrece dos formas de
recibir mensajes: **webhook** (exige HTTPS público) o **long polling** (solo salida). El
sistema vivirá en una red local sin exposición a internet, y las pantallas de los pacientes
pueden no tener Telegram. Además, un bot solo puede escribirle a quien le haya escrito antes.

## Decisión

- **Un único bot, creado una vez en BotFather**, con nombre visible «Consultorio odontológico»
  (genérico: cada clínica le pone el suyo). El `@usuario` y el nombre visible se pueden cambiar
  después; cambiar el `@usuario`
  rompe enlaces ya compartidos, y en ese caso se crea otro bot y se reemplaza el token.
- **Long polling** con un solo poller (dos `getUpdates` simultáneos dan `409 Conflict`). Si
  hiciera falta escalar, se replican *workers* de envío, no el poller; migrar el mismo bot a
  webhook sigue siendo posible.
- **Vinculación por deep link** `t.me/<usuario>?start=<código>` (con QR desde recepción) para
  los pacientes registrados en el mostrador.
- Si el paciente **no tiene Telegram**, la cita queda en estado **«notificación manual
  pendiente»** con el guion de llamada telefónica.

## Consecuencias

- ✅ Funciona 100 % en red local, sin exponer nada a internet.
- ✅ Un solo token que custodiar y rotar (ver [ADR 0024](0024-secretos-fuera-del-repositorio.md)).
- ⚠️ La notificación no es instantánea (depende del ciclo de polling), aceptable aquí.
- ⚠️ El estado de conversación se guarda en la base (`bot_conversations`) para que el paciente
  pueda retomar el asistente.
