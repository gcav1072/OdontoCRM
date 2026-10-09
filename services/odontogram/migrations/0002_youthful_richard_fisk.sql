-- Blindaje de las reglas clínicas del odontograma (spec anexo ADR 0032).
--
-- Antes de añadir el CHECK de estado hay que **reparar** la base para que cumpla las
-- reglas nuevas: hay filas con estados y convivencias que hoy son imposibles (la pieza
-- «extracción completada + implante» del informe de fallo). Cada cambio queda con su
-- entrada en el histórico («saneado por reglas clínicas») para que la historia siga
-- siendo defendible.

-- 1) La extracción indicada **cumplida** deja la pieza ausente (spec §5): el estado
--    «extracción completada» ya no existe; lo que se extrajo está ausente.
INSERT INTO "tooth_findings" (
  "odontogram_id", "patient_id", "tooth_number", "surface", "condition", "state",
  "notes", "recorded_by", "recorded_by_username", "recorded_in_session_id",
  "recorded_at", "updated_at"
)
SELECT
  f."odontogram_id", f."patient_id", f."tooth_number", NULL, 'ausente', 'completado',
  f."notes", f."recorded_by", f."recorded_by_username", f."recorded_in_session_id",
  now(), now()
FROM "tooth_findings" f
WHERE f."condition" = 'extraccion_indicada'
  AND f."state" = 'completado'
  AND f."resolved_at" IS NULL
ON CONFLICT ("odontogram_id", "tooth_number", "surface", "condition") DO NOTHING;--> statement-breakpoint

INSERT INTO "tooth_finding_history" (
  "odontogram_id", "finding_id", "patient_id", "tooth_number", "surface", "condition",
  "state", "event", "reason", "notes", "occurred_at"
)
SELECT
  f."odontogram_id", f."id", f."patient_id", f."tooth_number", f."surface", f."condition",
  f."state", 'resuelto',
  'saneado por reglas clínicas: la extracción cumplida deja la pieza ausente',
  f."notes", now()
FROM "tooth_findings" f
WHERE f."condition" = 'extraccion_indicada'
  AND f."state" = 'completado'
  AND f."resolved_at" IS NULL;--> statement-breakpoint

UPDATE "tooth_findings"
SET "resolved_at" = now(), "updated_at" = now()
WHERE "condition" = 'extraccion_indicada'
  AND "state" = 'completado'
  AND "resolved_at" IS NULL;--> statement-breakpoint

-- 2) La caries **tratada** pasa a obturación completada en la misma cara (spec §5).
INSERT INTO "tooth_findings" (
  "odontogram_id", "patient_id", "tooth_number", "surface", "condition", "state",
  "notes", "recorded_by", "recorded_by_username", "recorded_in_session_id",
  "recorded_at", "updated_at"
)
SELECT
  f."odontogram_id", f."patient_id", f."tooth_number", f."surface", 'restauracion', 'completado',
  f."notes", f."recorded_by", f."recorded_by_username", f."recorded_in_session_id",
  now(), now()
FROM "tooth_findings" f
WHERE f."condition" = 'caries'
  AND f."state" = 'completado'
  AND f."resolved_at" IS NULL
ON CONFLICT ("odontogram_id", "tooth_number", "surface", "condition") DO NOTHING;--> statement-breakpoint

INSERT INTO "tooth_finding_history" (
  "odontogram_id", "finding_id", "patient_id", "tooth_number", "surface", "condition",
  "state", "event", "reason", "notes", "occurred_at"
)
SELECT
  f."odontogram_id", f."id", f."patient_id", f."tooth_number", f."surface", f."condition",
  f."state", 'resuelto',
  'saneado por reglas clínicas: la caries tratada pasa a obturación',
  f."notes", now()
FROM "tooth_findings" f
WHERE f."condition" = 'caries'
  AND f."state" = 'completado'
  AND f."resolved_at" IS NULL;--> statement-breakpoint

UPDATE "tooth_findings"
SET "resolved_at" = now(), "updated_at" = now()
WHERE "condition" = 'caries'
  AND "state" = 'completado'
  AND "resolved_at" IS NULL;--> statement-breakpoint

