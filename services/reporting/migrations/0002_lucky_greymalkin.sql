CREATE TABLE "patient_profiles" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"alert_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"record_status" text,
	"record_signed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_patient_profiles_updated" ON "patient_profiles" USING btree ("updated_at");