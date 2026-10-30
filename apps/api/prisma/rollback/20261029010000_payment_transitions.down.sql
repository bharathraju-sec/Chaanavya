-- Rollback for 20261029010000_payment_transitions (Stage 13.07). The database stops checking payment status
-- moves and allows an order's status and fulfilment to change together; the API still checks both.
DROP TRIGGER IF EXISTS "order_status_and_fulfilment_apart" ON "order";
DROP FUNCTION IF EXISTS "reject_joint_order_and_fulfilment_change"();
DROP TRIGGER IF EXISTS "payment_transitions_only" ON "payment_attempt";
DROP FUNCTION IF EXISTS "reject_invalid_payment_transition"();
