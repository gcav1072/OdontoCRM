ALTER TABLE "patient_channels" RENAME COLUMN "chat_id" TO "direccion";
--> statement-breakpoint
ALTER TABLE "patient_channels" RENAME COLUMN "telegram_username" TO "usuario";
--> statement-breakpoint
DROP INDEX "uq_patient_channels_chat";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patient_channels_direccion" ON "patient_channels" USING btree ("channel","direccion");
--> statement-breakpoint
ALTER TABLE "patient_channels" DROP CONSTRAINT "chk_patient_channels_channel";
--> statement-breakpoint
ALTER TABLE "patient_channels" ADD CONSTRAINT "chk_patient_channels_channel" CHECK ("patient_channels"."channel" in ('telegram', 'whatsapp', 'registro', 'telefono', 'presencial'));
--> statement-breakpoint
ALTER TABLE "message_templates" DROP CONSTRAINT "chk_message_templates_channel";
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "chk_message_templates_channel" CHECK ("message_templates"."channel" in ('telegram', 'whatsapp', 'registro', 'telefono', 'presencial'));
--> statement-breakpoint
ALTER TABLE "bot_conversations" RENAME COLUMN "chat_id" TO "direccion";
--> statement-breakpoint
ALTER TABLE "bot_conversations" RENAME COLUMN "telegram_username" TO "usuario";
--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD COLUMN "canal" text DEFAULT 'telegram' NOT NULL;
--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD COLUMN "opciones" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "bot_conversations" DROP CONSTRAINT "bot_conversations_pkey";
--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD CONSTRAINT "bot_conversations_canal_direccion_pk" PRIMARY KEY("canal","direccion");
--> statement-breakpoint
ALTER TABLE "processed_updates" RENAME COLUMN "update_id" TO "evento_id";
--> statement-breakpoint
ALTER TABLE "processed_updates" RENAME COLUMN "chat_id" TO "direccion";
--> statement-breakpoint
ALTER TABLE "processed_updates" ALTER COLUMN "evento_id" SET DATA TYPE text USING "evento_id"::text;
--> statement-breakpoint
ALTER TABLE "processed_updates" ADD COLUMN "canal" text DEFAULT 'telegram' NOT NULL;
--> statement-breakpoint
ALTER TABLE "processed_updates" DROP CONSTRAINT "processed_updates_pkey";
--> statement-breakpoint
ALTER TABLE "processed_updates" ADD CONSTRAINT "processed_updates_canal_evento_id_pk" PRIMARY KEY("canal","evento_id");
--> statement-breakpoint
DROP TABLE "bot_state";
