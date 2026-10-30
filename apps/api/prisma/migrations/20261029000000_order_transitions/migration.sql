-- Stage 13.06: the database itself refuses an order status or fulfilment status move that is not a
-- transition of its state machine (packages/contracts/src/modules/state-machines.ts, ORDER_MACHINE and
-- FULFILMENT_MACHINE), whoever writes it. Guards (payment captured, stock allocated, staff approval and
-- the actor allowed to ask) are checked by the API (apps/api/src/db/transitions.ts); here the moves
-- themselves, and the two facts the row holds:
--   fulfilment may start (packing, packed, handed_over) only for a confirmed order: no unpaid shipping
--   an order may be completed only once its fulfilment was handed over to the courier
-- New rows are not checked here (orders are created pending_payment; earlier fixtures and imports may
-- be inserted in any state).
CREATE FUNCTION "reject_invalid_order_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text, NEW."status"::text) NOT IN (
       ('pending_payment', 'confirmed'),
       ('pending_payment', 'needs_review'),
       ('pending_payment', 'cancelled'),
       ('needs_review', 'confirmed'),
       ('needs_review', 'cancelled'),
       ('confirmed', 'cancelled'),
       ('confirmed', 'completed')) THEN
    RAISE EXCEPTION 'order status cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fulfilment_status" IS DISTINCT FROM OLD."fulfilment_status" AND (OLD."fulfilment_status"::text, NEW."fulfilment_status"::text) NOT IN (
       ('unfulfilled', 'packing'),
       ('packing', 'packed'),
       ('packed', 'handed_over'),
       ('unfulfilled', 'cancelled'),
       ('packing', 'cancelled'),
       ('packed', 'cancelled')) THEN
    RAISE EXCEPTION 'order fulfilment cannot move from % to %', OLD."fulfilment_status", NEW."fulfilment_status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fulfilment_status" IS DISTINCT FROM OLD."fulfilment_status" AND NEW."fulfilment_status"::text IN ('packing', 'packed', 'handed_over')
     AND NEW."status"::text NOT IN ('confirmed', 'completed') THEN
    RAISE EXCEPTION 'an order that is not confirmed cannot be fulfilled' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status"::text = 'completed' AND NEW."fulfilment_status"::text <> 'handed_over' THEN
    RAISE EXCEPTION 'an order is completed only after it was handed over to the courier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_transitions_only" BEFORE UPDATE OF "status", "fulfilment_status" ON "order" FOR EACH ROW EXECUTE FUNCTION "reject_invalid_order_transition"();
