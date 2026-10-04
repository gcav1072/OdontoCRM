-- El CHECK del canal se quedó sin `whatsapp` cuando el ADR 0029 añadió el canal a
-- `CHANNELS` (Fase 4.1): una solicitud de WhatsApp real habría chocado con el
-- constraint de la base. Se realinea con el contrato, que es la única fuente de verdad.
ALTER TABLE "appointment_requests" DROP CONSTRAINT "chk_requests_channel";--> statement-breakpoint
ALTER TABLE "appointment_requests" ADD CONSTRAINT "chk_requests_channel" CHECK ("appointment_requests"."channel" in ('telegram', 'whatsapp', 'registro', 'telefono', 'presencial'));