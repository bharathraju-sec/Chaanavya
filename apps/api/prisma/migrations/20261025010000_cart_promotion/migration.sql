-- Stage 11.10: the promo code applied to a bag. Additive only.

-- AlterTable
ALTER TABLE "cart" ADD COLUMN     "promotion_id" UUID;

-- AddForeignKey
ALTER TABLE "cart" ADD CONSTRAINT "cart_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
