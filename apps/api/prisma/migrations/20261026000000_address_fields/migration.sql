-- Stage 12.01: Indian shipping addresses. Adds the district and makes the database refuse an
-- address book entry with missing or malformed mandatory fields, matching
-- apps/api/src/checkout/address.ts. The address table was empty when this was written; a non-empty
-- table needs districts filled in first.

-- AlterTable
ALTER TABLE "address" ADD COLUMN "district" TEXT NOT NULL;

-- Mandatory text present (not blank) and within length limits
ALTER TABLE "address" ADD CONSTRAINT "address_name_present" CHECK (btrim("name") <> '' AND char_length("name") <= 100);
ALTER TABLE "address" ADD CONSTRAINT "address_line1_present" CHECK (btrim("line1") <> '' AND char_length("line1") <= 200);
ALTER TABLE "address" ADD CONSTRAINT "address_city_present" CHECK (btrim("city") <> '' AND char_length("city") <= 100);
ALTER TABLE "address" ADD CONSTRAINT "address_district_present" CHECK (btrim("district") <> '' AND char_length("district") <= 100);
ALTER TABLE "address" ADD CONSTRAINT "address_optional_lines_length" CHECK (char_length(coalesce("line2", '')) <= 200 AND char_length(coalesce("landmark", '')) <= 200);

-- Indian mobile number in E.164, state code shape (the PIN format check exists since init)
ALTER TABLE "address" ADD CONSTRAINT "address_phone_mobile" CHECK ("phone" ~ '^\+91[6-9][0-9]{9}$');
ALTER TABLE "address" ADD CONSTRAINT "address_state_code_format" CHECK ("state_code" ~ '^IN-[A-Z]{2}$');
