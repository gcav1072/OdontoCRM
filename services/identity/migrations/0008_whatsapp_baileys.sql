-- WhatsApp por Baileys (ADR 0072) en el panel de canales.
--
-- El canal conserva el id `whatsapp`; lo que cambia es el proveedor. Las
-- columnas de Cloud API **no se borran**: se conserva como alternativa
-- configurable y la Fase 8 de limpieza se cancela a propósito.
--
-- * `whatsapp_enabled`: interruptor del canal (la base manda sobre el `.env`).
-- * `whatsapp_provider`: `baileys` (por defecto) o `cloud_api`.
-- * ritmo y tope diario: la espera entre envíos se sortea entre mínimo y
--   máximo; 2–4 s y 150 mensajes al día de fábrica (D9).
--
-- Una instalación que ya tenía las cuatro credenciales de Cloud API sigue
-- funcionando sin tocar nada: se marca como `cloud_api` y se enciende. Las
-- instalaciones nuevas arrancan en Baileys y apagadas.
ALTER TABLE "channel_settings" ADD COLUMN "whatsapp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN "whatsapp_provider" text DEFAULT 'baileys' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN "whatsapp_send_min_interval_ms" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN "whatsapp_send_max_interval_ms" integer DEFAULT 4000 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD COLUMN "whatsapp_daily_send_cap" integer DEFAULT 150 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "chk_channel_settings_whatsapp_provider" CHECK ("channel_settings"."whatsapp_provider" in ('baileys', 'cloud_api'));--> statement-breakpoint
ALTER TABLE "channel_settings" ADD CONSTRAINT "chk_channel_settings_whatsapp_rate" CHECK ("channel_settings"."whatsapp_send_min_interval_ms" between 1000 and 60000 and "channel_settings"."whatsapp_send_max_interval_ms" between 1000 and 60000 and "channel_settings"."whatsapp_send_max_interval_ms" >= "channel_settings"."whatsapp_send_min_interval_ms" and "channel_settings"."whatsapp_daily_send_cap" between 1 and 1000);--> statement-breakpoint
UPDATE "channel_settings"
   SET "whatsapp_provider" = 'cloud_api',
       "whatsapp_enabled" = true
 WHERE "whatsapp_token_enc" IS NOT NULL
   AND "whatsapp_phone_id" IS NOT NULL
   AND "whatsapp_verify_token_enc" IS NOT NULL
   AND "whatsapp_app_secret_enc" IS NOT NULL;