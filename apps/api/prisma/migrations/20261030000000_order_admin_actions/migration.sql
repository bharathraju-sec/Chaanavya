-- Stage 13.13: limited staff actions on an order. A hold stops fulfilment moving forward until it is
-- released (the database refuses packing, packed or handed over on a held order, whoever writes it);
-- cancelling stays possible. Holds, releases and internal notes are kept in an append-only table, and
-- holds and releases also appear in the order event trail (kind 'hold', with a fixed reason code, never
-- the staff member's free text).

-- AlterTable
ALTER TABLE "order" ADD COLUMN "held_at" TIMESTAMPTZ(3),
ADD COLUMN "held_by" UUID;
ALTER TABLE "order" ADD CONSTRAINT "order_hold_complete" CHECK (("held_at" IS NULL) = ("held_by" IS NULL));

-- CreateTable
CREATE TABLE "order_admin_action" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_admin_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_admin_action_idempotency_key_key" ON "order_admin_action"("idempotency_key");
CREATE INDEX "order_admin_action_order_id_created_at_idx" ON "order_admin_action"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "order_admin_action" ADD CONSTRAINT "order_admin_action_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_admin_action" ADD CONSTRAINT "order_admin_action_kind" CHECK ("kind" IN ('hold', 'release', 'note'));
ALTER TABLE "order_admin_action" ADD CONSTRAINT "order_admin_action_body" CHECK (length(btrim("body")) BETWEEN 1 AND 1000);
ALTER TABLE "order_admin_action" ADD CONSTRAINT "order_admin_action_origin" CHECK (length("correlation_id") > 0);

CREATE TRIGGER "order_admin_action_append_only" BEFORE UPDATE OR DELETE ON "order_admin_action" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "order_admin_action_no_truncate" BEFORE TRUNCATE ON "order_admin_action" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();

-- Holds and releases join the order event trail.
ALTER TABLE "order_event" DROP CONSTRAINT "order_event_kind";
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_kind" CHECK ("kind" IN ('placed', 'status', 'fulfilment', 'payment', 'reservation', 'hold'));

-- A held order's fulfilment cannot move forward.
CREATE FUNCTION "refuse_fulfilment_while_held"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."held_at" IS NOT NULL AND NEW."fulfilment_status" IS DISTINCT FROM OLD."fulfilment_status" AND NEW."fulfilment_status" <> 'cancelled' THEN
    RAISE EXCEPTION 'order % is on hold: release it before moving fulfilment', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_fulfilment_hold" BEFORE UPDATE OF "fulfilment_status" ON "order" FOR EACH ROW EXECUTE FUNCTION "refuse_fulfilment_while_held"();
