-- Stage 12.10: bind each stored checkout quote to its owner and to what it was priced from.
-- Quotes last 15 minutes and are disposable, so any quote stored before this change is removed
-- rather than given a made-up binding. Additive otherwise.
DELETE FROM "checkout_quote";

ALTER TABLE "checkout_quote" ADD COLUMN "owner_hash" CHAR(64) NOT NULL;
ALTER TABLE "checkout_quote" ADD COLUMN "fingerprint" CHAR(64) NOT NULL;
ALTER TABLE "checkout_quote" ADD COLUMN "fingerprint_version" INTEGER NOT NULL;
ALTER TABLE "checkout_quote" ADD COLUMN "parts" JSONB NOT NULL;

-- SHA-256 hex digests, a known version, and one digest per bound part.
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_digests" CHECK ("owner_hash" ~ '^[0-9a-f]{64}$' AND "fingerprint" ~ '^[0-9a-f]{64}$' AND "fingerprint_version" >= 1);
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_parts" CHECK (jsonb_typeof("parts") = 'object' AND "parts" ?& ARRAY['cart', 'price', 'promotion', 'address', 'delivery', 'tax']);
