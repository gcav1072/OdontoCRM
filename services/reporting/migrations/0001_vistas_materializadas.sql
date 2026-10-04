-- Vistas materializadas del read model de reportes (Fase 9, [ADR 0019]).
--
-- Se escriben **a mano** (no las genera drizzle-kit) porque el esquema Drizzle del
-- servicio declara tablas, no vistas: `npm run db:generate:reporting` no las ve y
-- nunca intentará crearlas como tablas. Como no cambian el esquema, el snapshot
-- `meta/0001_snapshot.json` es una copia del 0000 (con su `id`/`prevId` nuevos).
--
-- Cada vista lleva:
--   · un **índice único** sobre su grano, que es lo que habilita
--     `REFRESH MATERIALIZED VIEW CONCURRENTLY` el día que el tablero no pueda
--     permitirse el bloqueo de un refresco normal (hoy no hace falta: las tablas
--     del read model son pequeñas y el refresco corre de madrugada o tras un lote);
--   · un **índice por la columna que filtran los reportes** (el día, casi siempre).
--
-- Todas tienen una columna `day`: sin ella, una vista pre-agregada no podría
-- contestar a un reporte con rango de fechas, que es el caso normal.

-- KPIs del día: alimenta el tablero (`GET /api/v1/reports/summary`). El cupo es el
-- explícito (`dim_day_capacity`); queda NULL cuando nadie lo fijó a mano, porque la
-- agenda lo deduce de las plantillas de franjas y ese dato no viaja en ningún evento.
CREATE MATERIALIZED VIEW "mv_daily_kpis" AS
WITH "dias" AS (
  SELECT "date" AS "day" FROM "dim_day_capacity"
  UNION
  SELECT "appointment_date" FROM "fact_appointment"
  UNION
  SELECT "requested_at"::date FROM "fact_request"
  UNION
  SELECT "opened_at"::date FROM "fact_clinical_session" WHERE "opened_at" IS NOT NULL
  UNION
  SELECT "issued_at"::date FROM "fact_prescription" WHERE "issued_at" IS NOT NULL
)
SELECT
  d."day",
  c."capacity",
  COALESCE(a."assigned", 0) AS "assigned",
  COALESCE(a."scheduled", 0) AS "scheduled",
  COALESCE(a."notified", 0) AS "notified",
  COALESCE(a."attended", 0) AS "attended",
  COALESCE(a."no_show", 0) AS "no_show",
  COALESCE(a."cancelled", 0) AS "cancelled",
  COALESCE(r."requests", 0) AS "requests",
  COALESCE(s."sessions", 0) AS "sessions",
  COALESCE(p."prescriptions", 0) AS "prescriptions",
  COALESCE(c."notifications_sent", 0) AS "notifications_sent",
  COALESCE(c."notifications_failed", 0) AS "notifications_failed"
FROM "dias" d
LEFT JOIN "dim_day_capacity" c ON c."date" = d."day"
LEFT JOIN (
  SELECT
    "appointment_date",
    count(*)::int AS "scheduled",
    (count(*) FILTER (
      WHERE "status" IN (
        'programada', 'notificada', 'en_sala_espera', 'llamado',
        'en_consulta', 'atendido', 'no_asistio'
      )
    ))::int AS "assigned",
    (count(*) FILTER (WHERE "notified_at" IS NOT NULL))::int AS "notified",
    (count(*) FILTER (WHERE "status" = 'atendido'))::int AS "attended",
    (count(*) FILTER (WHERE "status" = 'no_asistio'))::int AS "no_show",
    (count(*) FILTER (WHERE "status" IN ('cancelada', 'reprogramada')))::int AS "cancelled"
  FROM "fact_appointment"
  GROUP BY "appointment_date"
) a ON a."appointment_date" = d."day"
LEFT JOIN (
  SELECT "requested_at"::date AS "day", count(*)::int AS "requests"
  FROM "fact_request"
  GROUP BY 1
) r ON r."day" = d."day"
LEFT JOIN (
  SELECT "opened_at"::date AS "day", count(*)::int AS "sessions"
  FROM "fact_clinical_session"
  WHERE "opened_at" IS NOT NULL
  GROUP BY 1
) s ON s."day" = d."day"
LEFT JOIN (
  SELECT "issued_at"::date AS "day", count(*)::int AS "prescriptions"
  FROM "fact_prescription"
  WHERE "issued_at" IS NOT NULL AND "status" <> 'anulada'
  GROUP BY 1
) p ON p."day" = d."day";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_daily_kpis_day" ON "mv_daily_kpis" ("day");
--> statement-breakpoint
-- Embudo por día. Las **solicitudes** se cuentan por su fecha de solicitud y las
-- citas por la fecha de la cita: así cada etapa cae en el período que le toca y el
-- embudo de una semana se puede leer de arriba abajo.
CREATE MATERIALIZED VIEW "mv_funnel" AS
WITH "dias" AS (
  SELECT "appointment_date" AS "day" FROM "fact_appointment"
  UNION
  SELECT "requested_at"::date FROM "fact_request"
)
SELECT
  d."day",
  COALESCE(r."requests", 0) AS "requests",
  COALESCE(a."scheduled", 0) AS "scheduled",
  COALESCE(a."notified", 0) AS "notified",
  COALESCE(a."attended", 0) AS "attended",
  COALESCE(a."no_show", 0) AS "no_show",
  COALESCE(a."cancelled", 0) AS "cancelled"
