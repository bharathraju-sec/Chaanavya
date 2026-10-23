-- Stage 05: Better Auth creates some verification rows with a deterministic key derived from the
-- identifier (first-writer-wins), which is not a UUID. The column becomes text; existing UUIDs remain valid text.
ALTER TABLE "verification" ALTER COLUMN "id" SET DATA TYPE TEXT;
