-- Stage 13.02: one order per checkout quote. A quote can be submitted more than once (a retry, a double
-- click after a reload, a second Idempotency-Key); only one order can ever come from it.

-- CreateIndex
CREATE UNIQUE INDEX "order_one_per_quote" ON "order"("quote_ref") WHERE "quote_ref" IS NOT NULL;
