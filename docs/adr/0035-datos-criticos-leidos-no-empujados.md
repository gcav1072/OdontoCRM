# ADR 0035 — Los datos críticos del consultorio se leen, no se empujan

- **Fecha:** 2026-10-04 · **Estado:** aceptada · **Implementada:** fase 7, sesión A (2026-10-04)

## Contexto

La pantalla del consultorio tiene que mostrar, del paciente que está dentro, sus
**alergias, crónicos y anticoagulantes** con semáforo de riesgo. Desde la Fase 5 el
servicio de pantallas ya tiene la proyección (`room_state.critical_flags`), la ruta
interna para llenarla (`POST /internal/v1/screens/room/critical-flags`) y el
componente que la pinta… pero **nadie la alimentaba**: la pantalla mostraba «aún no
hay datos» y la promesa de la Fase 5 quedaba sin cumplir.

El envío se había diseñado como un **empujón** desde la historia clínica («los manda
la historia clínica al abrir la sesión», Fase 6). Ese camino tiene dos agujeros:

1. **El dato puede no existir todavía.** En una primera visita la anamnesis se escribe
   *durante* la consulta: si el aviso se manda al abrir la sesión, la alergia que se
   acaba de teclear no aparece hasta la próxima vez.
2. **La sala puede no tener la fila.** El empujón se aplica por `appointmentId` sobre
   `room_state`; si el paciente todavía no pasó a consulta (o el evento llegó antes que
   el de `in_consultation`), el aviso se pierde en silencio.

## Decisión

**El servicio de pantallas lee las alertas cuando construye el estado del consultorio**,
igual que ya lee la ficha del paciente para calcular la edad y el sexo
(`createPatientLookup`): `createAlertLookup` llama a
`GET /internal/v1/clinical/patients/:patientId/alerts` por la red interna y el mapeo
alerta → semáforo vive en el contrato (`criticalFlagsFromAlerts`, con su etiqueta, su
severidad y su tipo).

- Si el servicio clínico responde, **manda lo leído** (el dato está fresco por
  definición).
- Si no responde (o no hay secreto interno configurado), se usa **lo empujado** en
  `room_state.critical_flags`: la ruta interna de la Fase 5 sigue viva como respaldo y
  la pantalla nunca se queda sin pintar.
- `null` y `[]` significan cosas distintas: «no pude preguntar» frente a «no tiene
  alergias».

## Consecuencias

- **A favor:** el semáforo refleja la historia en el momento de mirarlo —una alergia
  recién escrita aparece sin esperar a nadie—, no hay carrera entre la proyección de la
  sala y los datos clínicos, y no hace falta que la historia clínica sepa nada del
  servicio de pantallas.
- **En contra / a vigilar:** cada refresco del estado del consultorio (trama SSE,
  cambio de sala y respaldo cada 20 s) hace **una lectura interna más**. Es una llamada
  a loopback con tiempo límite de 5 s y degradación limpia, y el estado ya hacía otra
  para la ficha del paciente; si algún día molesta, el sitio natural del caché es
  `screens`, no la historia clínica.
- La prueba de integración de pantallas inyecta el `alertLookup` (para no depender de
  que el servicio clínico esté levantado) y comprueba las dos ramas: lo leído manda y
  el respaldo funciona.
