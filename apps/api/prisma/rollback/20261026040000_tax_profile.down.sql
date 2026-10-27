-- Rollback for 20261026040000_tax_profile (Stage 12.05). Removes the GST configuration; nothing else uses it yet.
DROP TRIGGER IF EXISTS tax_rate_frozen ON "tax_rate";
DROP TRIGGER IF EXISTS tax_profile_frozen ON "tax_profile";
DROP FUNCTION IF EXISTS tax_profile_frozen();
DROP TABLE IF EXISTS "tax_rate";
DROP TABLE IF EXISTS "tax_profile";
