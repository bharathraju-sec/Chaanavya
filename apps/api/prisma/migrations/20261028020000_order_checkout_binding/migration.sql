-- Stage 13.03: bind a pending order to the checkout it came from. An order placed from a quote names
-- the bag it was placed from and when its price stops being payable (the quote's expiry, Stage 12.10).
-- Payment (later stages) may only continue an order its own shopper holds, from its own bag, inside
-- that window. Additive: earlier orders keep NULL.

-- AlterTable
ALTER TABLE "order" ADD COLUMN "cart_id" UUID;
ALTER TABLE "order" ADD COLUMN "payable_until" TIMESTAMPTZ(3);

-- AddForeignKey: the bag may be deleted later (expiry, merge); the order then keeps no link.
ALTER TABLE "order" ADD CONSTRAINT "order_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "order_cart_id_idx" ON "order"("cart_id");

-- An order from a quote has a payment window, which ends after it was placed.
ALTER TABLE "order" ADD CONSTRAINT "order_quote_payable_until" CHECK ("quote_fingerprint" IS NULL OR "payable_until" IS NOT NULL);
ALTER TABLE "order" ADD CONSTRAINT "order_payable_until_after_placing" CHECK ("payable_until" IS NULL OR "payable_until" > "created_at");

-- The order snapshot (13.01) now also freezes the payment window, and the bag link may only be cleared.
CREATE OR REPLACE FUNCTION "reject_order_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."number", NEW."email", NEW."quote_ref", NEW."promotion_id", NEW."subtotal_paise", NEW."discount_total_paise",
      NEW."shipping_fee_paise", NEW."tax_total_paise", NEW."grand_total_paise", NEW."currency", NEW."prices_include_tax",
      NEW."shipping_address", NEW."billing_address", NEW."submit_key", NEW."legacy_shopify_order_name", NEW."created_at",
      NEW."customer_snapshot", NEW."tax_snapshot", NEW."shipping_snapshot", NEW."quote_fingerprint", NEW."payable_until")
     IS DISTINCT FROM
     (OLD."id", OLD."number", OLD."email", OLD."quote_ref", OLD."promotion_id", OLD."subtotal_paise", OLD."discount_total_paise",
      OLD."shipping_fee_paise", OLD."tax_total_paise", OLD."grand_total_paise", OLD."currency", OLD."prices_include_tax",
      OLD."shipping_address", OLD."billing_address", OLD."submit_key", OLD."legacy_shopify_order_name", OLD."created_at",
      OLD."customer_snapshot", OLD."tax_snapshot", OLD."shipping_snapshot", OLD."quote_fingerprint", OLD."payable_until")
     OR (NEW."user_id" IS DISTINCT FROM OLD."user_id" AND NEW."user_id" IS NOT NULL AND OLD."user_id" IS NOT NULL)
     OR (NEW."guest_session_id" IS DISTINCT FROM OLD."guest_session_id" AND NEW."guest_session_id" IS NOT NULL)
     OR (NEW."cart_id" IS DISTINCT FROM OLD."cart_id" AND NEW."cart_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'order is a purchase snapshot: only its status, fulfilment status and account links may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
