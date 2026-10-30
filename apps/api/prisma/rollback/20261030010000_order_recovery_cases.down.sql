-- Rollback for 20261030010000_order_recovery_cases (Stage 13.14). Recovery cases are lost (their audit_event
-- rows remain); orders, payments and stock holds are untouched, since cases never changed them.
DROP TABLE IF EXISTS "order_recovery_case";
DROP FUNCTION IF EXISTS "order_recovery_case_guard"();
