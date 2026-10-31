-- Rollback for 20261031000000_payment_attempt_identity (Stage 14.03). Attempts stay as they are; only the
-- identity rules are removed.
DROP TRIGGER IF EXISTS "payment_attempt_kept" ON "payment_attempt";
DROP FUNCTION IF EXISTS "payment_attempt_kept"();
DROP TRIGGER IF EXISTS "payment_attempt_identity_fixed" ON "payment_attempt";
DROP FUNCTION IF EXISTS "payment_attempt_identity_fixed"();
DROP TRIGGER IF EXISTS "payment_attempt_matches_order" ON "payment_attempt";
DROP FUNCTION IF EXISTS "payment_attempt_matches_order"();
DROP INDEX IF EXISTS "payment_attempt_one_open_per_order";
ALTER TABLE "payment_attempt" DROP CONSTRAINT IF EXISTS "payment_attempt_key_present";
ALTER TABLE "payment_attempt" DROP CONSTRAINT IF EXISTS "payment_attempt_currency_inr";
