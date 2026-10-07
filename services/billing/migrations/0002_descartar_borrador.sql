ALTER TABLE "invoices" DROP CONSTRAINT "chk_invoices_issued";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_issued" CHECK ("invoices"."status" in ('borrador', 'anulada') or (
        "invoices"."invoice_number" is not null and "invoices"."exchange_rate_micros" is not null
        and "invoices"."issued_at" is not null and "invoices"."pdf_path" is not null));