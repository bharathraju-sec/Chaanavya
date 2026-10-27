-- Stage 12.09: the latest checkout quote for a bag, worked out on the server. One row per bag,
-- replaced on every new quote and removed with the bag. Stage 13 reads it at confirmation. Additive only.

-- CreateTable
CREATE TABLE "checkout_quote" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "cart_revision" INTEGER NOT NULL,
    "grand_total_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "test" BOOLEAN NOT NULL,
    "quote" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_quote_cart_id_key" ON "checkout_quote"("cart_id");

-- AddForeignKey
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Whole paise, rupees only, a stored total that matches the stored quote, and an expiry after creation.
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_money" CHECK ("grand_total_paise" >= 0 AND "currency" = 'INR');
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_total_matches" CHECK (jsonb_typeof("quote") = 'object' AND ("quote"->'grandTotal'->>'amountPaise')::bigint = "grand_total_paise");
ALTER TABLE "checkout_quote" ADD CONSTRAINT "checkout_quote_expiry" CHECK ("expires_at" > "created_at");
