-- Licenciamiento offline y modo consulta (ADR 0075).
--
-- La **instalación** es una sola fila (`id = 1`), como `clinic_profiles` o
-- `app_settings`: un consultorio = una instalación. Aquí viven:
--
-- * `installation_id`: el UUID que ata las licencias a ESTA instalación y que
--   viaja en la solicitud que el consultorio le manda al proveedor.
-- * `installed_at`: el arranque de la prueba de 30 días.
-- * `last_seen_at`: marcador anti-atraso del reloj; solo avanza.
-- * `license_token` / `license_claims`: la licencia activa (JWT firmado y sus
--   claims ya verificados). Mientras sean NULL, la instalación está en prueba.
--
-- La fila se **siembra aquí** (no al primer login): así la prueba empieza en la
-- instalación y un `restore` de la base conserva la licencia y la fecha de
-- arranque. `ON CONFLICT` mantiene la migración idempotente.
CREATE TABLE "installation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"installation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"license_token" text,
	"license_claims" jsonb,
	"license_activated_at" timestamp with time zone,
	"license_activated_by" uuid,
	"license_activation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_installation_singleton" CHECK ("installation"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "installation" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
