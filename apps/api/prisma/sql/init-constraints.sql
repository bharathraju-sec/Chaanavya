
-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (Stage 04). Each one backs an invariant from lib/modules/contracts.

ALTER SEQUENCE "order_number_seq" OWNED BY "order"."number";

-- Identity: normalized keys
ALTER TABLE "user" ADD CONSTRAINT "user_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "address" ADD CONSTRAINT "address_pin_code_format" CHECK ("pin_code" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "address" ADD CONSTRAINT "address_country_india" CHECK ("country" = 'IN');

-- Catalogue: one active variant per SKU (archived variants keep their SKU for history)
CREATE UNIQUE INDEX "product_variant_sku_active_key" ON "product_variant" ("sku") WHERE "archived_at" IS NULL;
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_price_non_negative" CHECK ("price_paise" >= 0 AND ("compare_at_price_paise" IS NULL OR "compare_at_price_paise" >= 0));
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_sku_not_blank" CHECK (length(btrim("sku")) > 0);
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "product" ADD CONSTRAINT "product_handle_format" CHECK ("handle" ~ '^[a-z0-9][a-z0-9-]{0,254}$');
ALTER TABLE "collection" ADD CONSTRAINT "collection_handle_format" CHECK ("handle" ~ '^[a-z0-9][a-z0-9-]{0,254}$');

-- Inventory: available = on_hand - reserved - allocated, and nothing is ever negative (no overselling)
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_non_negative" CHECK ("on_hand" >= 0 AND "reserved" >= 0 AND "allocated" >= 0);
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_available_non_negative" CHECK ("on_hand" - "reserved" - "allocated" >= 0);
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_quantity_non_zero" CHECK ("quantity" <> 0);
ALTER TABLE "inventory_reservation_line" ADD CONSTRAINT "inventory_reservation_line_quantity_positive" CHECK ("quantity" > 0);

-- Cart: exactly one owner, sane quantities (same limits as the contracts)
ALTER TABLE "cart" ADD CONSTRAINT "cart_single_owner" CHECK (("user_id" IS NULL) <> ("session_id" IS NULL));
ALTER TABLE "cart_line" ADD CONSTRAINT "cart_line_quantity_range" CHECK ("quantity" BETWEEN 1 AND 99);

-- Promotions: a percentage or a fixed amount, never both
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_code_uppercase" CHECK ("code" = upper("code") AND length(btrim("code")) > 0);
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_value_matches_kind" CHECK (
  ("kind" = 'percent' AND "percent_basis_points" BETWEEN 1 AND 10000 AND "amount_off_paise" IS NULL)
  OR ("kind" = 'fixed_amount' AND "amount_off_paise" > 0 AND "percent_basis_points" IS NULL)
);
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_window" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_usage_non_negative" CHECK ("usage_count" >= 0 AND ("usage_limit" IS NULL OR "usage_limit" > 0) AND ("min_subtotal_paise" IS NULL OR "min_subtotal_paise" >= 0));

-- Orders: totals add up in integer paise; tax is added only when prices exclude it (decision 014)
ALTER TABLE "order" ADD CONSTRAINT "order_amounts_non_negative" CHECK ("subtotal_paise" >= 0 AND "discount_total_paise" >= 0 AND "shipping_fee_paise" >= 0 AND "tax_total_paise" >= 0 AND "grand_total_paise" >= 0);
ALTER TABLE "order" ADD CONSTRAINT "order_discount_within_subtotal" CHECK ("discount_total_paise" <= "subtotal_paise");
ALTER TABLE "order" ADD CONSTRAINT "order_grand_total_consistent" CHECK (
  "grand_total_paise" = "subtotal_paise" - "discount_total_paise" + "shipping_fee_paise" + CASE WHEN "prices_include_tax" THEN 0 ELSE "tax_total_paise" END
);
ALTER TABLE "order" ADD CONSTRAINT "order_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "order" ADD CONSTRAINT "order_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_amounts_non_negative" CHECK ("unit_price_paise" >= 0 AND "discount_paise" >= 0 AND "tax_paise" >= 0 AND "line_total_paise" >= 0);

-- Payments and refunds
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_amounts_non_negative" CHECK ("amount_paise" > 0 AND ("captured_amount_paise" IS NULL OR "captured_amount_paise" >= 0));
ALTER TABLE "refund" ADD CONSTRAINT "refund_amount_positive" CHECK ("amount_paise" > 0);
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cost_non_negative" CHECK ("shipping_cost_paise" IS NULL OR "shipping_cost_paise" >= 0);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_quantity_positive" CHECK ("quantity" > 0);

-- Append-only ledgers: inventory movements and audit events can be inserted, never changed
CREATE FUNCTION "reject_append_only_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "inventory_movement_append_only" BEFORE UPDATE OR DELETE ON "inventory_movement" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "inventory_movement_no_truncate" BEFORE TRUNCATE ON "inventory_movement" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "audit_event_append_only" BEFORE UPDATE OR DELETE ON "audit_event" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit_event" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();
