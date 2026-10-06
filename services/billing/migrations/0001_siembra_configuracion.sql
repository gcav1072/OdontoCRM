-- Siembra de la configuración cerrada de la caja (Fase 11).
--
-- Acuerdo del 2026-10-05 con el contador y con Gabriel (docs/feat_billing.md §0.1, Anexos A y B):
--   · contribuyente ORDINARIO, no Sujeto Pasivo Especial  ⇒ no se percibe IGTF;
--   · pago en bolívares a la tasa del día del pago          ⇒ imputation_policy = 'tasa_del_pago';
--   · formas libres de imprenta autorizada                  ⇒ serie A en modo 'formas_libres';
--   · sin Decreto del Art. 62                               ⇒ alícuota adicional en 0;
--   · los servicios odontológicos están EXENTOS (Art. 19.6) y los bienes van al 16 %.
--
-- Va en la migración y no en un paso a mano: «no un paso manual olvidable» (§13 del plan).
-- Es idempotente (ON CONFLICT DO NOTHING): volver a migrar no pisa lo que la clínica haya cambiado.

INSERT INTO "billing_settings" (
  "id", "is_special_taxpayer", "imputation_policy", "rate_grace_days", "foreign_currency_iva_basis_points"
) VALUES (1, false, 'tasa_del_pago', 5, 0)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- La serie real (formas libres, con número de control preimpreso) y la del modo test.
INSERT INTO "invoice_series" ("series", "numbering_mode", "prefix") VALUES
  ('A', 'formas_libres', ''),
  ('T', 'software', '')
ON CONFLICT ("series") DO NOTHING;
--> statement-breakpoint
-- Los 28 servicios del catálogo clínico (exentos, sin precio: la caja los marca hasta que la
-- clínica ponga sus aranceles) y dos bienes de ejemplo al 16 %.
INSERT INTO "treatment_catalog" ("code", "name", "kind", "price_cents_usd", "tax_category") VALUES
  ('consulta_evaluacion', 'Consulta y evaluación', 'servicio', 0, 'exento'),
  ('control_postoperatorio', 'Control postoperatorio', 'servicio', 0, 'exento'),
  ('profilaxis', 'Profilaxis (limpieza)', 'servicio', 0, 'exento'),
  ('detartraje', 'Detartraje y alisado radicular', 'servicio', 0, 'exento'),
  ('aplicacion_fluor', 'Aplicación de flúor', 'servicio', 0, 'exento'),
  ('sellante', 'Sellante de fosas y fisuras', 'servicio', 0, 'exento'),
  ('obturacion_resina', 'Obturación con resina compuesta', 'servicio', 0, 'exento'),
  ('obturacion_amalgama', 'Obturación con amalgama', 'servicio', 0, 'exento'),
  ('obturacion_ionomero', 'Obturación con ionómero de vidrio', 'servicio', 0, 'exento'),
  ('reconstruccion', 'Reconstrucción coronaria', 'servicio', 0, 'exento'),
  ('endodoncia_unirradicular', 'Endodoncia unirradicular', 'servicio', 0, 'exento'),
  ('endodoncia_birradicular', 'Endodoncia birradicular', 'servicio', 0, 'exento'),
  ('endodoncia_multirradicular', 'Endodoncia multirradicular', 'servicio', 0, 'exento'),
  ('retratamiento_endodontico', 'Retratamiento endodóntico', 'servicio', 0, 'exento'),
  ('extraccion_simple', 'Extracción simple', 'servicio', 0, 'exento'),
  ('extraccion_quirurgica', 'Extracción quirúrgica', 'servicio', 0, 'exento'),
  ('corona_metal_porcelana', 'Corona metal-porcelana', 'servicio', 0, 'exento'),
  ('corona_zirconia', 'Corona de zirconia', 'servicio', 0, 'exento'),
  ('corona_temporal', 'Corona temporal', 'servicio', 0, 'exento'),
  ('implante_quirurgico', 'Implante: fase quirúrgica', 'servicio', 0, 'exento'),
  ('carga_implante', 'Implante: carga de la corona', 'servicio', 0, 'exento'),
  ('protesis_fija', 'Prótesis fija', 'servicio', 0, 'exento'),
  ('protesis_removible', 'Prótesis removible', 'servicio', 0, 'exento'),
  ('blanqueamiento', 'Blanqueamiento dental', 'servicio', 0, 'exento'),
  ('cementado', 'Cementado de restauración', 'servicio', 0, 'exento'),
  ('retiro_sutura', 'Retiro de sutura', 'servicio', 0, 'exento'),
  ('radiografia', 'Toma de radiografía', 'servicio', 0, 'exento'),
  ('otros', 'Otro procedimiento', 'servicio', 0, 'exento'),
  ('cepillo_dental', 'Cepillo dental', 'bien', 300, 'general'),
  ('gel_fluorado', 'Gel fluorado', 'bien', 1200, 'general')
ON CONFLICT ("code") DO NOTHING;
