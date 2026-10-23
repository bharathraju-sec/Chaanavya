-- Chaanavya initial schema (Stage 04).
-- Assembled from: prisma/sql/init-pre.sql + `prisma migrate diff --from-empty --to-schema` output
-- + prisma/sql/init-constraints.sql. Edit the schema and those files, not this migration, then
-- re-assemble (see prisma/README.md). Once applied anywhere shared, never edit it: add a new migration.

-- Customer-facing order numbers (decision 016, proposed): CHV-100001, CHV-100002, ...
-- Sequence numbers can skip after a rolled-back transaction; they are never reused.
CREATE SEQUENCE "order_number_seq" START WITH 100001;

