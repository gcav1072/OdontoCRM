CREATE TABLE "odontogram_prints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odontogram_id" uuid NOT NULL,
	"printed_by" uuid,
	"printed_by_username" text,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odontograms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"dentition" text DEFAULT 'permanente' NOT NULL,
	"notes" text,
	"last_printed_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	"recorded_by" uuid,
	"recorded_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_odontograms_dentition" CHECK ("odontograms"."dentition" in ('permanente', 'temporal'))
);
--> statement-breakpoint
CREATE TABLE "tooth_finding_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odontogram_id" uuid NOT NULL,
	"finding_id" uuid,
	"patient_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"surface" text,
	"condition" text NOT NULL,
	"state" text NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"notes" text,
	"actor_id" uuid,
	"actor_username" text,
	"session_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tooth_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odontogram_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"tooth_number" smallint NOT NULL,
	"surface" text,
	"condition" text NOT NULL,
	"state" text DEFAULT 'pendiente' NOT NULL,
	"notes" text,
	"recorded_by" uuid,
	"recorded_by_username" text,
	"recorded_in_session_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "chk_tooth_findings_tooth_number" CHECK (("tooth_findings"."tooth_number" between 11 and 48 or "tooth_findings"."tooth_number" between 51 and 85)),
	CONSTRAINT "chk_tooth_findings_surface" CHECK ("tooth_findings"."surface" is null or "tooth_findings"."surface" in ('vestibular', 'lingual', 'occlusal', 'mesial', 'distal')),
	CONSTRAINT "chk_tooth_findings_condition" CHECK ("tooth_findings"."condition" in ('caries', 'restauracion', 'ausente', 'extraccion_indicada', 'corona', 'implante', 'endodoncia')),
	CONSTRAINT "chk_tooth_findings_state" CHECK ("tooth_findings"."state" in ('pendiente', 'completado')),
	CONSTRAINT "chk_tooth_findings_scope" CHECK (("tooth_findings"."surface" is null and "tooth_findings"."condition" in ('ausente', 'extraccion_indicada', 'corona', 'implante', 'endodoncia')) or ("tooth_findings"."surface" is not null and "tooth_findings"."condition" in ('caries', 'restauracion')))
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
ALTER TABLE "odontogram_prints" ADD CONSTRAINT "odontogram_prints_odontogram_id_odontograms_id_fk" FOREIGN KEY ("odontogram_id") REFERENCES "public"."odontograms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tooth_finding_history" ADD CONSTRAINT "tooth_finding_history_odontogram_id_odontograms_id_fk" FOREIGN KEY ("odontogram_id") REFERENCES "public"."odontograms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tooth_findings" ADD CONSTRAINT "tooth_findings_odontogram_id_odontograms_id_fk" FOREIGN KEY ("odontogram_id") REFERENCES "public"."odontograms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_odontogram_prints" ON "odontogram_prints" USING btree ("odontogram_id","printed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_odontograms_patient" ON "odontograms" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_odontograms_updated" ON "odontograms" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_tooth_finding_history" ON "tooth_finding_history" USING btree ("odontogram_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_tooth_finding_history_tooth" ON "tooth_finding_history" USING btree ("patient_id","tooth_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tooth_findings_slot" ON "tooth_findings" USING btree ("odontogram_id","tooth_number","surface","condition");--> statement-breakpoint
CREATE INDEX "idx_tooth_findings_odontogram" ON "tooth_findings" USING btree ("odontogram_id");--> statement-breakpoint
CREATE INDEX "idx_tooth_findings_patient" ON "tooth_findings" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_tooth_findings_tooth" ON "tooth_findings" USING btree ("patient_id","tooth_number");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");