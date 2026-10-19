CREATE TABLE "periodontogram_exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"exam_date" date NOT NULL,
	"teeth_data" jsonb NOT NULL,
	"risk_factors" jsonb NOT NULL,
	"diagnosis" jsonb,
	"metrics" jsonb NOT NULL,
	"notes" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"session_id" uuid,
	"recorded_by" uuid,
	"recorded_by_username" text,
	"finalized_by" uuid,
	"finalized_by_username" text,
	"finalized_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_periodontogram_exams_status" CHECK ("periodontogram_exams"."status" in ('borrador', 'finalizado')),
	CONSTRAINT "chk_periodontogram_exams_revision" CHECK ("periodontogram_exams"."revision" >= 0),
	CONSTRAINT "chk_periodontogram_exams_teeth_count" CHECK (jsonb_array_length("periodontogram_exams"."teeth_data") = 32),
	CONSTRAINT "chk_periodontogram_exams_finalized" CHECK (("periodontogram_exams"."status" = 'finalizado') = ("periodontogram_exams"."finalized_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "idx_periodontogram_exams_patient_created" ON "periodontogram_exams" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_periodontogram_exams_patient_status" ON "periodontogram_exams" USING btree ("patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_periodontogram_exam_draft" ON "periodontogram_exams" USING btree ("patient_id") WHERE "periodontogram_exams"."status" = 'borrador';