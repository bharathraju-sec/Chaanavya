-- Stage 14.14: what the payment reconciliation job knows about each payment attempt it asks the provider about,
-- so it backs off between checks, stays within the provider's rate limits, and keeps the last recoverable error
-- for staff. It records questions and answers only; payments and orders move through their own checked code.

-- CreateTable
CREATE TABLE "payment_reconciliation" (
    "attempt_id" UUID NOT NULL,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_outcome" TEXT,
    "last_error" TEXT,
    "next_check_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reconciliation_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateIndex
CREATE INDEX "payment_reconciliation_next_check_at_idx" ON "payment_reconciliation"("next_check_at");

-- AddForeignKey
ALTER TABLE "payment_reconciliation" ADD CONSTRAINT "payment_reconciliation_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A known outcome, a short error, and a count that never goes back.
ALTER TABLE "payment_reconciliation" ADD CONSTRAINT "payment_reconciliation_checks_non_negative" CHECK ("checks" >= 0);
ALTER TABLE "payment_reconciliation" ADD CONSTRAINT "payment_reconciliation_outcome_known" CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('captured_applied', 'capture_rejected', 'closed_failed', 'closed_expired', 'still_open', 'in_flight', 'provider_unavailable', 'provider_error'));
ALTER TABLE "payment_reconciliation" ADD CONSTRAINT "payment_reconciliation_error_short" CHECK ("last_error" IS NULL OR length("last_error") <= 300);

CREATE FUNCTION "payment_reconciliation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment reconciliation records are kept' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."attempt_id" <> OLD."attempt_id" OR NEW."created_at" <> OLD."created_at" OR NEW."checks" < OLD."checks" THEN
    RAISE EXCEPTION 'a payment reconciliation record keeps its attempt, its start and its count' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_reconciliation_guard" BEFORE UPDATE OR DELETE ON "payment_reconciliation" FOR EACH ROW EXECUTE FUNCTION "payment_reconciliation_guard"();
