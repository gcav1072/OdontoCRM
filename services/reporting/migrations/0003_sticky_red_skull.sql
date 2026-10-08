ALTER TABLE "fact_appointment" ADD COLUMN "confirmed_at" timestamp with time zone;
--> statement-breakpoint
-- Escrito a mano: las **vistas materializadas** no las ve drizzle-kit (viven en
-- `src/db/views.ts`, fuera del `schema` del generador; ver la cabecera de 0001), así
-- que el cambio de su definición va aquí. Hacen falta dos cosas (ADR 0052):
--   · `mv_daily_kpis` gana la cifra `confirmed`, que es la que pinta el tablero;
--   · las dos aprenden que `confirmada` **ocupa** la franja del día, que es lo que
--     impedía que una cita confirmada contase en el cupo.
-- Se rehacen enteras (`DROP` + `CREATE`) porque una vista materializada no admite
-- `ALTER`; el índice único se recrea con ella.
DROP MATERIALIZED VIEW IF EXISTS "mv_daily_kpis";--> statement-breakpoint
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
  COALESCE(a."confirmed", 0) AS "confirmed",
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
        'programada', 'notificada', 'confirmada', 'en_sala_espera', 'llamado',
        'en_consulta', 'atendido', 'no_asistio'
      )
    ))::int AS "assigned",
    (count(*) FILTER (WHERE "notified_at" IS NOT NULL))::int AS "notified",
    (count(*) FILTER (WHERE "confirmed_at" IS NOT NULL))::int AS "confirmed",
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
) p ON p."day" = d."day";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_daily_kpis_day" ON "mv_daily_kpis" ("day");--> statement-breakpoint
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
  COALESCE(a."cancelled", 0) AS "cancelled"
FROM "dias" d
LEFT JOIN (
  SELECT
    "appointment_date",
    count(*)::int AS "scheduled",
    (count(*) FILTER (WHERE "notified_at" IS NOT NULL))::int AS "notified",
    (count(*) FILTER (WHERE "confirmed_at" IS NOT NULL))::int AS "confirmed",
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
) r ON r."day" = d."day";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mv_funnel_day" ON "mv_funnel" ("day");