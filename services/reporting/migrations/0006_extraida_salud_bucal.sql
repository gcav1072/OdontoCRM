-- La exodoncia realizada (`extraida`) entra en el reporte de salud bucal: es una
-- pieza perdida por cirugía, distinta de la ausencia congénita (`ausente`). La vista
-- se recrea para incluirla entre las condiciones medidas. Se recalcula al próximo
-- refresco (el consumidor refresca tras cada lote de eventos).
DROP MATERIALIZED VIEW IF EXISTS "mv_oral_health";
--> statement-breakpoint
CREATE MATERIALIZED VIEW "mv_oral_health" AS
SELECT
  f."recorded_at"::date AS "day",
  f."tooth_number",
  f."condition",
  count(*)::int AS "findings",
  count(DISTINCT f."patient_id")::int AS "patients"
FROM "fact_tooth_finding" f
WHERE f."resolved_at" IS NULL
  AND f."condition" IN ('caries', 'restauracion', 'ausente', 'extraida')
GROUP BY 1, 2, 3;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_oral_health" ON "mv_oral_health" ("day", "tooth_number", "condition");
--> statement-breakpoint
CREATE INDEX "idx_mv_oral_health_tooth" ON "mv_oral_health" ("tooth_number", "condition");
