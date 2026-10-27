-- Rollback for 20261026020000_address_one_default (Stage 12.03). More than one default becomes possible again.
DROP INDEX IF EXISTS "address_one_default_per_user";
