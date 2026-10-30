-- Rollback for 20261029020000_order_events (Stage 13.08). The order event trail is lost (the audit_event
-- rows written by the API remain), and status changes no longer need a declared origin.
DROP TRIGGER IF EXISTS "order_event_on_reservation" ON "inventory_reservation";
DROP TRIGGER IF EXISTS "order_event_on_payment" ON "payment_attempt";
DROP TRIGGER IF EXISTS "order_event_on_order" ON "order";
DROP FUNCTION IF EXISTS "record_order_event"();
DROP FUNCTION IF EXISTS "chaanavya_origin"();
DROP TABLE IF EXISTS "order_event";
