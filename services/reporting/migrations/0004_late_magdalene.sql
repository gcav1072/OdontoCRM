ALTER TABLE "fact_appointment" ADD COLUMN "cancelled_channel" text;--> statement-breakpoint
-- Escrito a mano: las **vistas materializadas** no las ve drizzle-kit (viven en
-- `src/db/views.ts`, fuera del `schema` del generador; ver la cabecera de 0001), así que
-- el cambio de su definición va aquí. El embudo gana la cifra `cancelled_by_patient`, que
-- cuenta **solo** las cancelaciones hechas por el paciente desde el bot (canal de
-- paciente); las que anula la secretaría ya son conocimiento del consultorio (ADR 0053).
-- Se rehace entera (`DROP` + `CREATE`) porque una vista materializada no admite `ALTER`;
-- el índice único se recrea con ella.
DROP MATERIALIZED VIEW IF EXISTS "mv_funnel";--> statement-breakpoint
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
  COALESCE(a."confirmed", 0) AS "confirmed",
  COALESCE(a."attended", 0) AS "attended",
  COALESCE(a."no_show", 0) AS "no_show",
  COALESCE(a."cancelled", 0) AS "cancelled",
  COALESCE(a."cancelled_by_patient", 0) AS "cancelled_by_patient"
FROM "dias" d
LEFT JOIN (
  SELECT
    "appointment_date",
    count(*)::int AS "scheduled",
    (count(*) FILTER (WHERE "notified_at" IS NOT NULL))::int AS "notified",
    (count(*) FILTER (WHERE "confirmed_at" IS NOT NULL))::int AS "confirmed",
    (count(*) FILTER (WHERE "status" = 'atendido'))::int AS "attended",
    (count(*) FILTER (WHERE "status" = 'no_asistio'))::int AS "no_show",
    (count(*) FILTER (WHERE "status" IN ('cancelada', 'reprogramada')))::int AS "cancelled",
    (count(*) FILTER (WHERE "cancelled_channel" IN ('telegram', 'whatsapp')))::int AS "cancelled_by_patient"
  FROM "fact_appointment"
  GROUP BY "appointment_date"
) a ON a."appointment_date" = d."day"
LEFT JOIN (
  SELECT "requested_at"::date AS "day", count(*)::int AS "requests"
  FROM "fact_request"
  GROUP BY 1
) r ON r."day" = d."day";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_funnel_day" ON "mv_funnel" ("day");
