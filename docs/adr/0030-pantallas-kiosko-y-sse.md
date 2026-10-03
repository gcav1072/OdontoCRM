# ADR 0030 — Pantallas kiosko con token de dispositivo y SSE

- **Fecha:** 2026-10-03 · **Estado:** aceptada (decisión del usuario) · **Implementada:** fase 5 (2026-10-03)

## Contexto

La Fase 5 tiene que poner dos pantallas en la clínica: el **displaylobby** de la sala de
espera (turno, nombre abreviado, sillón y voz en español) y la **pantalla del
consultorio** (paciente en curso, motivo y datos críticos). Son televisores o monitores
encendidos todo el día, sin teclado ni ratón y sin una persona delante: nadie va a
escribir un usuario y una contraseña en ellos, y el personal no puede estar recargando
la página cada vez que se llama a un paciente.

Además, cada pantalla tiene que **saber cosas que pasan en otro servicio**: la
secretaría llama desde `scheduling` y quien pinta el llamado es `screens`.

## Decisión

**1. La pantalla se identifica con un token de dispositivo, que canjea por un JWT.**

- El administrador registra la pantalla en `/pantallas`: `identity` genera un token
  opaco (se muestra **una sola vez**, en la base queda su hash) y `screens` guarda sus
  ajustes.
- El enlace de configuración (`/pantalla/lobby?token=…`) se abre una vez en el equipo:
  la pantalla guarda el token, lo **borra de la barra de direcciones** y lo canjea en
  `POST /api/v1/auth/device` por un JWT de **15 minutos** con el rol `pantalla` y el
  único permiso `screens:display`.
- El JWT se renueva solo antes de caducar. El token de dispositivo nunca viaja en cada
  petición y el JWT no abre ningún otro módulo (el gateway y los permisos lo impiden).
- `screens` comprueba además que la pantalla siga **registrada y activa**: desactivarla
  en `/pantallas` corta el acceso aunque su token siga siendo válido.

**2. El estado se empuja por SSE, con el estado completo en cada trama.**

- `GET /api/v1/screens/{lobby,consultorio}/stream` responde `text/event-stream`, manda
  el estado inicial al conectar y luego **una trama por cambio** con el estado completo.
  El cliente solo reemplaza lo que pinta: una reconexión no necesita reproducir eventos.
- Se usa SSE y no WebSocket porque el flujo es unidireccional, se reconecta solo y
  atraviesa el gateway sin configuración extra.
- El cliente lo abre con `fetch` (no con `EventSource`) porque `EventSource` no permite
  mandar la cabecera `Authorization`; a cambio, la reconexión (espera creciente),
  el `Last-Event-ID` y el refresco de respaldo por HTTP se manejan en el cliente.
- Latido cada 20 s para que un proxy no cierre la conexión inactiva.

**3. La sala es una proyección por eventos, y el orden importa.**

- `screens` consume `scheduling.appointment.{checked_in,called,in_consultation,attended,no_show,cancelled,rescheduled}`
  y mantiene `room_state` (quién espera, a quién se llamó, quién está dentro) y
  `call_events` (histórico de llamados, idempotente por `event_id`).
- **El lote se aplica ordenado por `occurredAt`**: `pg-boss` no garantiza el orden de
  los trabajos de un lote, y aplicar `called` antes que `checked_in` dejaba al paciente
  «esperando» en lugar de «llamado» (y `attended` antes que `in_consultation` volvía a
  ocupar el consultorio).
- **La proyección no retrocede**: un evento con hora anterior al estado actual no
  cambia el estado, y quien salió de la sala deja una **lápida** (`left_at`) para que un
  evento tardío no lo resucite.

## Consecuencias

- ✅ Añadir una pantalla es registrar y abrir un enlace: no hay que instalar nada ni
  dejar sesión abierta en el equipo.
- ✅ El televisor no pregunta: el llamado llega empujado. Medido en la prueba de humo:
  **882 ms** desde que la secretaría pulsa «Llamar» hasta que la trama llega al lobby.
- ✅ La sala se puede reconstruir: `room_state` y `call_events` son datos propios del
  servicio, no una copia de la agenda.
- ⚠️ La latencia depende de dos relojes: el publicador del outbox de agenda (500 ms) y
  el sondeo del consumidor de `screens` (500 ms). Bajarlos más carga la base de datos
  sin ganar nada perceptible.
- ⚠️ Sin la historia clínica (Fase 6) los **datos críticos** llegan por la ruta interna
  `/internal/v1/screens/room/critical-flags`; hasta entonces la pantalla del consultorio
  avisa de que aún no hay datos clínicos.
- ⚠️ La edad y el sexo del paciente se piden a `patients` al registrar la llegada
  (lectura interna, best-effort): si el servicio no responde, la cita entra igual.
