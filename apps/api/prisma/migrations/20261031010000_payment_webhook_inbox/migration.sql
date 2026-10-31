-- Stage 14.10: the payment webhook inbox. Every verified provider event is kept once, by provider and event
-- id, with where it is in its processing, so a provider that delivers the same event again (Razorpay retries,
-- and sometimes delivers twice) changes nothing a second time. Only the normalized event is kept: never the
-- raw body or its signature.

-- CreateEnum
CREATE TYPE "WebhookInboxStatus" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateTable
CREATE TABLE "payment_webhook_inbox" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "event_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "provider_refund_id" TEXT,
    "amount_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "WebhookInboxStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_id" UUID,
    "locked_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "conflict_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_webhook_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_inbox_provider_event_id_key" ON "payment_webhook_inbox"("provider", "event_id");

-- CreateIndex
CREATE INDEX "payment_webhook_inbox_status_next_attempt_at_idx" ON "payment_webhook_inbox"("status", "next_attempt_at");

-- What an event can be: one we act on, for a positive amount in INR, with a processing count that never goes
-- below zero, and a claim (claim id and lease) only while it is being processed.
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_type_known" CHECK ("type" IN ('payment.authorized', 'payment.captured', 'payment.failed', 'refund.processed', 'refund.failed'));
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_amount_inr" CHECK ("amount_paise" > 0 AND "currency" = 'INR');
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_ids_present" CHECK (length(btrim("event_id")) > 0 AND length(btrim("fingerprint")) > 0 AND length(btrim("provider_order_id")) > 0);
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_attempts_non_negative" CHECK ("attempts" >= 0);
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_claim_while_processing" CHECK (("status" = 'processing') = ("claim_id" IS NOT NULL AND "locked_until" IS NOT NULL));
ALTER TABLE "payment_webhook_inbox" ADD CONSTRAINT "payment_webhook_inbox_processed_has_time" CHECK (("status" = 'processed') = ("processed_at" IS NOT NULL));

-- The event's own fields never change; status only moves forward; a conflicting delivery is noted once.
--   received   -> processing (claimed)
--   processing -> processing (a lapsed claim taken over), received (retry later), processed, failed
--   processed and failed are final
CREATE FUNCTION "payment_webhook_inbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider" <> OLD."provider" OR NEW."event_id" <> OLD."event_id" OR NEW."fingerprint" <> OLD."fingerprint"
     OR NEW."type" <> OLD."type" OR NEW."provider_order_id" <> OLD."provider_order_id"
     OR NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" OR NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id"
     OR NEW."amount_paise" <> OLD."amount_paise" OR NEW."currency" <> OLD."currency" OR NEW."occurred_at" <> OLD."occurred_at"
     OR NEW."received_at" <> OLD."received_at" THEN
    RAISE EXCEPTION 'a webhook event is kept as it was received' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."conflict_at" IS NOT NULL AND NEW."conflict_at" IS DISTINCT FROM OLD."conflict_at" THEN
    RAISE EXCEPTION 'a webhook event''s conflict is noted once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'a webhook event''s processing count never goes back' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."claim_id" IS DISTINCT FROM OLD."claim_id" THEN
    IF OLD."status" IN ('processed', 'failed') THEN
      RAISE EXCEPTION 'a webhook event that is % stays so', OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'received' AND NEW."status" <> 'processing' THEN
      RAISE EXCEPTION 'a received webhook event can only be claimed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_webhook_inbox_guard" BEFORE UPDATE ON "payment_webhook_inbox" FOR EACH ROW EXECUTE FUNCTION "payment_webhook_inbox_guard"();

-- Events are kept: they explain every payment.
CREATE FUNCTION "payment_webhook_inbox_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook events are kept' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "payment_webhook_inbox_kept" BEFORE DELETE ON "payment_webhook_inbox" FOR EACH ROW EXECUTE FUNCTION "payment_webhook_inbox_kept"();
