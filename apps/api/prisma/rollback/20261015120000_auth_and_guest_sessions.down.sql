-- Rollback for 20261015120000_auth_and_guest_sessions (Stage 05). Rehearsal and development only;
-- back up first. Signed-in sessions, credentials, two-factor secrets, one-time codes and rate-limit
-- counters are deleted. Guest sessions, carts and orders keep their owners.

ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_user_id_fkey";
ALTER TABLE "account" DROP CONSTRAINT "account_user_id_fkey";
ALTER TABLE "two_factor" DROP CONSTRAINT "two_factor_user_id_fkey";
DROP TABLE "auth_session";
DROP TABLE "account";
DROP TABLE "verification";
DROP TABLE "two_factor";
DROP TABLE "rate_limit";

ALTER TABLE "role" ADD COLUMN "mfa_enrolled_at" TIMESTAMPTZ(3);
ALTER TABLE "user" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);
UPDATE "user" SET "email_verified_at" = "updated_at" WHERE "email_verified";
ALTER TABLE "user" DROP COLUMN "email_verified", DROP COLUMN "image", DROP COLUMN "name", DROP COLUMN "two_factor_enabled";

ALTER TABLE "cart" DROP CONSTRAINT "cart_guest_session_id_fkey";
ALTER TABLE "order" DROP CONSTRAINT "order_guest_session_id_fkey";
DROP INDEX "order_guest_session_id_idx";
ALTER TABLE "order" RENAME COLUMN "guest_session_id" TO "session_id";
ALTER INDEX "cart_guest_session_id_idx" RENAME TO "cart_session_id_idx";
ALTER TABLE "cart" RENAME COLUMN "guest_session_id" TO "session_id";

CREATE TYPE "SessionKind" AS ENUM ('customer', 'staff', 'guest');
ALTER INDEX "guest_session_expires_at_idx" RENAME TO "session_expires_at_idx";
ALTER INDEX "guest_session_token_hash_key" RENAME TO "session_token_hash_key";
ALTER TABLE "guest_session" RENAME CONSTRAINT "guest_session_pkey" TO "session_pkey";
ALTER TABLE "guest_session" RENAME TO "session";
ALTER TABLE "session" ADD COLUMN "kind" "SessionKind" NOT NULL DEFAULT 'guest', ADD COLUMN "user_id" UUID;
ALTER TABLE "session" ALTER COLUMN "kind" DROP DEFAULT;
CREATE INDEX "session_user_id_idx" ON "session"("user_id");
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cart" ADD CONSTRAINT "cart_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015120000_auth_and_guest_sessions';
