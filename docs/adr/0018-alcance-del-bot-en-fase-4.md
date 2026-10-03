# ADR 0018 — Alcance del bot en la Fase 4

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El bot de Telegram es el canal de entrada de solicitudes. Se podría intentar cubrir todo el
ciclo (solicitar, consultar, confirmar asistencia, cancelar, reprogramar) de una sola vez, pero
eso alarga la fase y multiplica los estados posibles de una conversación no supervisada.

## Decisión

En la Fase 4 el bot hace **exactamente tres cosas**:

1. **Solicitar una cita** con un asistente de siete pasos, validando y normalizando cada dato
   (nombre, cédula, teléfono, fecha de nacimiento, sexo, motivo y confirmación).
2. **Entregar el ticket** (`#000123`) con el estado `EN_ESPERA_CITA` y la expectativa de
   contacto.
3. **Consultar el estado** de una solicitud por su ticket (`/estado`, `/mi_ticket`), además de
   `/cancelar` para abortar el asistente a medias.

El **RSVP** («voy a asistir / no puedo») y la **reprogramación** por el bot quedan para una fase
posterior, cuando los estados y las notificaciones estén asentados.

## Consecuencias

- ✅ Fase 4 acotada y verificable de punta a punta.
- ✅ Idempotencia por `update_id` y anti-flood obligatorios desde el primer día.
- ⚠️ Las inasistencias seguirán dependiendo del recordatorio y de la llamada telefónica hasta
  que se implemente el RSVP.
