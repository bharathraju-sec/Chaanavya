-- Rollback for 20261027000000_checkout_quote (Stage 12.09). Stored quotes are lost; bags, contacts and orders are untouched.
DROP TABLE IF EXISTS "checkout_quote";
