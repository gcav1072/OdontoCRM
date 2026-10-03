# ADR 0025 — Horas en 12 h en la interfaz, 24 h en datos y `.ics`

- **Fecha:** 2026-10-02 · **Estado:** aceptada (ajuste pedido por el interesado)

## Contexto

El plan inicial proponía mostrar las horas en formato de 24 h. El interesado pidió expresamente
**formato de 12 h** porque es como el personal del consultorio y los pacientes hablan de las
citas («a las 9 y media de la mañana»). Al mismo tiempo, la base de datos, los logs y el
estándar de calendario imponen otro formato.

## Decisión

- **Interfaz y mensajes de Telegram:** formato de 12 h con `a. m.` / `p. m.`
  (por ejemplo `9:30 a. m.`), hora de Venezuela (UTC-4).
- **Base de datos:** `time` en 24 h y `timestamptz` con zona horaria; nunca se guarda texto
  formateado.
- **`.ics`:** 24 h según RFC 5545, con `TZID=America/Caracas` y valarm de recordatorio.
- La conversión ocurre **solo al mostrar**: una única función de formato en la interfaz
  (Fase 1) evita duplicar la lógica en cada módulo.
- Las fechas se muestran como `dd/mm/aaaa`.

## Consecuencias

- ✅ El personal lee las horas como las dice en voz alta; los sistemas de calendario las
  entienden sin ambigüedad.
- ✅ Un solo lugar donde equivocarse al formatear (y con pruebas).
- ⚠️ Hay que ser estricto con la zona horaria: el servidor podría estar en UTC, así que toda
  conversión usa `America/Caracas` explícitamente (variable `TZ` en el `.env`).
