-- Política de cancelación del paciente (ADR 0057).
--
-- Una cita **confirmada** se puede cancelar por el bot solo si le faltan **más** días
-- que este corte (0 = sin corte, la regla nace apagada). Las citas sin confirmar se
-- cancelan siempre. La fila es única (`id = 1`) y la editan el admin o el odontólogo
-- (`scheduling:cancel_policy`).
--
-- Se siembra aquí y no en un paso a mano —igual que `billing_settings`— y es
-- idempotente (`ON CONFLICT DO NOTHING`): volver a migrar no pisa lo que la clínica
-- haya configurado.
CREATE TABLE "notification_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"patient_cancel_cutoff_days" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "chk_notification_settings_single_row" CHECK ("notification_settings"."id" = 1),
	CONSTRAINT "chk_notification_settings_cutoff" CHECK ("notification_settings"."patient_cancel_cutoff_days" between 0 and 30)
);
--> statement-breakpoint
INSERT INTO "notification_settings" ("id", "patient_cancel_cutoff_days") VALUES (1, 0)
ON CONFLICT ("id") DO NOTHING;
