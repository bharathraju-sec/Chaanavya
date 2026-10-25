-- Rollback for 20261025010000_cart_promotion (Stage 11.10). Bags lose their applied promo code;
-- the codes themselves and orders are untouched.
ALTER TABLE "cart" DROP CONSTRAINT IF EXISTS "cart_promotion_id_fkey";
ALTER TABLE "cart" DROP COLUMN IF EXISTS "promotion_id";
