-- Rollback for 20261016000000_catalogue_admin (Stage 08). Loses upload intents, outbox events, the
-- publish approvals and media review state. Media rows without a public URL (pending or rejected
-- uploads) are deleted, because "url" becomes NOT NULL again; delete their staging objects first.
DROP TRIGGER IF EXISTS "order_item_snapshot_immutable" ON "order_item";
DROP FUNCTION IF EXISTS "reject_order_item_snapshot_change"();
DROP TRIGGER IF EXISTS "collection_storefront_protected" ON "collection";
DROP FUNCTION IF EXISTS "protect_storefront_collection"();

DROP TABLE IF EXISTS "media_upload";
DROP TABLE IF EXISTS "outbox_event";

DELETE FROM "product_media" WHERE "url" IS NULL;
ALTER TABLE "product_media" DROP CONSTRAINT IF EXISTS "product_media_approved_has_public_copy";
ALTER TABLE "product_media" DROP CONSTRAINT IF EXISTS "product_media_alt_text_length";
DROP INDEX IF EXISTS "product_media_staging_key_key";
DROP INDEX IF EXISTS "product_media_removed_at_idx";
ALTER TABLE "product_media" ALTER COLUMN "url" SET NOT NULL,
  DROP COLUMN "approved_at", DROP COLUMN "approved_by_id", DROP COLUMN "removed_at", DROP COLUMN "staging_key", DROP COLUMN "status", DROP COLUMN "version";

ALTER TABLE "product_variant" DROP COLUMN "version";
ALTER TABLE "product" DROP COLUMN "approval", DROP COLUMN "approved_at", DROP COLUMN "approved_by_id", DROP COLUMN "shipping_restriction", DROP COLUMN "version";
-- The four storefront collections stay (they may hold products); only the marker goes.
ALTER TABLE "collection" DROP COLUMN "storefront", DROP COLUMN "version";

DROP TYPE IF EXISTS "MediaStatus";
DROP TYPE IF EXISTS "ShippingRestriction";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016000000_catalogue_admin';
