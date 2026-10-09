CREATE TABLE "clinic_profiles" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"address" text NOT NULL,
	"city" text,
	"phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"email" text,
	"rif" text,
	"website" text,
	"logo_blob_key" text,
	"logo_mime" text,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_clinic_profiles_singleton" CHECK ("clinic_profiles"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "dentist_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mpps" text NOT NULL,
	"specialty" text NOT NULL,
	"license_number" text,
	"contact_email" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dentist_profiles" ADD CONSTRAINT "dentist_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dentist_profiles_completed" ON "dentist_profiles" USING btree ("completed_at");