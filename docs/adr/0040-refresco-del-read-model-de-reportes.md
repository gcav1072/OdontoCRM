# ADR 0040 — El read model de reportes se refresca al cerrar el lote y de noche

- **Fecha:** 2026-10-04 · **Estado:** aceptada (fase 9)

## Contexto

La [ADR 0019](0019-reportes-y-kpis.md) dejó cerrado **qué** reportes entrega la
Fase 9 y que salen de un read model propio (`odonto_reporting`) alimentado por
eventos, nunca de las bases operativas. Faltaba decidir **cuándo** se materializan
las cifras.

Un reporte puede leerse de tres maneras:

1. **Consultando el read model en el momento** (tablas `dim_*`/`fact_*` con sus
   índices). Siempre fresco, pero cada visita de la pantalla vuelve a agregar.
2. **Vistas materializadas** refrescadas por un trabajo nocturno. Rapidísimo, pero
   a las 10 de la mañana el embudo del día de hoy sale vacío — que es exactamente
   cuando interesa.
3. **Vistas materializadas refrescadas al cerrar cada lote de eventos** (más el
   nocturno como red de seguridad).

## Decisión

La **tercera**, con estos límites:

- El consumidor de eventos aplica el lote (`dim_*`/`fact_*`) y, **si el lote cambió
  algo**, refresca las cinco vistas materializadas (`mv_daily_kpis`, `mv_funnel`,
  `mv_oral_health`, `mv_demographics`, `mv_prescriptions`) y anota la corrida en
  `report_refreshes` (`trigger: 'evento'`).
- Hay además un **refresco nocturno** (hora `REPORTING_REFRESH_HOUR`, por defecto
  03:00) que rehace las cinco vistas y deja su registro (`trigger: 'nocturno'`):
  es la red que corrige cualquier deriva sin esperar a que llegue un evento.
- `POST /internal/v1/reporting/refresh` (red interna, `x-internal-token`) permite
  forzarlo a mano cuando haga falta (`trigger: 'manual'`).
- Las vistas se crean en una **migración versionada** con índices únicos, para que
  el día que el volumen lo pida se pueda pasar a `REFRESH ... CONCURRENTLY` sin
  cambiar el esquema.

## Consecuencias

- ✅ La pantalla muestra el día en curso: un alta, una cita o una receta recién
  hechas aparecen al abrir el reporte (el retardo es el del lote, segundos).
- ✅ Quien lee un reporte no espera a una agregación: lee una vista materializada.
- ⚠️ `REFRESH MATERIALIZED VIEW` toma un bloqueo exclusivo breve sobre esa vista.
  A la escala del consultorio (decenas de eventos al día, miles de filas) es de
  milisegundos; el día que deje de serlo, el camino está escrito arriba
  (`CONCURRENTLY`, índices únicos ya presentes).
- ⚠️ El read model **no se reconstruye desde cero** en esta fase: se puede rehacer
  reproduciendo los eventos (cada consumidor es idempotente por `eventId`), y el
  plan deja la prueba formal —con el seed determinista completo, que incluye
  historias, sesiones, odontogramas y récipes— para la **Fase 10** (§12 y ADR 0019).
  Lo que sí existe desde ya es `GET /internal/v1/reporting/status`, que dice
  cuántas filas tiene cada tabla y cuándo se refrescó por última vez.
