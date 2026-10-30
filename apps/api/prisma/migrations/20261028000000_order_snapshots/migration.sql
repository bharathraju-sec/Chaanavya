-- Stage 13.01: order identifiers and immutable snapshots. An order placed from a checkout quote keeps
-- everything it was sold on: who bought it, each line's tax classification, the tax basis, the
-- delivery option and its GST, and the quote it came from. Once placed, nothing the shopper was
-- charged or told can change; only the order's status, fulfilment status and account links move.
-- Additive: existing orders (Stage 04 fixtures, any Shopify imports) keep NULL snapshots.

-- AlterTable
ALTER TABLE "order" ADD COLUMN "customer_snapshot" JSONB;
ALTER TABLE "order" ADD COLUMN "tax_snapshot" JSONB;
ALTER TABLE "order" ADD COLUMN "shipping_snapshot" JSONB;
ALTER TABLE "order" ADD COLUMN "quote_fingerprint" CHAR(64);
ALTER TABLE "order_item" ADD COLUMN "tax_classification" JSONB;

-- Identifiers: the public number is CHV- and at least six digits (the sequence starts at 100001); the
-- id is a UUID. An order from a quote names the quote and its fingerprint (Stage 12.10).
ALTER TABLE "order" ADD CONSTRAINT "order_number_format" CHECK ("number" ~ '^CHV-[0-9]{6,}$');
ALTER TABLE "order" ADD CONSTRAINT "order_quote_snapshots_complete" CHECK (
    "quote_fingerprint" IS NULL
    OR ("quote_fingerprint" ~ '^[0-9a-f]{64}$' AND "quote_ref" IS NOT NULL
        AND "customer_snapshot" IS NOT NULL AND "tax_snapshot" IS NOT NULL AND "shipping_snapshot" IS NOT NULL)
);
ALTER TABLE "order" ADD CONSTRAINT "order_customer_snapshot_shape" CHECK (
    "customer_snapshot" IS NULL
    OR (jsonb_typeof("customer_snapshot") = 'object' AND "customer_snapshot" ?& ARRAY['kind', 'email', 'name', 'phone']
        AND "customer_snapshot"->>'kind' IN ('guest', 'customer') AND "customer_snapshot"->>'email' = "email")
);
ALTER TABLE "order" ADD CONSTRAINT "order_tax_snapshot_shape" CHECK (
    "tax_snapshot" IS NULL
    OR (jsonb_typeof("tax_snapshot") = 'object'
        AND "tax_snapshot" ?& ARRAY['taxProfileId', 'profileApproved', 'supply', 'sellerStateCode', 'deliveryStateCode', 'pricesIncludeTax', 'rounding']
        AND ("tax_snapshot"->>'pricesIncludeTax')::boolean = "prices_include_tax")
);
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_snapshot_shape" CHECK (
    "shipping_snapshot" IS NULL
    OR (jsonb_typeof("shipping_snapshot") = 'object'
        AND "shipping_snapshot" ?& ARRAY['serviceRef', 'courierName', 'mode', 'fee', 'tax', 'total', 'ratesMode']
        AND ("shipping_snapshot"->'fee'->>'amountPaise')::bigint = "shipping_fee_paise")
);
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_tax_classification_shape" CHECK (
    "tax_classification" IS NULL
    OR (jsonb_typeof("tax_classification") = 'object'
        AND "tax_classification" ?& ARRAY['taxProfileId', 'taxCategory', 'hsnCode', 'rateBasisPoints', 'supply', 'rounding'])
);

-- The line's tax classification joins the frozen line snapshot (CHV-S04-003, CHV-S08-005).
CREATE OR REPLACE FUNCTION "reject_order_item_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."order_id", NEW."sku", NEW."product_title", NEW."variant_title", NEW."handle", NEW."image_url", NEW."hsn_code", NEW."quantity",
      NEW."unit_price_paise", NEW."discount_paise", NEW."tax_paise", NEW."tax_lines", NEW."line_total_paise", NEW."currency", NEW."created_at",
      NEW."tax_classification")
     IS DISTINCT FROM
     (OLD."order_id", OLD."sku", OLD."product_title", OLD."variant_title", OLD."handle", OLD."image_url", OLD."hsn_code", OLD."quantity",
      OLD."unit_price_paise", OLD."discount_paise", OLD."tax_paise", OLD."tax_lines", OLD."line_total_paise", OLD."currency", OLD."created_at",
      OLD."tax_classification")
     OR (NEW."variant_id" IS DISTINCT FROM OLD."variant_id" AND NEW."variant_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'order_item is a purchase snapshot: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- The order itself is a snapshot too. Only these may change after it is placed:
--   status, fulfilment_status, updated_at      the order's life cycle (state machines, Stage 02)
--   user_id from NULL to an account            a guest claims the order (Stage 07)
--   user_id or guest_session_id to NULL        the account or guest session is deleted
CREATE FUNCTION "reject_order_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."number", NEW."email", NEW."quote_ref", NEW."promotion_id", NEW."subtotal_paise", NEW."discount_total_paise",
      NEW."shipping_fee_paise", NEW."tax_total_paise", NEW."grand_total_paise", NEW."currency", NEW."prices_include_tax",
      NEW."shipping_address", NEW."billing_address", NEW."submit_key", NEW."legacy_shopify_order_name", NEW."created_at",
      NEW."customer_snapshot", NEW."tax_snapshot", NEW."shipping_snapshot", NEW."quote_fingerprint")
     IS DISTINCT FROM
     (OLD."id", OLD."number", OLD."email", OLD."quote_ref", OLD."promotion_id", OLD."subtotal_paise", OLD."discount_total_paise",
      OLD."shipping_fee_paise", OLD."tax_total_paise", OLD."grand_total_paise", OLD."currency", OLD."prices_include_tax",
      OLD."shipping_address", OLD."billing_address", OLD."submit_key", OLD."legacy_shopify_order_name", OLD."created_at",
      OLD."customer_snapshot", OLD."tax_snapshot", OLD."shipping_snapshot", OLD."quote_fingerprint")
     OR (NEW."user_id" IS DISTINCT FROM OLD."user_id" AND NEW."user_id" IS NOT NULL AND OLD."user_id" IS NOT NULL)
     OR (NEW."guest_session_id" IS DISTINCT FROM OLD."guest_session_id" AND NEW."guest_session_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'order is a purchase snapshot: only its status, fulfilment status and account links may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "order_snapshot_immutable" BEFORE UPDATE ON "order" FOR EACH ROW EXECUTE FUNCTION "reject_order_snapshot_change"();
