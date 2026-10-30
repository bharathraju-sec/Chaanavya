-- Rollback for 20261029000000_order_transitions (Stage 13.06). The database stops checking order status and
-- fulfilment moves; the API's transition functions still check them.
DROP TRIGGER IF EXISTS "order_transitions_only" ON "order";
DROP FUNCTION IF EXISTS "reject_invalid_order_transition"();