FROM "dias" d
LEFT JOIN (
  SELECT
    "appointment_date",
    count(*)::int AS "scheduled",
    (count(*) FILTER (WHERE "notified_at" IS NOT NULL))::int AS "notified",
    (count(*) FILTER (WHERE "status" = 'atendido'))::int AS "attended",
    (count(*) FILTER (WHERE "status" = 'no_asistio'))::int AS "no_show",
    (count(*) FILTER (WHERE "status" IN ('cancelada', 'reprogramada')))::int AS "cancelled"
  FROM "fact_appointment"
  GROUP BY "appointment_date"
) a ON a."appointment_date" = d."day"
LEFT JOIN (
  SELECT "requested_at"::date AS "day", count(*)::int AS "requests"
  FROM "fact_request"
  GROUP BY 1
) r ON r."day" = d."day";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_funnel_day" ON "mv_funnel" ("day");
--> statement-breakpoint
-- Pirámide demográfica. El tramo de edad se calcula con la fecha del refresco (la
-- vista se rehace cada noche, así que «hoy» es el día en que se consulta) y los
-- pacientes sin fecha de nacimiento caen en `sin-fecha`, que el reporte cuenta aparte
-- en vez de inventarles una edad.
CREATE MATERIALIZED VIEW "mv_demographics" AS
SELECT
  p."created_at"::date AS "day",
  CASE
    WHEN p."birth_date" IS NULL THEN 'sin-fecha'
    WHEN EXTRACT(YEAR FROM age(CURRENT_DATE, p."birth_date")) <= 12 THEN '0-12'
    WHEN EXTRACT(YEAR FROM age(CURRENT_DATE, p."birth_date")) <= 17 THEN '13-17'
    WHEN EXTRACT(YEAR FROM age(CURRENT_DATE, p."birth_date")) <= 40 THEN '18-40'
    WHEN EXTRACT(YEAR FROM age(CURRENT_DATE, p."birth_date")) <= 65 THEN '41-65'
    ELSE '66+'
  END AS "bucket",
  COALESCE(p."sex", 'O') AS "sex",
  p."status",
  count(*)::int AS "patients"
FROM "dim_patient" p
WHERE p."deleted_at" IS NULL
GROUP BY 1, 2, 3, 4;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_demographics" ON "mv_demographics" ("day", "bucket", "sex", "status");
--> statement-breakpoint
CREATE INDEX "idx_mv_demographics_bucket" ON "mv_demographics" ("bucket", "sex", "status");
--> statement-breakpoint
-- Salud bucal: solo las tres condiciones que mide el reporte (caries, obturación y
-- pieza ausente) y solo los hallazgos **vigentes** (`resolved_at` nulo): una pieza ya
-- obturada no es una caries activa.
CREATE MATERIALIZED VIEW "mv_oral_health" AS
SELECT
  f."recorded_at"::date AS "day",
  f."tooth_number",
  f."condition",
  count(*)::int AS "findings",
  count(DISTINCT f."patient_id")::int AS "patients"
FROM "fact_tooth_finding" f
WHERE f."resolved_at" IS NULL
  AND f."condition" IN ('caries', 'restauracion', 'ausente')
GROUP BY 1, 2, 3;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_oral_health" ON "mv_oral_health" ("day", "tooth_number", "condition");
--> statement-breakpoint
CREATE INDEX "idx_mv_oral_health_tooth" ON "mv_oral_health" ("tooth_number", "condition");
--> statement-breakpoint
-- Medicamentos recetados. Los récipes **anulados no cuentan**: un récipe anulado es
-- uno que no se entregó al paciente.
CREATE MATERIALIZED VIEW "mv_prescriptions" AS
SELECT
  i."issued_at"::date AS "day",
  i."medication_name",
  count(DISTINCT i."prescription_id")::int AS "prescriptions",
  count(*)::int AS "items",
  count(DISTINCT i."patient_id")::int AS "patients",
  min(i."issued_at") AS "first_issued_at",
  max(i."issued_at") AS "last_issued_at"
FROM "fact_prescription_item" i
JOIN "fact_prescription" r ON r."prescription_id" = i."prescription_id"
WHERE r."status" <> 'anulada'
GROUP BY 1, 2;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_prescriptions" ON "mv_prescriptions" ("day", "medication_name");
--> statement-breakpoint
CREATE INDEX "idx_mv_prescriptions_med" ON "mv_prescriptions" ("medication_name");
