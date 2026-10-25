-- Stage 11.04: idempotency keys for adds to a cart. Additive only.

-- CreateTable
CREATE TABLE "cart_request" (
    "cart_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_request_pkey" PRIMARY KEY ("cart_id","key")
);

-- AddForeignKey
ALTER TABLE "cart_request" ADD CONSTRAINT "cart_request_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
