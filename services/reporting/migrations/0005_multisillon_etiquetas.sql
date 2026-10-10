-- Multisillón: el hecho de la cita guarda el **nombre** del consultorio y del
-- odontólogo, no solo su id. Los dos viajan ya en el evento ([ADR 0041], el evento
-- lleva lo que el consumidor necesita), así que se guardan para poder rotular los
-- reportes de ocupación por consultorio y productividad por odontólogo sin leer
-- bases ajenas ni resolver ids en la consulta.
--
-- Escrita a mano como la 0004: `drizzle-kit` la generaría igual, pero el snapshot se
-- copia del anterior y se le añaden las dos columnas (el generador no ve las vistas
-- materializadas ni los cambios de su definición).
ALTER TABLE "fact_appointment" ADD COLUMN "chair_label" text;--> statement-breakpoint
ALTER TABLE "fact_appointment" ADD COLUMN "dentist_name" text;
