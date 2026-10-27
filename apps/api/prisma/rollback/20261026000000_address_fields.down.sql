-- Rollback for 20261026000000_address_fields (Stage 12.01). Saved addresses lose their district and
-- the stricter checks; the PIN and country checks from init stay. Orders are untouched.
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_state_code_format";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_phone_mobile";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_optional_lines_length";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_district_present";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_city_present";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_line1_present";
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_name_present";
ALTER TABLE "address" DROP COLUMN IF EXISTS "district";
