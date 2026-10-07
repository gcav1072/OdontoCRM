-- ADR 0049: la numeración por defecto es `software` —el correlativo interno, sin número de
-- control—. Las formas libres quedan como opción **por serie**, para el día que se compren formas
-- autorizadas; su módulo sigue construido y probado, pero fuera del camino crítico.
UPDATE "invoice_series" SET "numbering_mode" = 'software' WHERE "series" = 'A';--> statement-breakpoint
