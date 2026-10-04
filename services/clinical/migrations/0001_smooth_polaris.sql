CREATE TABLE "clinical_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"session_number" integer NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"content" jsonb NOT NULL,
	"opened_by" uuid,
	"opened_by_username" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_by_username" text,
	"closure_note" text,
	"amended_from_id" uuid,
	"amendment_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_clinical_sessions_status" CHECK ("clinical_sessions"."status" in ('borrador', 'cerrada')),
	CONSTRAINT "chk_clinical_sessions_number" CHECK ("clinical_sessions"."session_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "clinical_sessions" ADD CONSTRAINT "clinical_sessions_record_id_medical_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."medical_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinical_sessions_patient_number" ON "clinical_sessions" USING btree ("patient_id","session_number");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_patient" ON "clinical_sessions" USING btree ("patient_id","session_number");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_appointment" ON "clinical_sessions" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinical_sessions_appointment_open" ON "clinical_sessions" USING btree ("appointment_id") WHERE "clinical_sessions"."appointment_id" is not null and "clinical_sessions"."status" = 'borrador';