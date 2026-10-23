-- Rollback for 20261017000000_inventory_operations (Stage 09). Loses stocktakes (including signed
-- reports: export them first), last-counted dates, low-stock thresholds and movement detail.
-- Ledger rows and balances stay.
DROP TRIGGER IF EXISTS "stocktake_signed_record" ON "stocktake";
DROP TRIGGER IF EXISTS "stocktake_line_signed_record" ON "stocktake_line";
DROP FUNCTION IF EXISTS "reject_approved_stocktake_change"();
DROP TABLE IF EXISTS "stocktake_line";
DROP TABLE IF EXISTS "stocktake";
DROP TYPE IF EXISTS "StocktakeStatus";
ALTER TABLE "inventory_balance" DROP CONSTRAINT IF EXISTS "inventory_balance_low_stock_threshold_range";
DROP INDEX IF EXISTS "inventory_balance_last_counted_at_idx";
ALTER TABLE "inventory_balance" DROP COLUMN "last_counted_at", DROP COLUMN "low_stock_threshold";
-- inventory_movement is append-only (trigger); dropping columns is a schema change, not a row change.
ALTER TABLE "inventory_movement" DROP COLUMN "reason_code", DROP COLUMN "on_hand_after", DROP COLUMN "reserved_after", DROP COLUMN "allocated_after";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261017000000_inventory_operations';
