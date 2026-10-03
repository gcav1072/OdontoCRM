CREATE TABLE "patient_contacts_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous_value" text,
	"new_value" text,
	"reason" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_path" text NOT NULL,
	"caption" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_patient_files_kind" CHECK ("patient_files"."kind" in ('radiografia', 'foto', 'pdf', 'consentimiento', 'laboratorio', 'otro'))
);
--> statement-breakpoint
CREATE TABLE "patient_guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"doc_type" text,
	"doc_number" text,
	"relationship" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" text NOT NULL,
	"doc_number" text NOT NULL,
	"full_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"sex" text NOT NULL,
	"phone" text NOT NULL,
	"phone_alt" text,
	"email" text,
	"address" text,
	"occupation" text,
	"notes" text,
	"status" text DEFAULT 'en_espera_cita' NOT NULL,
	"is_fictitious" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_patients_doc_type" CHECK ("patients"."doc_type" in ('V', 'E', 'P', 'SC')),
	CONSTRAINT "chk_patients_sex" CHECK ("patients"."sex" in ('M', 'F', 'O')),
	CONSTRAINT "chk_patients_status" CHECK ("patients"."status" in ('en_espera_cita', 'activo', 'inactivo'))
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
ALTER TABLE "patient_contacts_history" ADD CONSTRAINT "patient_contacts_history_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_guardians" ADD CONSTRAINT "patient_guardians_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_patient_contacts_patient" ON "patient_contacts_history" USING btree ("patient_id","changed_at");--> statement-breakpoint
CREATE INDEX "idx_patient_files_patient" ON "patient_files" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patient_guardians_patient" ON "patient_guardians" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patients_document" ON "patients" USING btree ("doc_type","doc_number") WHERE "patients"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_patients_doc_number" ON "patients" USING btree ("doc_number");--> statement-breakpoint
CREATE INDEX "idx_patients_phone" ON "patients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_patients_status" ON "patients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_patients_full_name_trgm" ON "patients" USING gin ("full_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");