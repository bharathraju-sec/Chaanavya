-- Stage 12.02: a saved address's state must be one of the 36 ISO 3166-2:IN codes current since
-- November 2023, matching apps/api/src/checkout/region.ts. Replaces the shape-only check from
-- 20261026000000_address_fields. Whether a PIN can be delivered to is not stored here.

ALTER TABLE "address" DROP CONSTRAINT "address_state_code_format";
ALTER TABLE "address" ADD CONSTRAINT "address_state_code_known" CHECK ("state_code" IN ('IN-AN', 'IN-AP', 'IN-AR', 'IN-AS', 'IN-BR', 'IN-CH', 'IN-CG', 'IN-DH', 'IN-DL', 'IN-GA', 'IN-GJ', 'IN-HR', 'IN-HP', 'IN-JK', 'IN-JH', 'IN-KA', 'IN-KL', 'IN-LA', 'IN-LD', 'IN-MP', 'IN-MH', 'IN-MN', 'IN-ML', 'IN-MZ', 'IN-NL', 'IN-OD', 'IN-PY', 'IN-PB', 'IN-RJ', 'IN-SK', 'IN-TN', 'IN-TG', 'IN-TR', 'IN-UP', 'IN-UK', 'IN-WB'));
