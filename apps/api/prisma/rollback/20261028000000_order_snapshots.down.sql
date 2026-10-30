-- Rollback for 20261028000000_order_snapshots (Stage 13.01). Orders lose their customer, tax and delivery
-- snapshots and their quote fingerprint, and the order row is no longer protected from edits. The line
-- snapshot trigger goes back to its Stage 08 form.
DROP TRIGGER IF EXISTS "order_snapshot_immutable" ON "order";
DROP FUNCTION IF EXISTS "reject_order_snapshot_change"();

CREATE OR REPLACE FUNCTION "reject_order_item_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."order_id", NEW."sku", NEW."product_title", NEW."variant_title", NEW."handle", NEW."image_url", NEW."hsn_code", NEW."quantity",
      NEW."unit_price_paise", NEW."discount_paise", NEW."tax_paise", NEW."tax_lines", NEW."line_total_paise", NEW."currency", NEW."created_at")
     IS DISTINCT FROM
     (OLD."order_id", OLD."sku", OLD."product_title", OLD."variant_title", OLD."handle", OLD."image_url", OLD."hsn_code", OLD."quantity",
      OLD."unit_price_paise", OLD."discount_paise", OLD."tax_paise", OLD."tax_lines", OLD."line_total_paise", OLD."currency", OLD."created_at")
     OR (NEW."variant_id" IS DISTINCT FROM OLD."variant_id" AND NEW."variant_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'order_item is a purchase snapshot: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "order_item" DROP CONSTRAINT IF EXISTS "order_item_tax_classification_shape";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_shipping_snapshot_shape";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_tax_snapshot_shape";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_customer_snapshot_shape";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_quote_snapshots_complete";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_number_format";
ALTER TABLE "order_item" DROP COLUMN IF EXISTS "tax_classification";
ALTER TABLE "order" DROP COLUMN IF EXISTS "quote_fingerprint";
ALTER TABLE "order" DROP COLUMN IF EXISTS "shipping_snapshot";
ALTER TABLE "order" DROP COLUMN IF EXISTS "tax_snapshot";
ALTER TABLE "order" DROP COLUMN IF EXISTS "customer_snapshot";
