-- Stage 13.14: order recovery cases. Order reconciliation finds orders and stock holds that are stuck (a
-- payment window long passed, a captured payment on an unconfirmed order, an overdue hold, an order and
-- hold that disagree, a review left waiting) and opens one case per order and kind for a person to look at.
-- A case never changes the order, its payments or its stock hold; it only records what was seen.

-- CreateTable
CREATE TABLE "order_recovery_case" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "facts" JSONB NOT NULL,
    "facts_key" CHAR(64) NOT NULL,
    "check" TEXT NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "resolution" TEXT,

    CONSTRAINT "order_recovery_case_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_recovery_case_status_detected_at_idx" ON "order_recovery_case"("status", "detected_at");
CREATE INDEX "order_recovery_case_order_id_idx" ON "order_recovery_case"("order_id");
-- One open case per order and kind: a repeated or overlapping run can never open a second.
CREATE UNIQUE INDEX "order_recovery_case_one_open" ON "order_recovery_case"("order_id", "kind") WHERE "status" = 'open';

-- AddForeignKey
ALTER TABLE "order_recovery_case" ADD CONSTRAINT "order_recovery_case_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_recovery_case" ADD CONSTRAINT "order_recovery_case_kind" CHECK ("kind" IN ('pending_past_window', 'captured_not_confirmed', 'hold_overdue', 'hold_mismatch', 'review_waiting'));
ALTER TABLE "order_recovery_case" ADD CONSTRAINT "order_recovery_case_status" CHECK ("status" IN ('open', 'resolved', 'cleared'));
-- A closed case says when; a resolved one also says who and why.
ALTER TABLE "order_recovery_case" ADD CONSTRAINT "order_recovery_case_closed" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL AND "closed_by" IS NULL AND "resolution" IS NULL)
    OR ("status" = 'cleared' AND "closed_at" IS NOT NULL AND "closed_by" IS NULL)
    OR ("status" = 'resolved' AND "closed_at" IS NOT NULL AND "closed_by" IS NOT NULL AND length(btrim(coalesce("resolution", ''))) >= 3)
);
-- Facts are redacted: an object without personal or secret keys.
ALTER TABLE "order_recovery_case" ADD CONSTRAINT "order_recovery_case_facts_redacted" CHECK (
    jsonb_typeof("facts") = 'object'
    AND NOT ("facts" ?| ARRAY['email', 'name', 'phone', 'address', 'shippingAddress', 'billingAddress', 'line1', 'line2', 'landmark', 'pinCode', 'submitKey', 'idempotencyKey', 'guestSessionId', 'token', 'cookie', 'otp', 'password', 'providerPaymentId', 'providerOrderId'])
);

-- A closed case stays closed: only open cases change, and nothing is deleted.
CREATE FUNCTION "order_recovery_case_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recovery cases are kept' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'open' THEN
    RAISE EXCEPTION 'a closed recovery case cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."order_id" <> OLD."order_id" OR NEW."kind" <> OLD."kind" OR NEW."detected_at" <> OLD."detected_at" THEN
    RAISE EXCEPTION 'a recovery case keeps its order, kind and detection time' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_recovery_case_guard" BEFORE UPDATE OR DELETE ON "order_recovery_case" FOR EACH ROW EXECUTE FUNCTION "order_recovery_case_guard"();
CREATE TRIGGER "order_recovery_case_no_truncate" BEFORE TRUNCATE ON "order_recovery_case" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();
