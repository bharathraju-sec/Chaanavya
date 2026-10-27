-- Rollback for 20261027010000_quote_fingerprint (Stage 12.10). Stored quotes lose their binding, so they are removed too.
DELETE FROM "checkout_quote";
ALTER TABLE "checkout_quote" DROP CONSTRAINT IF EXISTS "checkout_quote_parts";
ALTER TABLE "checkout_quote" DROP CONSTRAINT IF EXISTS "checkout_quote_digests";
ALTER TABLE "checkout_quote" DROP COLUMN IF EXISTS "parts";
ALTER TABLE "checkout_quote" DROP COLUMN IF EXISTS "fingerprint_version";
ALTER TABLE "checkout_quote" DROP COLUMN IF EXISTS "fingerprint";
ALTER TABLE "checkout_quote" DROP COLUMN IF EXISTS "owner_hash";
