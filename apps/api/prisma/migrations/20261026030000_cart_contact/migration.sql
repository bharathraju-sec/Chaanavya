-- Stage 12.04: contact and delivery details entered at the contact step, for guests without an
-- account. One row per bag, removed with the bag. Additive only.

-- CreateTable
CREATE TABLE "cart_contact" (
    "cart_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "shipping_address" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_contact_pkey" PRIMARY KEY ("cart_id")
);

-- AddForeignKey
ALTER TABLE "cart_contact" ADD CONSTRAINT "cart_contact_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An email address, stored lower-case, and an address object with the mandatory fields present.
ALTER TABLE "cart_contact" ADD CONSTRAINT "cart_contact_email_format" CHECK ("email" = lower("email") AND char_length("email") <= 254 AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
ALTER TABLE "cart_contact" ADD CONSTRAINT "cart_contact_address_shape" CHECK (
    jsonb_typeof("shipping_address") = 'object'
    AND "shipping_address" ?& ARRAY['name', 'phone', 'line1', 'city', 'district', 'stateCode', 'pinCode', 'country']
    AND "shipping_address"->>'pinCode' ~ '^[1-9][0-9]{5}$'
    AND "shipping_address"->>'phone' ~ '^\+91[6-9][0-9]{9}$'
    AND "shipping_address"->>'country' = 'IN'
);
