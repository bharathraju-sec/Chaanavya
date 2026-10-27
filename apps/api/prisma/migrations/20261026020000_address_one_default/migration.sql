-- Stage 12.03: a customer has at most one default address. A partial unique index, so any number
-- of non-default addresses is fine. Kept in SQL because Prisma cannot describe partial indexes.
CREATE UNIQUE INDEX "address_one_default_per_user" ON "address"("user_id") WHERE "is_default";
