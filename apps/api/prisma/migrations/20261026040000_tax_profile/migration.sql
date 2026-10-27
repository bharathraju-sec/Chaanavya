-- Stage 12.05: GST configuration. Additive only. No profile is created here: real values come from the
-- owner and a tax advisor, and until one is approved and active, live sales are blocked.

-- CreateTable
CREATE TABLE "tax_profile" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "seller_state_code" TEXT NOT NULL,
    "gstin" TEXT,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "signed_name" TEXT,
    "advisor_reference" TEXT,
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "profile_id" UUID NOT NULL,
    "tax_category" TEXT NOT NULL,
    "hsn_code" TEXT NOT NULL,
    "rate_basis_points" INTEGER NOT NULL,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("profile_id","tax_category")
);

-- CreateIndex
CREATE INDEX "tax_profile_status_idx" ON "tax_profile"("status");

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "tax_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A profile is a draft, approved or retired; an approved or retired one carries its signature and GSTIN.
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_status_known" CHECK ("status" IN ('draft', 'approved', 'retired'));
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_approval_signed" CHECK (
    "status" = 'draft'
    OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "gstin" IS NOT NULL
        AND char_length(btrim(coalesce("signed_name", ''))) >= 3 AND char_length(btrim(coalesce("advisor_reference", ''))) >= 5)
);
-- Only an approved profile can be active, and at most one at a time.
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_active_approved" CHECK (NOT "active" OR ("status" = 'approved' AND "activated_at" IS NOT NULL));
CREATE UNIQUE INDEX "tax_profile_one_active" ON "tax_profile"("active") WHERE "active";
ALTER TABLE "tax_profile" ADD CONSTRAINT "tax_profile_gstin_format" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');

-- Rates: a tax category as on variants, HSN of 4, 6 or 8 digits, GST from 0% to 40% in basis points.
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_category_format" CHECK ("tax_category" ~ '^[a-z0-9_]{1,40}$' AND "tax_category" <> 'unassigned');
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_hsn_format" CHECK ("hsn_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_range" CHECK ("rate_basis_points" BETWEEN 0 AND 4000);

-- An approved or retired profile never changes its values or rates again, and is never deleted.
-- Only active, activated_at, status (approved to retired) and retired_at may change on it.
CREATE FUNCTION tax_profile_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    profile_status TEXT;
BEGIN
    IF TG_TABLE_NAME = 'tax_rate' THEN
        SELECT status INTO profile_status FROM tax_profile WHERE id = COALESCE(NEW.profile_id, OLD.profile_id);
        IF profile_status IS NOT NULL AND profile_status <> 'draft' THEN
            RAISE EXCEPTION 'tax rates of an approved profile cannot change';
        END IF;
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'an approved tax profile cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.status <> 'draft' AND (
        NEW.seller_state_code IS DISTINCT FROM OLD.seller_state_code OR NEW.gstin IS DISTINCT FROM OLD.gstin
        OR NEW.prices_include_tax IS DISTINCT FROM OLD.prices_include_tax OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.signed_name IS DISTINCT FROM OLD.signed_name
        OR NEW.advisor_reference IS DISTINCT FROM OLD.advisor_reference OR NEW.status = 'draft'
        OR (OLD.status = 'retired' AND NEW.status <> 'retired')
    ) THEN
        RAISE EXCEPTION 'an approved tax profile cannot change';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tax_profile_frozen BEFORE UPDATE OR DELETE ON "tax_profile" FOR EACH ROW EXECUTE FUNCTION tax_profile_frozen();
CREATE TRIGGER tax_rate_frozen BEFORE INSERT OR UPDATE OR DELETE ON "tax_rate" FOR EACH ROW EXECUTE FUNCTION tax_profile_frozen();
