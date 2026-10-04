CREATE TABLE "medical_record_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"section_key" text,
	"reason" text NOT NULL,
	"content" text NOT NULL,
	"author_id" uuid,
	"author_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_medical_record_amendments_section" CHECK ("medical_record_amendments"."section_key" is null or "medical_record_amendments"."section_key" in ('identificacion', 'motivo_consulta', 'anamnesis', 'antecedentes_odontologicos', 'examen_extraoral', 'examen_intraoral', 'examenes_complementarios', 'diagnostico', 'plan_tratamiento', 'consentimiento', 'evolucion'))
);
--> statement-breakpoint
CREATE TABLE "medical_record_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_by_name" text NOT NULL,
	"accepted_by_document" text,
	"relationship" text NOT NULL,
	"witness_name" text,
	"notes" text,
	"registered_by" uuid,
	"registered_by_username" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_record_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_medical_record_sections_key" CHECK ("medical_record_sections"."section_key" in ('identificacion', 'motivo_consulta', 'anamnesis', 'antecedentes_odontologicos', 'examen_extraoral', 'examen_intraoral', 'examenes_complementarios', 'diagnostico', 'plan_tratamiento', 'consentimiento', 'evolucion'))
);
--> statement-breakpoint
CREATE TABLE "medical_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by" uuid,
	"signed_by_username" text,
	"last_printed_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_medical_records_status" CHECK ("medical_records"."status" in ('borrador', 'firmada'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope" jsonb NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"producer" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "medical_record_amendments" ADD CONSTRAINT "medical_record_amendments_record_id_medical_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."medical_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_record_consents" ADD CONSTRAINT "medical_record_consents_record_id_medical_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."medical_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_record_sections" ADD CONSTRAINT "medical_record_sections_record_id_medical_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."medical_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_medical_record_amendments" ON "medical_record_amendments" USING btree ("record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medical_record_consents" ON "medical_record_consents" USING btree ("record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medical_record_sections" ON "medical_record_sections" USING btree ("record_id","section_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medical_records_patient" ON "medical_records" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_medical_records_status" ON "medical_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");