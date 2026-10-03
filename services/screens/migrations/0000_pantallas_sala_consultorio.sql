CREATE TABLE "call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_display_name" text NOT NULL,
	"turn_number" bigint,
	"ticket" text,
	"call_number" integer DEFAULT 1 NOT NULL,
	"chair_label" text NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"called_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"event_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_state" (
	"appointment_id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid,
	"patient_name" text NOT NULL,
	"patient_display_name" text NOT NULL,
	"ticket" text,
	"turn_number" bigint,
	"reason" text,
	"patient_birth_date" text,
	"patient_sex" text,
	"estado" text NOT NULL,
	"chair_label" text NOT NULL,
	"critical_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_room_state_estado" CHECK ("room_state"."estado" in ('en_sala_espera', 'llamado', 'en_consulta'))
);
--> statement-breakpoint
CREATE TABLE "screen_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_screen_devices_kind" CHECK ("screen_devices"."kind" in ('lobby', 'consultorio'))
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
CREATE UNIQUE INDEX "uq_call_events_event" ON "call_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_call_events_called_at" ON "call_events" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "idx_room_state_estado" ON "room_state" USING btree ("estado","since");--> statement-breakpoint
CREATE INDEX "idx_room_state_dentro" ON "room_state" USING btree ("left_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_screen_devices_token" ON "screen_devices" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");