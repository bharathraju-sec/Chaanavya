-- Stage 14.03: a payment attempt keeps one stable identity. It is created for its order's own total, in
-- the order's currency (INR); its order, provider, mode, amount, currency, idempotency key and creation time
-- never change afterwards; the provider's references are written once and never replaced; and an order
-- has at most one attempt in progress at a time, so a retried or doubled checkout finds the same attempt.

ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_currency_inr" CHECK ("currency" = 'INR');
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_key_present" CHECK (length(btrim("idempotency_key")) > 0);

-- One attempt in progress per order (created, authorized, or waiting for its outcome).
CREATE UNIQUE INDEX "payment_attempt_one_open_per_order" ON "payment_attempt"("order_id") WHERE "status" IN ('created', 'authorized', 'pending_reconciliation');

-- An attempt asks for exactly what its order costs, in the order's currency.
CREATE FUNCTION "payment_attempt_matches_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total BIGINT;
  order_currency CHAR(3);
BEGIN
  SELECT "grand_total_paise", "currency" INTO total, order_currency FROM "order" WHERE "id" = NEW."order_id";
  IF NEW."amount_paise" IS DISTINCT FROM total OR NEW."currency" IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'a payment attempt must ask for its order''s total in the order''s currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_attempt_matches_order" BEFORE INSERT ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_attempt_matches_order"();

-- Identity never changes; the provider's references are set once.
CREATE FUNCTION "payment_attempt_identity_fixed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."order_id" <> OLD."order_id" OR NEW."provider" <> OLD."provider" OR NEW."mode" <> OLD."mode"
     OR NEW."amount_paise" <> OLD."amount_paise" OR NEW."currency" <> OLD."currency"
     OR NEW."idempotency_key" <> OLD."idempotency_key" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'a payment attempt keeps its order, provider, mode, amount, currency, key and creation time' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."provider_order_id" IS NOT NULL AND NEW."provider_order_id" IS DISTINCT FROM OLD."provider_order_id" THEN
    RAISE EXCEPTION 'a payment attempt''s provider order reference is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."provider_payment_id" IS NOT NULL AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" THEN
    RAISE EXCEPTION 'a payment attempt''s provider payment reference is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_attempt_identity_fixed" BEFORE UPDATE ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_attempt_identity_fixed"();

-- Attempts are kept: their history explains every payment.
CREATE FUNCTION "payment_attempt_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment attempts are kept' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "payment_attempt_kept" BEFORE DELETE ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "payment_attempt_kept"();
