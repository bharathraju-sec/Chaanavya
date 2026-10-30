-- Rollback for 20261030000000_order_admin_actions (Stage 13.13). Holds, releases and notes are lost (their
-- audit_event rows remain); hold events already in the order event trail must be kept, so the widened kind
-- check stays when any exist.
DROP TRIGGER IF EXISTS "order_fulfilment_hold" ON "order";
DROP FUNCTION IF EXISTS "refuse_fulfilment_while_held"();
DROP TABLE IF EXISTS "order_admin_action";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_hold_complete";
ALTER TABLE "order" DROP COLUMN IF EXISTS "held_by", DROP COLUMN IF EXISTS "held_at";
