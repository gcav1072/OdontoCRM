CREATE SEQUENCE "public"."prescription_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "clinical_session_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" text NOT NULL,
	"caption" text,
	"tooth_number" integer,
	"uploaded_by" uuid,
	"uploaded_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_clinical_session_files_kind" CHECK ("clinical_session_files"."kind" in ('radiografia', 'foto_clinica', 'documento', 'otro')),
	CONSTRAINT "chk_clinical_session_files_tooth" CHECK ("clinical_session_files"."tooth_number" is null or ("clinical_session_files"."tooth_number" >= 11 and "clinical_session_files"."tooth_number" <= 85))
);
--> statement-breakpoint
CREATE TABLE "medications_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"presentations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usual_dose" text,
	"usual_frequency" text,
	"usual_duration" text,
	"indications" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"medication_id" uuid,
	"medication_name" text NOT NULL,
	"presentation" text,
	"route" text,
	"dose" text NOT NULL,
	"frequency" text NOT NULL,
	"duration" text,
	"instructions" text,
	"quantity" text,
	CONSTRAINT "chk_prescription_items_route" CHECK ("prescription_items"."route" is null or "prescription_items"."route" in ('oral', 'sublingual', 'topica', 'intramuscular', 'endovenosa', 'otra'))
);
--> statement-breakpoint
CREATE TABLE "prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_number" integer,
	"session_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"general_instructions" text,
	"patient_snapshot" jsonb,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"issued_by_username" text,
	"verify_code" text,
	"pdf_path" text,
	"pdf_sha256" text,
	"generated_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annulled_by_username" text,
	"annul_reason" text,
	"created_by" uuid,
	"created_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_prescriptions_status" CHECK ("prescriptions"."status" in ('borrador', 'emitida', 'anulada')),
	CONSTRAINT "chk_prescriptions_number" CHECK ("prescriptions"."prescription_number" is null or "prescriptions"."prescription_number" > 0),
	CONSTRAINT "chk_prescriptions_issued" CHECK ("prescriptions"."status" <> 'emitida' or ("prescriptions"."prescription_number" is not null and "prescriptions"."verify_code" is not null and "prescriptions"."pdf_path" is not null and "prescriptions"."issued_at" is not null)),
	CONSTRAINT "chk_prescriptions_annulled" CHECK ("prescriptions"."status" <> 'anulada' or ("prescriptions"."annulled_at" is not null and "prescriptions"."annul_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "clinical_session_files" ADD CONSTRAINT "clinical_session_files_session_id_clinical_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_session_id_clinical_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinical_session_files_session" ON "clinical_session_files" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_clinical_session_files_patient" ON "clinical_session_files" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_medications_catalog_name" ON "medications_catalog" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_medications_catalog_active" ON "medications_catalog" USING btree ("is_active","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prescription_items_position" ON "prescription_items" USING btree ("prescription_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prescriptions_number" ON "prescriptions" USING btree ("prescription_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prescriptions_verify_code" ON "prescriptions" USING btree ("verify_code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prescriptions_session_draft" ON "prescriptions" USING btree ("session_id") WHERE "prescriptions"."status" = 'borrador';--> statement-breakpoint
CREATE INDEX "idx_prescriptions_patient" ON "prescriptions" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_session" ON "prescriptions" USING btree ("session_id","created_at");--> statement-breakpoint
-- ─── Catálogo de medicamentos ───────────────────────────────────────────────
-- Los más usados en odontología: analgésicos y antiinflamatorios, antibióticos,
-- antisépticos y anestésicos locales. Las dosis son la **sugerencia habitual en
-- adultos**: el récipe las copia y el odontólogo las edita, nunca se imponen.
-- El catálogo es editable en la base (el consultorio puede añadir o retirar sin
-- recompilar) y cada récipe guarda su propia copia del medicamento, así que
-- cambiarlo no reescribe lo ya emitido.
INSERT INTO "medications_catalog" ("name", "presentations", "routes", "usual_dose", "usual_frequency", "usual_duration", "indications") VALUES
  ('Amoxicilina', '["Tabletas 500 mg","Suspensión 250 mg/5 ml"]'::jsonb, '["oral"]'::jsonb, '500 mg', 'cada 8 horas', '7 días', 'Infección odontogénica'),
  ('Amoxicilina + ácido clavulánico', '["Tabletas 875/125 mg","Suspensión 400/57 mg/5 ml"]'::jsonb, '["oral"]'::jsonb, '875 mg', 'cada 12 horas', '7 días', 'Infección que no responde a la amoxicilina'),
  ('Azitromicina', '["Tabletas 500 mg","Suspensión 200 mg/5 ml"]'::jsonb, '["oral"]'::jsonb, '500 mg', 'cada 24 horas', '3 días', 'Alergia a la penicilina'),
  ('Clindamicina', '["Cápsulas 300 mg"]'::jsonb, '["oral"]'::jsonb, '300 mg', 'cada 6 a 8 horas', '7 días', 'Alergia a la penicilina; infección por anaerobios'),
  ('Metronidazol', '["Tabletas 500 mg"]'::jsonb, '["oral"]'::jsonb, '500 mg', 'cada 8 horas', '7 días', 'Infección anaerobia y enfermedad periodontal'),
  ('Doxiciclina', '["Cápsulas 100 mg"]'::jsonb, '["oral"]'::jsonb, '100 mg', 'cada 24 horas', '10 días', 'Periodontitis agresiva'),
  ('Ibuprofeno', '["Tabletas 400 mg","Tabletas 600 mg","Suspensión 100 mg/5 ml"]'::jsonb, '["oral"]'::jsonb, '400 a 600 mg', 'cada 6 a 8 horas', '5 días', 'Dolor e inflamación'),
  ('Naproxeno', '["Tabletas 500 mg"]'::jsonb, '["oral"]'::jsonb, '500 mg', 'cada 12 horas', '5 días', 'Dolor e inflamación'),
  ('Ketoprofeno', '["Tabletas 100 mg"]'::jsonb, '["oral"]'::jsonb, '100 mg', 'cada 12 horas', '5 días', 'Dolor e inflamación postoperatoria'),
  ('Diclofenaco', '["Tabletas 50 mg","Gel 1 %"]'::jsonb, '["oral","topica"]'::jsonb, '50 mg', 'cada 8 horas', '5 días', 'Dolor e inflamación'),
  ('Celecoxib', '["Cápsulas 200 mg"]'::jsonb, '["oral"]'::jsonb, '200 mg', 'cada 12 horas', '5 días', 'Dolor e inflamación con riesgo gástrico'),
  ('Ketorolaco', '["Tabletas 10 mg","Solución inyectable 30 mg"]'::jsonb, '["oral","intramuscular"]'::jsonb, '10 a 30 mg', 'cada 6 a 8 horas', 'máximo 5 días', 'Dolor agudo moderado a severo'),
  ('Paracetamol', '["Tabletas 500 mg","Jarabe 120 mg/5 ml"]'::jsonb, '["oral"]'::jsonb, '500 mg a 1 g', 'cada 6 a 8 horas', '3 días', 'Dolor; alternativa sin antiinflamatorio'),
  ('Metamizol', '["Tabletas 500 mg","Solución inyectable 1 g"]'::jsonb, '["oral","intramuscular"]'::jsonb, '500 mg a 1 g', 'cada 8 horas', '3 días', 'Dolor moderado a intenso'),
  ('Tramadol', '["Cápsulas 50 mg","Solución inyectable 100 mg"]'::jsonb, '["oral","intramuscular"]'::jsonb, '50 mg', 'cada 8 horas', '3 días', 'Dolor severo que no cede a los antiinflamatorios'),
  ('Dexametasona', '["Tabletas 4 mg","Solución inyectable 8 mg"]'::jsonb, '["oral","intramuscular"]'::jsonb, '4 mg', 'cada 12 horas', '2 días', 'Inflamación postoperatoria'),
  ('Prednisona', '["Tabletas 50 mg"]'::jsonb, '["oral"]'::jsonb, '50 mg', 'cada 24 horas (en la mañana)', '3 días', 'Inflamación postoperatoria'),
  ('Clorhexidina', '["Enjuague 0,12 %","Gel 1 %"]'::jsonb, '["topica"]'::jsonb, '15 ml', 'enjuagues cada 12 horas', '7 días', 'Antiséptico; postoperatorio periodontal'),
  ('Nistatina', '["Suspensión 100.000 UI/ml"]'::jsonb, '["oral","topica"]'::jsonb, '1 ml', '4 veces al día', '14 días', 'Candidiasis oral'),
  ('Povidona yodada', '["Solución 10 %"]'::jsonb, '["topica"]'::jsonb, 'aplicación local', 'según necesidad', null, 'Antiséptico de la cavidad oral'),
  ('Fluoruro de sodio', '["Gel 1,23 %","Barniz 5 %"]'::jsonb, '["topica"]'::jsonb, 'aplicación profesional', 'cada 6 meses', null, 'Prevención de caries'),
  ('Lidocaína 2 % con epinefrina', '["Cartucho 1,8 ml (1:80.000)","Frasco 50 ml"]'::jsonb, '["intramuscular"]'::jsonb, '1 a 3 cartuchos', 'según la técnica anestésica', null, 'Anestesia local infiltrativa o troncular'),
  ('Mepivacaína 3 %', '["Cartucho 1,8 ml"]'::jsonb, '["intramuscular"]'::jsonb, '1 a 3 cartuchos', 'según la técnica anestésica', null, 'Anestesia local; paciente con contraindicación de vasoconstrictor'),
  ('Articaína 4 % con epinefrina', '["Cartucho 1,8 ml (1:100.000)"]'::jsonb, '["intramuscular"]'::jsonb, '1 a 3 cartuchos', 'según la técnica anestésica', null, 'Anestesia local en zonas inflamadas'),
  ('Benzocaína gel 20 %', '["Gel 20 %"]'::jsonb, '["topica"]'::jsonb, 'aplicación local', 'antes del procedimiento', null, 'Anestesia tópica de la mucosa');