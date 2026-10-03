# ADR 0017 — «Atendido» con advertencia y motivo auditado

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

Marcar a un paciente como atendido es el cierre de la visita, y en teoría debería existir una
sesión clínica cerrada (o la historia firmada, si fue su primera vez). Si se bloqueara
estrictamente, un doctor que olvide cerrar la sesión dejaría la jornada trabada al final del
día; si se permitiera sin más, se perdería integridad clínica y trazabilidad.

## Decisión

Al intentar marcar **`ATENDIDO`** sin historia firmada ni sesión cerrada, el sistema:

1. **advierte** claramente qué falta;
2. exige escribir un **motivo**;
3. registra la transición en el historial y en **auditoría** con el usuario, la fecha y el
   motivo;
4. permite continuar.

Además, la advertencia aparece en el momento justo (en secretaría y en la página de flujo), y el
sistema sugiere cerrar la sesión pendiente como primera opción.

## Consecuencias

- ✅ La operación real nunca queda bloqueada, pero el caso anómalo es visible y auditable.
- ✅ Los reportes pueden medir cuántas atenciones se cerraron sin sesión (indicador de calidad
  del registro clínico).
- ⚠️ El personal debe entender que el motivo no es un trámite: alimenta la auditoría
  (módulo de la Fase 9).
