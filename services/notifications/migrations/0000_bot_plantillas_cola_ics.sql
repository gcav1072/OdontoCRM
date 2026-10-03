CREATE TABLE "bot_conversations" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'inicio' NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"patient_id" uuid,
	"telegram_username" text,
	"last_ticket" bigint,
	"message_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ics_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"filename" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_message_templates_channel" CHECK ("message_templates"."channel" in ('telegram', 'registro', 'telefono', 'presencial'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_name" text,
	"appointment_id" uuid,
	"template_key" text NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"recipient" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"manual_note" text,
	"contacted_at" timestamp with time zone,
	"contacted_by" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_notifications_status" CHECK ("notifications"."status" in ('queued', 'sending', 'sent', 'failed', 'skipped_no_channel'))
);
--> statement-breakpoint
CREATE TABLE "patient_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"chat_id" text,
	"telegram_username" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_patient_channels_channel" CHECK ("patient_channels"."channel" in ('telegram', 'registro', 'telefono', 'presencial'))
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE INDEX "idx_bot_conversations_updated" ON "bot_conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ics_artifacts_appointment" ON "ics_artifacts" USING btree ("appointment_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_dedupe" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_queue" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_patient" ON "notifications" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_appointment" ON "notifications" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patient_channels_chat" ON "patient_channels" USING btree ("channel","chat_id");--> statement-breakpoint
CREATE INDEX "idx_patient_channels_patient" ON "patient_channels" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patient_channels_link_code" ON "patient_channels" USING btree ("link_code");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");