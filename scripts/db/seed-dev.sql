-- Synthetic data for `npm run db:restore-check` (Stage 03), loaded into a scratch database only.
-- Not merchandise, not customers. Separate from the Prisma schema in chaanavya_dev.
CREATE TABLE IF NOT EXISTS dev_seed_check (
  id integer PRIMARY KEY,
  label text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT '2026-10-15T00:00:00Z'
);

INSERT INTO dev_seed_check (id, label, amount_paise) VALUES
  (1, 'Synthetic item 1', 0),
  (2, 'Synthetic item 2', 99),
  (3, 'Synthetic item 3', 349900),
  (4, 'Synthetic item 4', 9007199254740991),
  (5, 'Synthetic item 5 with unicode: ₹ नमस्ते', 100)
ON CONFLICT (id) DO NOTHING;
