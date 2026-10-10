-- Configuración de la aplicación desde el panel de administración (ADR 0060).
--
-- Tres tablas **singleton** (`id = 1`), todas vacías de arranque a propósito: mientras
-- no haya fila, la configuración sale del respaldo del código (`brand.ts`, el tema de
-- `tokens.css`, el diccionario `i18n.ts` y el `.env` de los canales) y `fromDatabase`
-- es `false`. Así una instalación recién migrada sigue con la identidad de fábrica sin
-- sembrar nada, y el panel empieza a mandar en cuanto se guarda la primera vez.
--
--  * `brand_settings`: marca de los **imprimibles** (paleta, tipografías, medidas y
--    fuentes). El logo NO está aquí: vive en `clinic_profiles` (ADR 0056).
--  * `app_settings`: acento de la **interfaz** y textos del **kiosko**.
--  * `channel_settings`: datos y credenciales de los **canales**. Los secretos se
--    guardan cifrados (`*_enc`) con la clave del almacén (AES-256-GCM, base64).
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"accent" text,
	"screen_texts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "chk_app_settings_singleton" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "chk_app_settings_accent" CHECK ("app_settings"."accent" is null or "app_settings"."accent" in ('teal', 'azul', 'indigo', 'violeta', 'fucsia', 'rosa', 'rojo', 'vino', 'naranja', 'verde'))
);
--> statement-breakpoint
CREATE TABLE "brand_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"palette" jsonb,
	"typography" jsonb,
	"letterhead" jsonb,
	"fonts" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "chk_brand_settings_singleton" CHECK ("brand_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "channel_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"telegram_bot_username" text,
	"admin_telegram_chat_id" text,
	"whatsapp_phone_id" text,
	"whatsapp_api_base" text,
	"telegram_bot_token_enc" text,
	"admin_telegram_bot_token_enc" text,
	"whatsapp_token_enc" text,
	"whatsapp_verify_token_enc" text,
	"whatsapp_app_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "chk_channel_settings_singleton" CHECK ("channel_settings"."id" = 1)
);