-- 3) Un implante no convive con una extracción indicada (spec §3): el implante es el
--    soporte ya colocado; se resuelve la extracción indicada que quedara vigente.
INSERT INTO "tooth_finding_history" (
  "odontogram_id", "finding_id", "patient_id", "tooth_number", "surface", "condition",
  "state", "event", "reason", "notes", "occurred_at"
)
SELECT
  f."odontogram_id", f."id", f."patient_id", f."tooth_number", f."surface", f."condition",
  f."state", 'resuelto',
  'saneado por reglas clínicas: un implante no convive con una extracción indicada',
  f."notes", now()
FROM "tooth_findings" f
WHERE f."condition" = 'extraccion_indicada'
  AND f."resolved_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "tooth_findings" i
    WHERE i."odontogram_id" = f."odontogram_id"
      AND i."tooth_number" = f."tooth_number"
      AND i."condition" = 'implante'
      AND i."resolved_at" IS NULL
  );--> statement-breakpoint

UPDATE "tooth_findings" f
SET "resolved_at" = now(), "updated_at" = now()
WHERE f."condition" = 'extraccion_indicada'
  AND f."resolved_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "tooth_findings" i
    WHERE i."odontogram_id" = f."odontogram_id"
      AND i."tooth_number" = f."tooth_number"
      AND i."condition" = 'implante'
      AND i."resolved_at" IS NULL
  );--> statement-breakpoint

-- 4) El implante y la pieza ausente **excluyen las caras** (spec §3): se superan las
--    caras que quedaran vigentes en una pieza con implante o ausente.
INSERT INTO "tooth_finding_history" (
  "odontogram_id", "finding_id", "patient_id", "tooth_number", "surface", "condition",
  "state", "event", "reason", "notes", "occurred_at"
)
SELECT
  f."odontogram_id", f."id", f."patient_id", f."tooth_number", f."surface", f."condition",
  f."state", 'superado',
  'saneado por reglas clínicas: la pieza no conserva caras naturales',
  f."notes", now()
FROM "tooth_findings" f
WHERE f."surface" IS NOT NULL
  AND f."resolved_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "tooth_findings" w
    WHERE w."odontogram_id" = f."odontogram_id"
      AND w."tooth_number" = f."tooth_number"
      AND w."resolved_at" IS NULL
      AND w."condition" IN ('implante', 'ausente')
  );--> statement-breakpoint

UPDATE "tooth_findings" f
SET "resolved_at" = now(), "updated_at" = now()
WHERE f."surface" IS NOT NULL
  AND f."resolved_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "tooth_findings" w
    WHERE w."odontogram_id" = f."odontogram_id"
      AND w."tooth_number" = f."tooth_number"
      AND w."resolved_at" IS NULL
      AND w."condition" IN ('implante', 'ausente')
  );--> statement-breakpoint

-- 5) Clamp de los estados imposibles que queden (incluidas las filas **superadas**, que
--    también tienen que cumplir el CHECK): caries y extracción indicada solo
--    `pendiente`; la pieza ausente solo `completado`.
UPDATE "tooth_findings" SET "state" = 'pendiente', "updated_at" = now()
WHERE "condition" = 'caries' AND "state" <> 'pendiente';--> statement-breakpoint

UPDATE "tooth_findings" SET "state" = 'pendiente', "updated_at" = now()
WHERE "condition" = 'extraccion_indicada' AND "state" <> 'pendiente';--> statement-breakpoint

UPDATE "tooth_findings" SET "state" = 'completado', "updated_at" = now()
WHERE "condition" = 'ausente' AND "state" <> 'completado';--> statement-breakpoint

-- Blindaje: el estado tiene que ser válido para la condición (spec §2), espejo de
-- `isStateAllowed` en el contrato.
ALTER TABLE "tooth_findings" ADD CONSTRAINT "chk_tooth_findings_state_allowed" CHECK ((
        ("tooth_findings"."condition" in ('caries', 'extraccion_indicada') and "tooth_findings"."state" = 'pendiente')
        or ("tooth_findings"."condition" = 'ausente' and "tooth_findings"."state" = 'completado')
        or "tooth_findings"."condition" in ('restauracion', 'corona', 'implante', 'endodoncia')
      ));