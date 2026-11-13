-- v1.2 — recordatorios automáticos y múltiples chats por paciente.
--
-- 1. `notification_settings` gana los cuatro ajustes de la política de recordatorios
--    (días de antelación, hora de envío, citas ya confirmadas y envío automático de
--    documentos). `reminderDaysBefore = 0` deja los recordatorios apagados, que es el
--    valor por defecto: activarlos es una decisión explícita del consultorio.
-- 2. `patient_channels` gana `is_primary` (chat principal: destino por defecto de los
--    avisos y recordatorios) y `last_inbound_at` (desempate por actividad reciente).
--    El índice único parcial `uq_patient_channels_primary` garantiza **un solo chat
--    principal por paciente**; cambiarlo se hace en transacción.
-- 3. Backfill: las instalaciones que ya tenían un vínculo por paciente reciben como
--    principal el chat más reciente (prefiriendo WhatsApp, que es el canal principal,
--    D16). Sin esto el panel mostraría «sin principal» en fichas ya vinculadas.
-- 4. Plantillas: el orden de los siete pasos cambia (la cédula pasa a ser el Paso 1),
--    así que se renumera el texto **solo si sigue siendo el de v1.1**. Las plantillas
--    personalizadas por la clínica no se tocan. Las claves nuevas (`cita_recordatorio`,
--    `documento_recipe`, etc.) las siembra `ensureDefaultTemplates` al arrancar.
ALTER TABLE "notification_settings" ADD COLUMN "reminder_days_before" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reminder_send_hour" integer DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "reminder_include_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "auto_send_documents" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_channels" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_channels" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_patient_channels_primary" ON "patient_channels" USING btree ("patient_id") WHERE "patient_channels"."is_primary";--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "chk_notification_settings_reminder_days" CHECK ("notification_settings"."reminder_days_before" between 0 and 30);--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "chk_notification_settings_reminder_hour" CHECK ("notification_settings"."reminder_send_hour" between 7 and 20);--> statement-breakpoint
UPDATE "patient_channels" AS "pc"
SET "is_primary" = true
WHERE "pc"."id" IN (
	SELECT DISTINCT ON ("patient_id") "id"
	FROM "patient_channels"
	WHERE "direccion" IS NOT NULL
	ORDER BY "patient_id", ("channel" = 'whatsapp') DESC, "linked_at" DESC
);--> statement-breakpoint
UPDATE "message_templates"
SET "body" = E'Paso 2 de 7 · ¿Cómo te llamas? Escribe tu nombre y apellido.', "updated_at" = now()
WHERE "key" = 'pedir_nombre'
	AND "body" = E'Paso 1 de 7 · ¿Cómo te llamas? Escribe tu nombre y apellido.';--> statement-breakpoint
UPDATE "message_templates"
SET "body" = E'Paso 1 de 7 · ¿Cuál es tu documento?\nElige el tipo (V, E, P o SC) y escríbeme el número, por ejemplo V-12345678.', "updated_at" = now()
WHERE "key" = 'pedir_documento'
	AND "body" = E'Paso 2 de 7 · ¿Cuál es tu documento?\nElige el tipo (V, E, P o SC) y escríbeme el número, por ejemplo V-12345678.';
