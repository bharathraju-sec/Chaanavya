-- Rollback for 20261026010000_address_state_list (Stage 12.02). Back to the shape-only state check.
ALTER TABLE "address" DROP CONSTRAINT IF EXISTS "address_state_code_known";
ALTER TABLE "address" ADD CONSTRAINT "address_state_code_format" CHECK ("state_code" ~ '^IN-[A-Z]{2}$');
