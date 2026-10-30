-- Rollback for 20261028010000_order_one_per_quote (Stage 13.02). Orders are kept; a quote could then place more than one.
DROP INDEX IF EXISTS "order_one_per_quote";
