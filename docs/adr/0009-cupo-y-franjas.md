# ADR 0009 — Cupo diario editable, plantillas de franjas y hora manual

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El módulo «Programación de citas/jornada» debe tomar los pacientes en espera y asignarles
fecha y hora. El interesado pidió un **límite de pacientes por día que sea editable después de
la primera consulta** («si pongo 5, que salgan 5, y que se pueda ampliar o disminuir») y que la
**hora sea un dato manual** porque depende de factores clínicos.

## Decisión

- **`day_capacities`**: cupo por fecha, editable en cualquier momento, incluso después de haber
  asignado citas. Bajarlo por debajo de lo ya asignado **avisa y no borra nada**.
- **`slot_templates`**: plantilla por día de la semana con hora de inicio, fin, duración y
  pausas (por defecto lunes a viernes, 08:00–12:00 y 13:00–17:00, citas de 30 minutos).
- La asignación acepta **una franja de la plantilla o una hora escrita a mano**.
- El cupo es un **límite estricto**; excederlo requiere autorización explícita de `admin` con
  motivo, y queda en auditoría (`scheduling.overbook.authorized`).

## Consecuencias

- ✅ La secretaria arma la jornada en segundos, pero conserva control total para excepciones.
- ✅ Cambiar el cupo el mismo día es una operación normal, no una migración.
- ⚠️ El sistema debe advertir en lugar de bloquear cuando el cupo baja: la regla es «avisar y
  no destruir datos».
