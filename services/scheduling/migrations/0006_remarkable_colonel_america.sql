-- Multisillón: catálogo de consultorios (sillones) + backfill.
--
-- Escrito a mano sobre el DDL que generó drizzle-kit, porque el orden **falla con
-- datos**: pone `NOT NULL` antes de rellenar, añade la columna del cupo sin rellenar
-- y cambia la PK sin quitar la anterior. El `chair_id` pasa a ser obligatorio, así que
-- primero se crea el catálogo y se reasigna el histórico (sillón por defecto) y **solo
-- después** van los `NOT NULL`, las FKs y el índice único por consultorio.

CREATE TABLE "chairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"short_label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chairs_label" ON "chairs" USING btree ("label");
--> statement-breakpoint
-- Sillón por defecto (decisión 9 del plan): es al que se reasigna todo el histórico.
INSERT INTO "chairs" ("label", "sort_order") VALUES ('Consultorio 1', 0);
--> statement-breakpoint
-- Citas: rellenar el consultorio y solo entonces hacerlo obligatorio con su FK.
UPDATE "appointments" SET "chair_id" = (SELECT "id" FROM "chairs" ORDER BY "sort_order", "label" LIMIT 1) WHERE "chair_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "chair_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_chair_id_chairs_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."chairs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "uq_appointments_slot";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appointments_slot" ON "appointments" USING btree ("appointment_date","start_time","chair_id") WHERE "appointments"."status" in ('programada', 'notificada', 'confirmada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio');
--> statement-breakpoint
-- Cupo por consultorio: añadir la columna, rellenar, cambiar la PK y poner la FK.
ALTER TABLE "day_capacities" ADD COLUMN "chair_id" uuid;
--> statement-breakpoint
UPDATE "day_capacities" SET "chair_id" = (SELECT "id" FROM "chairs" ORDER BY "sort_order", "label" LIMIT 1) WHERE "chair_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "day_capacities" ALTER COLUMN "chair_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "day_capacities" DROP CONSTRAINT "day_capacities_pkey";
--> statement-breakpoint
ALTER TABLE "day_capacities" ADD CONSTRAINT "day_capacities_date_chair_id_pk" PRIMARY KEY("date","chair_id");
--> statement-breakpoint
ALTER TABLE "day_capacities" ADD CONSTRAINT "day_capacities_chair_id_chairs_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."chairs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Plantillas de franjas por consultorio (nullable = común a todos).
ALTER TABLE "slot_templates" ADD COLUMN "chair_id" uuid;
--> statement-breakpoint
ALTER TABLE "slot_templates" ADD CONSTRAINT "slot_templates_chair_id_chairs_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."chairs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "idx_slot_templates_weekday";
--> statement-breakpoint
CREATE INDEX "idx_slot_templates_weekday" ON "slot_templates" USING btree ("weekday","is_active","chair_id");