ALTER TABLE "appointments" DROP CONSTRAINT "chk_appointments_status";--> statement-breakpoint
DROP INDEX "uq_appointments_slot";--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmed_channel" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appointments_slot" ON "appointments" USING btree ("appointment_date","start_time") WHERE "appointments"."status" in ('programada', 'notificada', 'confirmada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio');--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "chk_appointments_channel" CHECK ("appointments"."confirmed_channel" is null or "appointments"."confirmed_channel" in ('telegram', 'whatsapp', 'registro', 'telefono', 'presencial'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "chk_appointments_status" CHECK ("appointments"."status" in ('en_espera_cita', 'programada', 'notificada', 'confirmada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio', 'cancelada', 'reprogramada'));
--> statement-breakpoint
-- Escrito a mano: drizzle-kit no ve la diferencia porque el valor de la lista de una
-- solicitud es el mismo que antes (solo cambia la **fuente**, `REQUEST_STATUSES`).
-- Sin esto la base seguiría aceptando `confirmada` en una solicitud, que es un estado
-- que no le pertenece: una solicitud no tiene fecha todavía (ADR 0052).
ALTER TABLE "appointment_requests" DROP CONSTRAINT "chk_requests_status";--> statement-breakpoint
ALTER TABLE "appointment_requests" ADD CONSTRAINT "chk_requests_status" CHECK ("appointment_requests"."status" in ('en_espera_cita', 'programada', 'notificada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio', 'cancelada', 'reprogramada'));