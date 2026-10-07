CREATE SEQUENCE "public"."dossier_exports_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "dossier_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_snapshot" jsonb,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"issued_by_username" text,
	"verify_code" text NOT NULL,
	"pdf_path" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_dossier_exports_number" CHECK ("dossier_exports"."number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dossier_exports_number" ON "dossier_exports" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dossier_exports_verify_code" ON "dossier_exports" USING btree ("verify_code");--> statement-breakpoint
CREATE INDEX "idx_dossier_exports_patient" ON "dossier_exports" USING btree ("patient_id","issued_at");