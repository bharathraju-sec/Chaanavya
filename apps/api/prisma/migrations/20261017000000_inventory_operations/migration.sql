-- Stage 09: inventory operations. Additive only: stock movement detail, low-stock thresholds,
-- the last approved count per SKU, and physical stocktakes with a signed reconciliation report.

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('draft', 'submitted', 'approved', 'cancelled');

-- AlterTable
ALTER TABLE "inventory_balance" ADD COLUMN     "last_counted_at" TIMESTAMPTZ(3),
ADD COLUMN     "low_stock_threshold" INTEGER;

-- AlterTable
ALTER TABLE "inventory_movement" ADD COLUMN     "allocated_after" INTEGER,
ADD COLUMN     "on_hand_after" INTEGER,
ADD COLUMN     "reason_code" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "reserved_after" INTEGER;

-- CreateTable
CREATE TABLE "stocktake" (
    "id" UUID NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'draft',
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'owner_count',
    "source_sha256" TEXT,
    "created_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "signed_name" TEXT,
    "report" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stocktake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_line" (
    "stocktake_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "counted" INTEGER NOT NULL,
    "reference" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "stocktake_line_pkey" PRIMARY KEY ("stocktake_id","variant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_source_sha256_key" ON "stocktake"("source_sha256");

-- CreateIndex
CREATE INDEX "stocktake_status_created_at_idx" ON "stocktake"("status", "created_at");

-- CreateIndex
CREATE INDEX "inventory_balance_last_counted_at_idx" ON "inventory_balance"("last_counted_at");

-- AddForeignKey
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_low_stock_threshold_range" CHECK ("low_stock_threshold" IS NULL OR "low_stock_threshold" BETWEEN 0 AND 100000);
ALTER TABLE "stocktake_line" ADD CONSTRAINT "stocktake_line_counted_non_negative" CHECK ("counted" >= 0 AND "counted" <= 1000000 AND ("reference" IS NULL OR "reference" >= 0));
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_approval_complete" CHECK (
  "status" <> 'approved' OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "signed_name" IS NOT NULL AND length(btrim("signed_name")) >= 3 AND "report" IS NOT NULL)
);
ALTER TABLE "stocktake" ADD CONSTRAINT "stocktake_source_known" CHECK ("source" IN ('owner_count', 'owner_csv', 'shopify_export'));

-- A signed stocktake is a record: once approved, neither it nor its lines can change or disappear.
CREATE FUNCTION "reject_approved_stocktake_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved boolean;
BEGIN
  IF TG_TABLE_NAME = 'stocktake' THEN
    approved := OLD."status" = 'approved';
  ELSE
    SELECT "status" = 'approved' INTO approved FROM "stocktake" WHERE "id" = OLD."stocktake_id";
  END IF;
  IF approved THEN
    RAISE EXCEPTION 'an approved stocktake is a signed record: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "stocktake_signed_record" BEFORE UPDATE OR DELETE ON "stocktake" FOR EACH ROW EXECUTE FUNCTION "reject_approved_stocktake_change"();
CREATE TRIGGER "stocktake_line_signed_record" BEFORE UPDATE OR DELETE ON "stocktake_line" FOR EACH ROW EXECUTE FUNCTION "reject_approved_stocktake_change"();
