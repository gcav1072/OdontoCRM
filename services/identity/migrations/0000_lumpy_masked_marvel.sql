CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE UNIQUE INDEX "uq_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_users_active" ON "users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");