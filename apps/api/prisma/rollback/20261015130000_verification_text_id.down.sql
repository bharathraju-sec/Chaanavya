-- Rollback for 20261015130000_verification_text_id. Fails if any non-UUID keys exist; delete them first
-- (they are short-lived one-time codes).
ALTER TABLE "verification" ALTER COLUMN "id" SET DATA TYPE UUID USING "id"::uuid;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015130000_verification_text_id';
