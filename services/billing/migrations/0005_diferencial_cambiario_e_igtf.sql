ALTER TABLE "billing_settings" ADD COLUMN "igtf_rate_bp" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "cancellation_type" text DEFAULT 'ADMINISTRATIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "reversed_exchange_diff_ves_centimos" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "effective_date" date;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "historical_amount_ves_centimos" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exchange_diff_ves_centimos" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "igtf_collected_currency" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "igtf_payment_method" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "igtf_payment_reference" text;--> statement-breakpoint
-- Backfill (ADR 0069): los cobros previos se declaran con **diferencial cero** — son de la época en
-- que no se descomponía—: la Fecha Valor es el día de Caracas en que se registraron, y lo histórico
-- es lo recibido en Bs. (o, en divisas, lo imputado valorado a la tasa congelada de la factura).
UPDATE "payments" p SET
  "effective_date" = (p."created_at" AT TIME ZONE 'America/Caracas')::date,
  "historical_amount_ves_centimos" = CASE
    WHEN p."tendered_currency" = 'VES' THEN p."tendered_amount"
    ELSE round(p."amount_cents_usd" * coalesce(i."exchange_rate_micros", 0) / 1000000.0)::bigint
  END,
  "exchange_diff_ves_centimos" = 0
FROM "invoices" i
WHERE p."invoice_id" = i."id";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "effective_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "chk_billing_settings_igtf" CHECK ("billing_settings"."igtf_rate_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "chk_credit_notes_cancellation" CHECK ("credit_notes"."cancellation_type" in ('ADMINISTRATIVE', 'REFUND'));--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "chk_credit_notes_reversal" CHECK ("credit_notes"."cancellation_type" = 'REFUND'
        or "credit_notes"."reversed_exchange_diff_ves_centimos" = 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_igtf_currency" CHECK ("payments"."igtf_collected_currency" is null
        or "payments"."igtf_collected_currency" in ('USD', 'VES'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_igtf_destino" CHECK ("payments"."igtf_collected_currency" is null
        or ("payments"."applies_igtf" = true and "payments"."igtf_perceived_by" = 'clinica'));