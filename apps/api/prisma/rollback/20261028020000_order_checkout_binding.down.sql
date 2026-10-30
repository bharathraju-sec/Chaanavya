-- Rollback for 20261028020000_order_checkout_binding (Stage 13.03). Orders lose their bag link and payment
-- window; the order snapshot trigger goes back to its 13.01 form.
CREATE OR REPLACE FUNCTION "reject_order_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_payable_until_after_placing";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_quote_payable_until";
DROP INDEX IF EXISTS "order_cart_id_idx";
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS "order_cart_id_fkey";
ALTER TABLE "order" DROP COLUMN IF EXISTS "payable_until";
ALTER TABLE "order" DROP COLUMN IF EXISTS "cart_id";
