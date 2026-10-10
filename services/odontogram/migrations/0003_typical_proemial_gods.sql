CREATE TABLE "prostheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odontogram_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"arch" text NOT NULL,
	"tooth_numbers" smallint[] NOT NULL,
	"state" text DEFAULT 'pendiente' NOT NULL,
	"notes" text,
	"recorded_by" uuid,
	"recorded_by_username" text,
	"recorded_in_session_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "chk_prostheses_kind" CHECK ("prostheses"."kind" in ('ppr', 'prt')),
	CONSTRAINT "chk_prostheses_arch" CHECK ("prostheses"."arch" in ('maxilar', 'mandibula')),
	CONSTRAINT "chk_prostheses_state" CHECK ("prostheses"."state" in ('pendiente', 'completado'))
);
--> statement-breakpoint
CREATE TABLE "prosthesis_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"odontogram_id" uuid NOT NULL,
	"prosthesis_id" uuid,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"arch" text NOT NULL,
	"tooth_numbers" smallint[] NOT NULL,
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
ALTER TABLE "tooth_findings" DROP CONSTRAINT "chk_tooth_findings_condition";--> statement-breakpoint
ALTER TABLE "tooth_findings" DROP CONSTRAINT "chk_tooth_findings_state_allowed";--> statement-breakpoint
ALTER TABLE "tooth_findings" DROP CONSTRAINT "chk_tooth_findings_scope";--> statement-breakpoint
ALTER TABLE "prostheses" ADD CONSTRAINT "prostheses_odontogram_id_odontograms_id_fk" FOREIGN KEY ("odontogram_id") REFERENCES "public"."odontograms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prosthesis_history" ADD CONSTRAINT "prosthesis_history_odontogram_id_odontograms_id_fk" FOREIGN KEY ("odontogram_id") REFERENCES "public"."odontograms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prostheses_odontogram" ON "prostheses" USING btree ("odontogram_id");--> statement-breakpoint
CREATE INDEX "idx_prostheses_patient" ON "prostheses" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prosthesis_prt_arch" ON "prostheses" USING btree ("odontogram_id","arch") WHERE "prostheses"."kind" = 'prt' and "prostheses"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "idx_prosthesis_history" ON "prosthesis_history" USING btree ("odontogram_id","occurred_at");--> statement-breakpoint
ALTER TABLE "tooth_findings" ADD CONSTRAINT "chk_tooth_findings_condition" CHECK ("tooth_findings"."condition" in ('caries', 'restauracion', 'ausente', 'extraccion_indicada', 'extraida', 'corona', 'implante', 'endodoncia'));--> statement-breakpoint
ALTER TABLE "tooth_findings" ADD CONSTRAINT "chk_tooth_findings_state_allowed" CHECK ((
        ("tooth_findings"."condition" in ('caries', 'extraccion_indicada') and "tooth_findings"."state" = 'pendiente')
        or ("tooth_findings"."condition" in ('ausente', 'extraida') and "tooth_findings"."state" = 'completado')
        or "tooth_findings"."condition" in ('restauracion', 'corona', 'implante', 'endodoncia')
      ));--> statement-breakpoint
ALTER TABLE "tooth_findings" ADD CONSTRAINT "chk_tooth_findings_scope" CHECK (("tooth_findings"."surface" is null and "tooth_findings"."condition" in ('ausente', 'extraccion_indicada', 'extraida', 'corona', 'implante', 'endodoncia')) or ("tooth_findings"."surface" is not null and "tooth_findings"."condition" in ('caries', 'restauracion')));