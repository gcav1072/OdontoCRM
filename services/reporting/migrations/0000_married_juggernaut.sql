CREATE TABLE "dim_day_capacity" (
	"date" date PRIMARY KEY NOT NULL,
	"capacity" integer,
	"notifications_sent" integer DEFAULT 0 NOT NULL,
	"notifications_failed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dim_patient" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"document" text NOT NULL,
	"full_name" text NOT NULL,
	"sex" text,
	"birth_date" date,
	"status" text DEFAULT 'en_espera_cita' NOT NULL,
	"is_fictitious" boolean DEFAULT false NOT NULL,
	"profile_alerts" text[] DEFAULT '{}'::text[] NOT NULL,
	"record_status" text,
	"record_signed_at" timestamp with time zone,
	"first_visit_at" timestamp with time zone,
	"last_visit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_appointment" (
	"appointment_id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"appointment_date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"status" text NOT NULL,
	"channel" text,
	"ticket_number" bigint,
	"request_id" uuid,
	"dentist_id" uuid,
	"chair_id" uuid,
	"requested_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"no_show_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"rescheduled_at" timestamp with time zone,
	"rescheduled_from_id" uuid,
	"no_show_reason" text,
	"force_attended_reason" text,
	"clinical_session_id" uuid,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_clinical_session" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"session_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"diagnosis_text" text,
	"procedure_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"procedure_count" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_prescription" (
	"prescription_id" uuid PRIMARY KEY NOT NULL,
	"number" text,
	"patient_id" uuid NOT NULL,
	"session_id" uuid,
	"status" text DEFAULT 'emitida' NOT NULL,
	"issued_at" timestamp with time zone,
	"item_count" integer DEFAULT 0 NOT NULL,
	"annulled_at" timestamp with time zone,
	"reprint_count" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_prescription_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_name" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_request" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"ticket_number" bigint,
	"patient_id" uuid,
	"channel" text NOT NULL,
	"status" text DEFAULT 'en_espera_cita' NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"appointment_id" uuid,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_tooth_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"condition" text NOT NULL,
	"surface" text,
	"state" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"session_id" uuid,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"producer" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_refreshes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT false NOT NULL,
	"error" text
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
CREATE INDEX "idx_dim_day_capacity_date" ON "dim_day_capacity" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_dim_patient_sex" ON "dim_patient" USING btree ("sex");--> statement-breakpoint
CREATE INDEX "idx_dim_patient_status" ON "dim_patient" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_dim_patient_birth" ON "dim_patient" USING btree ("birth_date");--> statement-breakpoint
CREATE INDEX "idx_dim_patient_created" ON "dim_patient" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_fact_appointment_date" ON "fact_appointment" USING btree ("appointment_date");--> statement-breakpoint
CREATE INDEX "idx_fact_appointment_patient" ON "fact_appointment" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_fact_appointment_status" ON "fact_appointment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fact_appointment_date_status" ON "fact_appointment" USING btree ("appointment_date","status");--> statement-breakpoint
CREATE INDEX "idx_fact_session_patient" ON "fact_clinical_session" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_fact_session_opened" ON "fact_clinical_session" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "idx_fact_session_appointment" ON "fact_clinical_session" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "idx_fact_prescription_patient" ON "fact_prescription" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_fact_prescription_issued" ON "fact_prescription" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "idx_fact_prescription_status" ON "fact_prescription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fact_prescription_item_med" ON "fact_prescription_item" USING btree ("medication_name","issued_at");--> statement-breakpoint
CREATE INDEX "idx_fact_prescription_item_prescription" ON "fact_prescription_item" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "idx_fact_request_date" ON "fact_request" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "idx_fact_request_patient" ON "fact_request" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_fact_request_status" ON "fact_request" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fact_tooth_finding_slot" ON "fact_tooth_finding" USING btree ("patient_id","tooth_number","condition",coalesce("surface", ''));--> statement-breakpoint
CREATE INDEX "idx_fact_tooth_finding_patient" ON "fact_tooth_finding" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_fact_tooth_finding_tooth" ON "fact_tooth_finding" USING btree ("tooth_number","condition");--> statement-breakpoint
CREATE INDEX "idx_fact_tooth_finding_condition" ON "fact_tooth_finding" USING btree ("condition");--> statement-breakpoint
CREATE INDEX "idx_processed_events_type" ON "processed_events" USING btree ("event_type","processed_at");--> statement-breakpoint
CREATE INDEX "idx_report_refreshes_started" ON "report_refreshes" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");