-- Rollback for 20261025000000_cart_requests (Stage 11.04). Loses the record of which adds were
-- already applied, so a retried add after the rollback could count twice. Carts and lines stay.
DROP TABLE IF EXISTS "cart_request";
