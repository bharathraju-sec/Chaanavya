-- Rollback for 20261031020000_payment_reconciliation (Stage 14.14). The job's check history is lost; payment
-- attempts and orders are untouched, since the job moves them only through their own checked code.
DROP TABLE IF EXISTS "payment_reconciliation";
DROP FUNCTION IF EXISTS "payment_reconciliation_guard"();
