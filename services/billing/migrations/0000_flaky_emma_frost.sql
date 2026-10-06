CREATE SEQUENCE "public"."credit_note_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."invoice_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."receipt_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"is_special_taxpayer" boolean DEFAULT false NOT NULL,
	"spe_notified_at" date,
	"spe_reference" text,
	"imputation_policy" text DEFAULT 'tasa_del_pago' NOT NULL,
	"rate_grace_days" integer DEFAULT 5 NOT NULL,
	"foreign_currency_iva_basis_points" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "chk_billing_settings_single_row" CHECK ("billing_settings"."id" = 1),
	CONSTRAINT "chk_billing_settings_imputation" CHECK ("billing_settings"."imputation_policy" in ('tasa_del_pago', 'tasa_de_la_factura')),
	CONSTRAINT "chk_billing_settings_extra_iva" CHECK ("billing_settings"."foreign_currency_iva_basis_points" between 0 and 10000),
	CONSTRAINT "chk_billing_settings_grace" CHECK ("billing_settings"."rate_grace_days" between 0 and 60)
);
--> statement-breakpoint
CREATE TABLE "credit_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_item_id" uuid,
	"description" text NOT NULL,
	"total_cents_usd" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_number" integer NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_number" integer NOT NULL,
	"invoice_issued_at" timestamp with time zone NOT NULL,
	"invoice_total_cents_usd" integer NOT NULL,
	"kind" text DEFAULT 'total' NOT NULL,
	"reason" text NOT NULL,
	"total_cents_usd" integer NOT NULL,
	"exchange_rate_micros" bigint NOT NULL,
	"total_ves_centimos" bigint NOT NULL,
	"pdf_path" text,
	"pdf_sha256" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_by_username" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_credit_notes_total" CHECK ("credit_notes"."total_cents_usd" > 0),
	CONSTRAINT "chk_credit_notes_kind" CHECK ("credit_notes"."kind" in ('total', 'parcial')),
	CONSTRAINT "chk_credit_notes_reference" CHECK ("credit_notes"."invoice_number" > 0 and "credit_notes"."invoice_total_cents_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_date" date NOT NULL,
	"rate_micros" bigint NOT NULL,
	"source" text NOT NULL,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"raw_payload" jsonb,
	"note" text,
	"set_by_user_id" uuid,
	"set_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_exchange_rates_positive" CHECK ("exchange_rates"."rate_micros" > 0),
	CONSTRAINT "chk_exchange_rates_source" CHECK ("exchange_rates"."source" in ('bcv_oficial', 'manual', 'arrastre'))
);
--> statement-breakpoint
CREATE TABLE "fiscal_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"control_from" text NOT NULL,
	"control_to" text NOT NULL,
	"next_control" text NOT NULL,
	"printer_name" text NOT NULL,
	"printer_rif" text NOT NULL,
	"authorization_ref" text NOT NULL,
	"authorization_date" date NOT NULL,
	"print_date" date NOT NULL,
	"received_at" timestamp with time zone,
	"spoiled_count" integer DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	CONSTRAINT "chk_fiscal_forms_spoiled" CHECK ("fiscal_forms"."spoiled_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"catalog_id" uuid,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"tooth_number" integer,
	"surfaces" jsonb,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents_usd" integer NOT NULL,
	"total_price_cents_usd" integer NOT NULL,
	"tax_category" text NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 0 NOT NULL,
	"iva_amount_cents_usd" integer DEFAULT 0 NOT NULL,
	"needs_pricing" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chk_invoice_items_quantity" CHECK ("invoice_items"."quantity" > 0),
	CONSTRAINT "chk_invoice_items_total" CHECK ("invoice_items"."total_price_cents_usd" = "invoice_items"."unit_price_cents_usd" * "invoice_items"."quantity"),
	CONSTRAINT "chk_invoice_items_tax" CHECK ("invoice_items"."tax_category" in ('exento', 'general'))
);
--> statement-breakpoint
CREATE TABLE "invoice_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series" text NOT NULL,
	"numbering_mode" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_series_series_unique" UNIQUE("series")
);
--> statement-breakpoint
CREATE TABLE "invoice_sessions" (
	"invoice_id" uuid NOT NULL,
	"clinical_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series" text DEFAULT 'A' NOT NULL,
	"invoice_number" integer,
	"control_number" text,
	"fiscal_form_id" uuid,
	"status" text DEFAULT 'borrador' NOT NULL,
	"patient_id" uuid NOT NULL,
	"patient_name" text NOT NULL,
	"patient_doc_type" text NOT NULL,
	"patient_doc_number" text NOT NULL,
	"patient_tax_id" text,
	"patient_fiscal_address" text,
	"rate_at_draft_micros" bigint,
	"exchange_rate_micros" bigint,
	"exempt_amount_cents_usd" integer DEFAULT 0 NOT NULL,
	"taxable_amount_cents_usd" integer DEFAULT 0 NOT NULL,
	"iva_amount_cents_usd" integer DEFAULT 0 NOT NULL,
	"total_cents_usd" integer NOT NULL,
	"balance_cents_usd" integer NOT NULL,
	"exempt_amount_ves_centimos" bigint DEFAULT 0 NOT NULL,
	"taxable_amount_ves_centimos" bigint DEFAULT 0 NOT NULL,
	"iva_amount_ves_centimos" bigint DEFAULT 0 NOT NULL,
	"total_ves_centimos" bigint DEFAULT 0 NOT NULL,
	"pdf_path" text,
	"pdf_sha256" text,
	"generated_at" timestamp with time zone,
	"print_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by_user_id" uuid,
	"voided_by_username" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_by_username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	CONSTRAINT "chk_invoices_status" CHECK ("invoices"."status" in ('borrador', 'emitida', 'parcial', 'pagada', 'anulada')),
	CONSTRAINT "chk_invoices_issued" CHECK ("invoices"."status" = 'borrador' or (
        "invoices"."invoice_number" is not null and "invoices"."exchange_rate_micros" is not null
        and "invoices"."issued_at" is not null and "invoices"."pdf_path" is not null)),
	CONSTRAINT "chk_invoices_totals" CHECK ("invoices"."exempt_amount_cents_usd" + "invoices"."taxable_amount_cents_usd" + "invoices"."iva_amount_cents_usd"
        = "invoices"."total_cents_usd"),
	CONSTRAINT "chk_invoices_balance" CHECK ("invoices"."balance_cents_usd" between 0 and "invoices"."total_cents_usd"),
	CONSTRAINT "chk_invoices_status_balance" CHECK (("invoices"."status" = 'emitida' and "invoices"."balance_cents_usd" = "invoices"."total_cents_usd")
        or ("invoices"."status" = 'parcial' and "invoices"."balance_cents_usd" > 0
            and "invoices"."balance_cents_usd" < "invoices"."total_cents_usd")
        or ("invoices"."status" = 'pagada' and "invoices"."balance_cents_usd" = 0)
        or "invoices"."status" in ('borrador', 'anulada')),
	CONSTRAINT "chk_invoices_void_reason" CHECK ("invoices"."status" <> 'anulada' or "invoices"."void_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"receipt_number" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"tendered_amount" bigint NOT NULL,
	"tendered_currency" text NOT NULL,
	"amount_cents_usd" integer NOT NULL,
	"exchange_rate_micros" bigint NOT NULL,
	"imputation_policy" text NOT NULL,
	"fx_difference_cents_usd" integer DEFAULT 0 NOT NULL,
	"applies_igtf" boolean DEFAULT false NOT NULL,
	"igtf_basis_points" integer DEFAULT 0 NOT NULL,
	"igtf_perceived_by" text,
	"igtf_amount_cents_usd" integer DEFAULT 0 NOT NULL,
	"igtf_amount_ves_centimos" bigint DEFAULT 0 NOT NULL,
	"pdf_path" text,
	"pdf_sha256" text,
	"print_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone,
	"received_by_user_id" uuid NOT NULL,
	"received_by_username" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by_user_id" uuid,
	CONSTRAINT "chk_payments_method" CHECK ("payments"."method" in ('cash_usd', 'cash_ves', 'pago_movil', 'transfer_ves', 'pos_debit', 'pos_credit', 'card_usd', 'transfer_usd_local', 'zelle', 'crypto_usdt', 'international_wire', 'other')),
	CONSTRAINT "chk_payments_currency" CHECK ("payments"."tendered_currency" in ('USD', 'VES')),
	CONSTRAINT "chk_payments_imputation" CHECK ("payments"."imputation_policy" in ('tasa_del_pago', 'tasa_de_la_factura')),
	CONSTRAINT "chk_payments_amount" CHECK ("payments"."amount_cents_usd" > 0),
	CONSTRAINT "chk_payments_igtf_consistency" CHECK (("payments"."applies_igtf" = false and "payments"."igtf_amount_cents_usd" = 0
            and "payments"."igtf_perceived_by" is null)
        or ("payments"."applies_igtf" = true and "payments"."igtf_amount_cents_usd" >= 0
            and "payments"."igtf_perceived_by" in ('clinica', 'banco', 'no_aplica'))),
	CONSTRAINT "chk_payments_void_reason" CHECK ("payments"."voided_at" is null or "payments"."void_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'servicio' NOT NULL,
	"price_cents_usd" integer NOT NULL,
	"tax_category" text DEFAULT 'exento' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "treatment_catalog_code_unique" UNIQUE("code"),
	CONSTRAINT "chk_catalog_price" CHECK ("treatment_catalog"."price_cents_usd" >= 0),
	CONSTRAINT "chk_catalog_tax" CHECK ("treatment_catalog"."tax_category" in ('exento', 'general')),
	CONSTRAINT "chk_catalog_kind" CHECK ("treatment_catalog"."kind" in ('servicio', 'bien'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope" jsonb NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"producer" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_forms" ADD CONSTRAINT "fiscal_forms_series_id_invoice_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."invoice_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_catalog_id_treatment_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."treatment_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_sessions" ADD CONSTRAINT "invoice_sessions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fiscal_form_id_fiscal_forms_id_fk" FOREIGN KEY ("fiscal_form_id") REFERENCES "public"."fiscal_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credit_note_items_note" ON "credit_note_items" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_notes_number" ON "credit_notes" USING btree ("credit_note_number");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_invoice" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_exchange_rates_day" ON "exchange_rates" USING btree ("rate_date") WHERE "exchange_rates"."superseded_by_id" is null;--> statement-breakpoint
CREATE INDEX "idx_exchange_rates_date" ON "exchange_rates" USING btree ("rate_date");--> statement-breakpoint
CREATE INDEX "idx_fiscal_forms_series" ON "fiscal_forms" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_items_invoice" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_sessions_session" ON "invoice_sessions" USING btree ("clinical_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_sessions_pair" ON "invoice_sessions" USING btree ("invoice_id","clinical_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoices_number" ON "invoices" USING btree ("series","invoice_number");--> statement-breakpoint
CREATE INDEX "idx_invoices_status_created" ON "invoices" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_invoices_patient" ON "invoices" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payments_receipt" ON "payments" USING btree ("receipt_number");--> statement-breakpoint
CREATE INDEX "idx_payments_invoice" ON "payments" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payments_igtf" ON "payments" USING btree ("applies_igtf","created_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_pending" ON "outbox_events" USING btree ("published_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_aggregate" ON "outbox_events" USING btree ("aggregate_id");