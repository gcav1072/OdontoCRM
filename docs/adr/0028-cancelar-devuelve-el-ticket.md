# ADR 0028 — Cancelar una cita devuelve el ticket a la cola

- **Fecha:** 2026-10-03 · **Estado:** aceptada

## Contexto

La máquina de estados (§5.1) permite cancelar tanto una **solicitud** que aún espera
(`en_espera_cita` → `cancelada`) como una **cita** ya programada (`programada`/`notificada` →
`cancelada`). Son dos cosas distintas y el sistema tenía que decidir qué pasa con el ticket en el
segundo caso: ¿se queda la solicitud como estaba (con una cita cancelada), se cancela también la
solicitud, o vuelve a la cola?

En el mostrador lo normal es que el paciente **siga queriendo su cita**: llama para decir que ese
día no puede, o se le canceló por una urgencia del consultorio. Si la solicitud quedara cancelada,
la secretaría tendría que crear un ticket nuevo y volver a preguntar los datos, y la cola perdería
la antigüedad de quien lleva semanas esperando.

## Decisión

- **Cancelar la solicitud** (desde la cola) la deja en `cancelada`: es una renuncia explícita del
  paciente.
- **Cancelar la cita** deja la cita en `cancelada` (libera su franja y su cupo) y devuelve la
  **solicitud a `en_espera_cita`**, con su ticket y su antigüedad originales, lista para
  reprogramarse.

En ambos casos queda el rastro en `status_history` (actor, hora y motivo) y el evento de dominio
correspondiente; la solicitud que vuelve a la cola registra la transición con el motivo
«la cita se canceló y el paciente vuelve a la cola».

## Consecuencias

- ✅ El caso más frecuente (mover la cita) no obliga a crear un ticket nuevo ni pierde la
  antigüedad del paciente.
- ✅ El cupo del día vuelve a estar disponible al instante: la cita cancelada deja de contar.
- ✅ Los reportes pueden distinguir «cita cancelada» de «solicitud cancelada» porque son acciones de
  auditoría distintas (`appointment_cancelled` y `request_cancelled`).
- ⚠️ Cancelar una cita **no** cancela la solicitud: si el paciente ya no quiere nada, hay que
  cancelar también la solicitud (dos acciones, dos motivos). Es a propósito: son dos hechos
  distintos y la auditoría los separa.
- ⚠️ La interfaz debe explicar esa diferencia al cancelar una cita («el paciente vuelve a la cola»)
  para que nadie se sorprenda al ver el ticket de nuevo en espera.
