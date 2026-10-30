-- Stage 13.07: payment and fulfilment are separate states, moved by separate events.
--   A payment attempt's status moves only along the payment state machine
--   (packages/contracts/src/modules/state-machines.ts, PAYMENT_MACHINE), whoever writes it.
--   An order's financial status and its fulfilment never change in the same write: a payment
--   outcome can confirm (or cancel, or send for review) an order, and packing and shipping are
--   later, separate moves. So no single payment callback can mark an order shipped.
-- New rows are not checked here (attempts are created in "created").
CREATE FUNCTION "reject_invalid_payment_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text, NEW."status"::text) NOT IN (
       ('created', 'authorized'),
       ('created', 'captured'),
       ('created', 'failed'),
       ('created', 'expired'),
       ('created', 'pending_reconciliation'),
       ('authorized', 'captured'),
       ('authorized', 'expired'),
       ('authorized', 'pending_reconciliation'),
       ('pending_reconciliation', 'authorized'),
       ('pending_reconciliation', 'captured'),
       ('pending_reconciliation', 'failed'),
       ('pending_reconciliation', 'expired'),
       ('captured', 'partially_refunded'),
       ('captured', 'refunded'),
       ('partially_refunded', 'refunded')) THEN
    RAISE EXCEPTION 'payment status cannot move from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_transitions_only" BEFORE UPDATE OF "status" ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "reject_invalid_payment_transition"();

CREATE FUNCTION "reject_joint_order_and_fulfilment_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."fulfilment_status" IS DISTINCT FROM OLD."fulfilment_status" THEN
    RAISE EXCEPTION 'an order''s status and its fulfilment change in separate steps' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_status_and_fulfilment_apart" BEFORE UPDATE OF "status", "fulfilment_status" ON "order" FOR EACH ROW EXECUTE FUNCTION "reject_joint_order_and_fulfilment_change"();
