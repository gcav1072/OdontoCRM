# ADR 0010 — Notificación en lote con vista previa y reenvío individual

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Confirmar una cita por Telegram es un mensaje con fecha, hora, dirección y archivo `.ics`. Si
se enviara automáticamente al asignar, un error de hora llegaría al paciente sin posibilidad de
revisión previa; y si se enviara solo uno por uno, programar veinte citas sería tedioso.

## Decisión

Asignar deja la cita en estado **`programada` / pendiente de notificar**. La secretaria pulsa
**«Notificar»**, ve **exactamente** los mensajes que se enviarán (texto y `.ics`), confirma, y
el sistema los envía en lote con una cola de reintentos. Siempre se puede **reenviar uno
individual**.

Cada envío registra estado (`queued`, `sent`, `failed`, `skipped_no_channel`), intentos, error y
marca de tiempo; la interfaz muestra la bandeja con los fallos y permite reintentar.

## Consecuencias

- ✅ Ninguna confirmación sale sin revisión humana; los errores se detectan antes del envío.
- ✅ Reprogramar incrementa `SEQUENCE` del `.ics`, así que el calendario del paciente se
  actualiza en lugar de duplicar el evento.
- ⚠️ Requiere una vista previa fiel al mensaje final (se prueba con la misma plantilla en la
  Fase 4).
