-- Fuentes de los imprimibles: de una sola familia a varias (título y cuerpo por familia).
--
-- Hasta ahora `brand_settings.fonts` guardaba `{ "family": "...", "files": [...] }`: un
-- único nombre de familia aplicado a todos los archivos. Ahora guarda
-- `{ "families": [ { "name": "...", "files": [...] }, ... ] }`, para que el panel pueda
-- elegir una familia distinta para los títulos y para el cuerpo.
--
-- Esta migración es **solo de datos** (la columna sigue siendo jsonb): envuelve las
-- filas con la forma antigua en `families` con un único elemento, y deja intactas las
-- que ya tengan `families`. Idempotente.
UPDATE "brand_settings"
SET "fonts" = jsonb_build_object(
  'families',
  jsonb_build_array(
    jsonb_build_object(
      'name', "fonts" -> 'family',
      'files', COALESCE("fonts" -> 'files', '[]'::jsonb)
    )
  )
)
WHERE "fonts" IS NOT NULL
  AND "fonts" ? 'family'
  AND NOT ("fonts" ? 'families');
