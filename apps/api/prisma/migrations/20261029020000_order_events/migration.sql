-- Stage 13.08: the order event trail. One append-only timeline per order: its placement, and every
-- move of its status, its fulfilment, its payment attempts and its stock hold, each with who asked for
-- it (actor kind and id), the request it came from (correlation id), the rule it met, and a small
-- redacted context. The moves are recorded by the database itself, so no status can change without
-- leaving an event, and no status can change without an auditable origin: the writing transaction
-- must first declare its origin (set_config('chaanavya.origin', ...), apps/api/src/db/origin.ts), or
-- the change is refused. Nothing personal is ever stored here (no email, name, phone, address, guest
-- session, key or token).

-- CreateTable
CREATE TABLE "order_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "context" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "order_event_order_id_occurred_at_idx" ON "order_event"("order_id", "occurred_at");
CREATE INDEX "order_event_correlation_id_idx" ON "order_event"("correlation_id");
-- An order is placed once: a retried or raced placement can never add a second placement event.
CREATE UNIQUE INDEX "order_event_placed_once" ON "order_event"("order_id") WHERE "kind" = 'placed';

ALTER TABLE "order_event" ADD CONSTRAINT "order_event_kind" CHECK ("kind" IN ('placed', 'status', 'fulfilment', 'payment', 'reservation'));
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_origin" CHECK (length("correlation_id") > 0);
-- Redaction, enforced: the context is an object and carries none of the personal or secret keys.
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_context_redacted" CHECK (
    jsonb_typeof("context") = 'object'
    AND NOT ("context" ?| ARRAY['email', 'name', 'phone', 'address', 'shippingAddress', 'billingAddress', 'line1', 'line2', 'landmark', 'pinCode', 'submitKey', 'idempotencyKey', 'guestSessionId', 'token', 'cookie', 'otp', 'password'])
);

-- Append-only, like the audit trail and the stock ledger.
CREATE TRIGGER "order_event_append_only" BEFORE UPDATE OR DELETE ON "order_event" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "order_event_no_truncate" BEFORE TRUNCATE ON "order_event" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();

-- The origin the writing transaction declared, or a refusal.
CREATE FUNCTION "chaanavya_origin"() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  origin jsonb;
BEGIN
  BEGIN
    origin := nullif(current_setting('chaanavya.origin', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    origin := NULL;
  END;
  IF origin IS NULL OR coalesce(origin->>'actorKind', '') = '' OR coalesce(origin->>'correlationId', '') = '' THEN
    RAISE EXCEPTION 'no auditable origin: declare the actor and correlation id before changing a status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN origin;
END;
$$;

CREATE FUNCTION "record_order_event"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  origin jsonb;
BEGIN
  IF TG_TABLE_NAME = 'order' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      origin := "chaanavya_origin"();
      INSERT INTO "order_event" ("order_id", "kind", "subject_id", "from_state", "to_state", "actor_kind", "actor_id", "correlation_id", "reason")
      VALUES (NEW."id", 'status', NEW."id", OLD."status"::text, NEW."status"::text, (origin->>'actorKind')::"ActorKind", origin->>'actorId', origin->>'correlationId', coalesce(origin->>'reason', ''));
    END IF;
    IF NEW."fulfilment_status" IS DISTINCT FROM OLD."fulfilment_status" THEN
      origin := "chaanavya_origin"();
      INSERT INTO "order_event" ("order_id", "kind", "subject_id", "from_state", "to_state", "actor_kind", "actor_id", "correlation_id", "reason")
      VALUES (NEW."id", 'fulfilment', NEW."id", OLD."fulfilment_status"::text, NEW."fulfilment_status"::text, (origin->>'actorKind')::"ActorKind", origin->>'actorId', origin->>'correlationId', coalesce(origin->>'reason', ''));
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    origin := "chaanavya_origin"();
    INSERT INTO "order_event" ("order_id", "kind", "subject_id", "from_state", "to_state", "actor_kind", "actor_id", "correlation_id", "reason")
    VALUES (NEW."order_id", CASE TG_TABLE_NAME WHEN 'payment_attempt' THEN 'payment' ELSE 'reservation' END, NEW."id", OLD."status"::text, NEW."status"::text,
            (origin->>'actorKind')::"ActorKind", origin->>'actorId', origin->>'correlationId', coalesce(origin->>'reason', ''));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_event_on_order" AFTER UPDATE OF "status", "fulfilment_status" ON "order" FOR EACH ROW EXECUTE FUNCTION "record_order_event"();
CREATE TRIGGER "order_event_on_payment" AFTER UPDATE OF "status" ON "payment_attempt" FOR EACH ROW EXECUTE FUNCTION "record_order_event"();
CREATE TRIGGER "order_event_on_reservation" AFTER UPDATE OF "status" ON "inventory_reservation" FOR EACH ROW EXECUTE FUNCTION "record_order_event"();
