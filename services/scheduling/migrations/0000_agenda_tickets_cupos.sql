CREATE SEQUENCE "public"."ticket_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "appointment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" bigint DEFAULT nextval('ticket_seq') NOT NULL,
	"channel" text DEFAULT 'registro' NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_name" text NOT NULL,
	"patient_document" text,
	"patient_phone" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'en_espera_cita' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_requests_channel" CHECK ("appointment_requests"."channel" in ('telegram', 'registro', 'telefono', 'presencial')),
	CONSTRAINT "chk_requests_status" CHECK ("appointment_requests"."status" in ('en_espera_cita', 'programada', 'notificada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio', 'cancelada', 'reprogramada'))
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"patient_id" uuid NOT NULL,
	"patient_name" text NOT NULL,
	"patient_document" text,
	"patient_phone" text,
	"appointment_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"slot_kind" text DEFAULT 'franja' NOT NULL,
	"status" text DEFAULT 'programada' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"dentist_id" uuid,
	"chair_id" uuid,
	"checked_in_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"no_show_reason" text,
	"force_attended_reason" text,
	"overbook_authorized" boolean DEFAULT false NOT NULL,
	"overbook_reason" text,
	"rescheduled_from_id" uuid,
	"ics_sequence" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_appointments_slot_kind" CHECK ("appointments"."slot_kind" in ('franja', 'manual')),
	CONSTRAINT "chk_appointments_status" CHECK ("appointments"."status" in ('en_espera_cita', 'programada', 'notificada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio', 'cancelada', 'reprogramada'))
);
--> statement-breakpoint
CREATE TABLE "day_capacities" (
	"date" date PRIMARY KEY NOT NULL,
	"capacity" integer NOT NULL,
	"notes" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor_id" uuid,
	"actor_username" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_status_history_entity" CHECK ("status_history"."entity_type" in ('request', 'appointment'))
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
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_request_id_appointment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."appointment_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_appointments_id_fk" FOREIGN KEY ("rescheduled_from_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appointment_requests_ticket" ON "appointment_requests" USING btree ("ticket_number");--> statement-breakpoint
CREATE INDEX "idx_appointment_requests_status" ON "appointment_requests" USING btree ("status","priority","ticket_number");--> statement-breakpoint
CREATE INDEX "idx_appointment_requests_patient" ON "appointment_requests" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_appointment_requests_requested" ON "appointment_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "idx_appointments_date" ON "appointments" USING btree ("appointment_date","start_time");--> statement-breakpoint
CREATE INDEX "idx_appointments_status" ON "appointments" USING btree ("status","appointment_date");--> statement-breakpoint
CREATE INDEX "idx_appointments_patient" ON "appointments" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_appointments_request" ON "appointments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_slot_templates_weekday" ON "slot_templates" USING btree ("weekday","is_active");--> statement-breakpoint
CREATE INDEX "idx_status_history_entity" ON "status_history" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");
--> statement-breakpoint
INSERT INTO "slot_templates" ("weekday", "start_time", "end_time", "slot_minutes", "breaks", "is_active") VALUES
  (1, '08:00', '12:00', 30, '[]'::jsonb, true),
  (1, '13:00', '17:00', 30, '[]'::jsonb, true),
  (2, '08:00', '12:00', 30, '[]'::jsonb, true),
  (2, '13:00', '17:00', 30, '[]'::jsonb, true),
  (3, '08:00', '12:00', 30, '[]'::jsonb, true),
  (3, '13:00', '17:00', 30, '[]'::jsonb, true),
  (4, '08:00', '12:00', 30, '[]'::jsonb, true),
  (4, '13:00', '17:00', 30, '[]'::jsonb, true),
  (5, '08:00', '12:00', 30, '[]'::jsonb, true),
  (5, '13:00', '17:00', 30, '[]'::jsonb, true);
