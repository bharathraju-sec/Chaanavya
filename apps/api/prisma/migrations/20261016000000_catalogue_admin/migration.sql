-- Stage 08: product, collection, variant and media administration. Additive only: new columns with
-- defaults, two new tables, constraints and one trigger. Nothing is dropped or rewritten.

-- CreateEnum
CREATE TYPE "ShippingRestriction" AS ENUM ('none', 'fragrance_liquid', 'jewellery_high_value');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "collection" ADD COLUMN     "storefront" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "approval" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_by_id" UUID,
ADD COLUMN     "shipping_restriction" "ShippingRestriction",
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_media" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_by_id" UUID,
ADD COLUMN     "removed_at" TIMESTAMPTZ(3),
ADD COLUMN     "staging_key" TEXT,
ADD COLUMN     "status" "MediaStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "url" DROP NOT NULL;

-- AlterTable
ALTER TABLE "product_variant" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "media_upload" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "staging_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "media_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "dispatched_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_upload_staging_key_key" ON "media_upload"("staging_key");

-- CreateIndex
CREATE UNIQUE INDEX "media_upload_media_id_key" ON "media_upload"("media_id");

-- CreateIndex
CREATE INDEX "media_upload_expires_at_idx" ON "media_upload"("expires_at");

-- CreateIndex
CREATE INDEX "outbox_event_dispatched_at_available_at_idx" ON "outbox_event"("dispatched_at", "available_at");

-- CreateIndex
CREATE INDEX "outbox_event_aggregate_type_aggregate_id_idx" ON "outbox_event"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_media_staging_key_key" ON "product_media"("staging_key");

-- CreateIndex
CREATE INDEX "product_media_removed_at_idx" ON "product_media"("removed_at");

-- AddForeignKey
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "product_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Photos stored before Stage 08 (synthetic fixtures, legacy imports) already have a public URL.
UPDATE "product_media" SET "status" = 'approved' WHERE "url" IS NOT NULL;

-- Media: an approved photo always has its public copy; uploads are limited to the accepted types
-- and sizes (10 MB), and carry a well-formed base64 SHA-256.
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_approved_has_public_copy" CHECK ("status" <> 'approved' OR ("url" IS NOT NULL));
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_alt_text_length" CHECK ("alt_text" IS NULL OR length("alt_text") <= 300);
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_content_type_allowed" CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif'));
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_byte_size_range" CHECK ("byte_size" BETWEEN 1 AND 10485760);
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_checksum_format" CHECK ("checksum_sha256" ~ '^[A-Za-z0-9+/]{43}=$');
ALTER TABLE "media_upload" ADD CONSTRAINT "media_upload_expiry_after_creation" CHECK ("expires_at" > "created_at");
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_attempts_non_negative" CHECK ("attempts" >= 0);

-- The storefront's category pages, by their existing URLs. Titles as on the site today; descriptions
-- are left empty because the site's copy is template text awaiting the owner.
INSERT INTO "collection" ("id", "handle", "title", "position", "storefront", "updated_at") VALUES
  (gen_random_uuid(), 'dresses', 'Dresses & Gowns', 1, true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'ethnic-festive', 'Ethnic & Festive', 2, true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'jewellery', 'Fine Jewellery', 3, true, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'fragrance', 'Fragrance', 4, true, CURRENT_TIMESTAMP)
ON CONFLICT ("handle") DO UPDATE SET "storefront" = true;

-- A storefront category keeps its handle (its page URL) and cannot be deleted.
CREATE FUNCTION "protect_storefront_collection"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."storefront" THEN
    RAISE EXCEPTION 'storefront collection % cannot be deleted', OLD."handle" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."storefront" AND (NEW."handle" <> OLD."handle" OR NOT NEW."storefront") THEN
    RAISE EXCEPTION 'storefront collection % keeps its handle', OLD."handle" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "collection_storefront_protected" BEFORE UPDATE OR DELETE ON "collection" FOR EACH ROW EXECUTE FUNCTION "protect_storefront_collection"();

-- Order lines are a snapshot of what was bought (CHV-S04-003, CHV-S08-005): no later product,
-- price or SKU edit can change them. Only the link to a deleted variant may be cleared.
CREATE FUNCTION "reject_order_item_snapshot_change"() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "order_item_snapshot_immutable" BEFORE UPDATE ON "order_item" FOR EACH ROW EXECUTE FUNCTION "reject_order_item_snapshot_change"();
