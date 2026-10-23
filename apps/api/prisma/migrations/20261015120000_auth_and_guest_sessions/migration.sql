-- Stage 05: authentication (Better Auth) and guest sessions.
-- Reviewed by hand. The SQL Prisma generated dropped `cart.session_id` and `order.session_id`
-- and re-created them empty, which loses every guest cart and order owner and silently drops the
-- `cart_single_owner` CHECK. It is rewritten below as renames, so data and constraints survive.

-- 1. Sign-in sessions move to Better Auth (auth_session); the old table keeps guest sessions only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "session" WHERE "kind" <> 'guest') THEN
    RAISE EXCEPTION 'session holds customer or staff rows; they cannot be carried into guest_session';
  END IF;
END
$$;

ALTER TABLE "cart" DROP CONSTRAINT "cart_session_id_fkey";
ALTER TABLE "order" DROP CONSTRAINT "order_session_id_fkey";
ALTER TABLE "session" DROP CONSTRAINT "session_user_id_fkey";

ALTER TABLE "session" RENAME TO "guest_session";
ALTER TABLE "guest_session" DROP COLUMN "kind", DROP COLUMN "user_id";
ALTER TABLE "guest_session" RENAME CONSTRAINT "session_pkey" TO "guest_session_pkey";
ALTER INDEX "session_token_hash_key" RENAME TO "guest_session_token_hash_key";
ALTER INDEX "session_expires_at_idx" RENAME TO "guest_session_expires_at_idx";
DROP TYPE "SessionKind";

-- cart_single_owner follows the renamed column automatically.
ALTER TABLE "cart" RENAME COLUMN "session_id" TO "guest_session_id";
ALTER INDEX "cart_session_id_idx" RENAME TO "cart_guest_session_id_idx";
ALTER TABLE "order" RENAME COLUMN "session_id" TO "guest_session_id";
CREATE INDEX "order_guest_session_id_idx" ON "order"("guest_session_id");

ALTER TABLE "cart" ADD CONSTRAINT "cart_guest_session_id_fkey" FOREIGN KEY ("guest_session_id") REFERENCES "guest_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order" ADD CONSTRAINT "order_guest_session_id_fkey" FOREIGN KEY ("guest_session_id") REFERENCES "guest_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Users: Better Auth's boolean replaces the timestamp; MFA state now lives in two_factor.
ALTER TABLE "user"
  ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "image" TEXT,
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "user" SET "email_verified" = true WHERE "email_verified_at" IS NOT NULL;
ALTER TABLE "user" DROP COLUMN "email_verified_at";
ALTER TABLE "role" DROP COLUMN "mfa_enrolled_at";

-- 3. Better Auth tables
-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "auth_method" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_user_id_idx" ON "auth_session"("user_id");

-- CreateIndex
CREATE INDEX "auth_session_expires_at_idx" ON "auth_session"("expires_at");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");

-- CreateIndex
CREATE INDEX "two_factor_user_id_idx" ON "two_factor"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_secret_idx" ON "two_factor"("secret");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_key_key" ON "rate_limit"("key");

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 4. Hand-written rules
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_method_known" CHECK ("auth_method" IN ('unknown', 'email_otp', 'password', 'password_2fa'));
ALTER TABLE "rate_limit" ADD CONSTRAINT "rate_limit_count_non_negative" CHECK ("count" >= 0);
