-- Chaanavya initial schema (Stage 04).
-- Assembled from: prisma/sql/init-pre.sql + `prisma migrate diff --from-empty --to-schema` output
-- + prisma/sql/init-constraints.sql. Edit the schema and those files, not this migration, then
-- re-assemble (see prisma/README.md). Once applied anywhere shared, never edit it: add a new migration.

-- Customer-facing order numbers (decision 016, proposed): CHV-100001, CHV-100002, ...
-- Sequence numbers can skip after a rolled-back transaction; they are never reused.
CREATE SEQUENCE "order_number_seq" START WITH 100001;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('customer', 'staff', 'guest');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('customer', 'guest', 'staff', 'system', 'provider');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('receipt', 'correction', 'reservation', 'release', 'allocation', 'fulfilment', 'return', 'write_off');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('active', 'allocated', 'released', 'fulfilled');

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('percent', 'fixed_amount');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_payment', 'needs_review', 'confirmed', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "FulfilmentStatus" AS ENUM ('unfulfilled', 'packing', 'packed', 'handed_over', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('razorpay', 'phonepe');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('test', 'live');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'authorized', 'captured', 'pending_reconciliation', 'failed', 'expired', 'partially_refunded', 'refunded');

-- CreateEnum
CREATE TYPE "ProviderEventOutcome" AS ENUM ('applied', 'duplicate', 'conflict', 'ignored');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'processing', 'succeeded', 'failed', 'rejected');

-- CreateEnum
CREATE TYPE "CourierProvider" AS ENUM ('shiprocket');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('booking_requested', 'booked', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto_initiated', 'rto_delivered', 'cancelled', 'lost');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('requested', 'under_review', 'pickup_initiated', 'returned', 'inspected', 'approved', 'rejected', 'refunded', 'withdrawn', 'closed');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "phone" TEXT,
    "phone_verified_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "user_id" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "granted_by_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfa_enrolled_at" TIMESTAMPTZ(3),

    CONSTRAINT "role_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profile" (
    "user_id" UUID NOT NULL,
    "full_name" TEXT,
    "email_marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "consent_source" TEXT,
    "consent_text_version" TEXT,
    "consent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "landmark" TEXT,
    "city" TEXT NOT NULL,
    "state_code" TEXT NOT NULL,
    "pin_code" CHAR(6) NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'IN',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "legacy_shopify_gid" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "product_type" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "legacy_shopify_gid" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_collection" (
    "product_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_collection_pkey" PRIMARY KEY ("product_id","collection_id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "selected_options" JSONB NOT NULL DEFAULT '[]',
    "option_key" TEXT NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "compare_at_price_paise" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "tax_category" TEXT NOT NULL DEFAULT 'unassigned',
    "hsn_code" TEXT,
    "media_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "weight_grams" INTEGER,
    "archived_at" TIMESTAMPTZ(3),
    "legacy_shopify_gid" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "storage_key" TEXT,
    "alt_text" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "content_type" TEXT,
    "byte_size" INTEGER,
    "checksum_sha256" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "legacy_shopify_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "variant_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "allocated" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "type" "MovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_id" TEXT,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservation_line" (
    "reservation_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "inventory_reservation_line_pkey" PRIMARY KEY ("reservation_id","variant_id")
);

-- CreateTable
CREATE TABLE "cart" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "session_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_line" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "percent_basis_points" INTEGER,
    "amount_off_paise" BIGINT,
    "min_subtotal_paise" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "usage_limit" INTEGER,
    "per_customer_limit" INTEGER,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL DEFAULT ('CHV-'::text || nextval('order_number_seq'::regclass)),
    "user_id" UUID,
    "session_id" UUID,
    "email" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending_payment',
    "fulfilment_status" "FulfilmentStatus" NOT NULL DEFAULT 'unfulfilled',
    "quote_ref" TEXT,
    "promotion_id" UUID,
    "subtotal_paise" BIGINT NOT NULL,
    "discount_total_paise" BIGINT NOT NULL DEFAULT 0,
    "shipping_fee_paise" BIGINT NOT NULL DEFAULT 0,
    "tax_total_paise" BIGINT NOT NULL DEFAULT 0,
    "grand_total_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT true,
    "shipping_address" JSONB NOT NULL,
    "billing_address" JSONB,
    "submit_key" TEXT NOT NULL,
    "legacy_shopify_order_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "variant_id" UUID,
    "sku" TEXT NOT NULL,
    "product_title" TEXT NOT NULL,
    "variant_title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "image_url" TEXT,
    "hsn_code" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price_paise" BIGINT NOT NULL,
    "discount_paise" BIGINT NOT NULL DEFAULT 0,
    "tax_paise" BIGINT NOT NULL DEFAULT 0,
    "tax_lines" JSONB NOT NULL DEFAULT '[]',
    "line_total_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempt" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "provider_order_id" TEXT,
    "provider_payment_id" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'created',
    "captured_amount_paise" BIGINT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_event" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" "ProviderEventOutcome",
    "summary" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "RefundStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "requested_by_kind" "ActorKind" NOT NULL,
    "requested_by_id" TEXT,
    "provider_refund_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" "CourierProvider" NOT NULL,
    "provider_shipment_id" TEXT,
    "courier_name" TEXT,
    "awb" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'booking_requested',
    "parcels" JSONB NOT NULL DEFAULT '[]',
    "shipping_cost_paise" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "tracking_url" TEXT,
    "booking_key" TEXT NOT NULL,
    "is_return_pickup" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_tracking_event" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "courier_status_code" TEXT NOT NULL,
    "location" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_tracking_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_request" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "customer_message" TEXT,
    "reverse_pickup_shipment_id" UUID,
    "refund_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_item" (
    "return_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "restockable" BOOLEAN,

    CONSTRAINT "return_item_pkey" PRIMARY KEY ("return_id","order_item_id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "address_user_id_idx" ON "address"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_handle_key" ON "collection"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "collection_legacy_shopify_gid_key" ON "collection"("legacy_shopify_gid");

-- CreateIndex
CREATE UNIQUE INDEX "product_handle_key" ON "product"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "product_legacy_shopify_gid_key" ON "product"("legacy_shopify_gid");

-- CreateIndex
CREATE INDEX "product_status_created_at_idx" ON "product"("status", "created_at");

-- CreateIndex
CREATE INDEX "product_collection_collection_id_position_idx" ON "product_collection"("collection_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_legacy_shopify_gid_key" ON "product_variant"("legacy_shopify_gid");

-- CreateIndex
CREATE INDEX "product_variant_product_id_position_idx" ON "product_variant"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_variant_sku_idx" ON "product_variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_product_id_option_key_key" ON "product_variant"("product_id", "option_key");

-- CreateIndex
CREATE UNIQUE INDEX "product_media_storage_key_key" ON "product_media"("storage_key");

-- CreateIndex
CREATE INDEX "product_media_product_id_position_idx" ON "product_media"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_idempotency_key_key" ON "inventory_movement"("idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_movement_variant_id_occurred_at_idx" ON "inventory_movement"("variant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_movement_reference_type_reference_id_idx" ON "inventory_movement"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_order_id_key" ON "inventory_reservation"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservation_idempotency_key_key" ON "inventory_reservation"("idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_reservation_status_expires_at_idx" ON "inventory_reservation"("status", "expires_at");

-- CreateIndex
CREATE INDEX "cart_user_id_idx" ON "cart"("user_id");

-- CreateIndex
CREATE INDEX "cart_session_id_idx" ON "cart"("session_id");

-- CreateIndex
CREATE INDEX "cart_expires_at_idx" ON "cart"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "cart_line_cart_id_variant_id_key" ON "cart_line"("cart_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_code_key" ON "promotion"("code");

-- CreateIndex
CREATE UNIQUE INDEX "order_number_key" ON "order"("number");

-- CreateIndex
CREATE UNIQUE INDEX "order_submit_key_key" ON "order"("submit_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_legacy_shopify_order_name_key" ON "order"("legacy_shopify_order_name");

-- CreateIndex
CREATE INDEX "order_user_id_created_at_idx" ON "order"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "order_status_created_at_idx" ON "order"("status", "created_at");

-- CreateIndex
CREATE INDEX "order_email_idx" ON "order"("email");

-- CreateIndex
CREATE INDEX "order_item_order_id_idx" ON "order_item"("order_id");

-- CreateIndex
CREATE INDEX "order_item_variant_id_idx" ON "order_item"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_provider_order_id_key" ON "payment_attempt"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_provider_payment_id_key" ON "payment_attempt"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_idempotency_key_key" ON "payment_attempt"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_attempt_order_id_idx" ON "payment_attempt"("order_id");

-- CreateIndex
CREATE INDEX "payment_attempt_status_updated_at_idx" ON "payment_attempt"("status", "updated_at");

-- CreateIndex
CREATE INDEX "provider_event_received_at_idx" ON "provider_event"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_event_provider_event_id_key" ON "provider_event"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_provider_refund_id_key" ON "refund"("provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_idempotency_key_key" ON "refund"("idempotency_key");

-- CreateIndex
CREATE INDEX "refund_payment_attempt_id_idx" ON "refund"("payment_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_provider_shipment_id_key" ON "shipment"("provider_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_awb_key" ON "shipment"("awb");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_booking_key_key" ON "shipment"("booking_key");

-- CreateIndex
CREATE INDEX "shipment_order_id_idx" ON "shipment"("order_id");

-- CreateIndex
CREATE INDEX "shipment_status_updated_at_idx" ON "shipment"("status", "updated_at");

-- CreateIndex
CREATE INDEX "shipment_tracking_event_shipment_id_occurred_at_idx" ON "shipment_tracking_event"("shipment_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_tracking_event_shipment_id_event_id_key" ON "shipment_tracking_event"("shipment_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_reverse_pickup_shipment_id_key" ON "return_request"("reverse_pickup_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_refund_id_key" ON "return_request"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_idempotency_key_key" ON "return_request"("idempotency_key");

-- CreateIndex
CREATE INDEX "return_request_order_id_idx" ON "return_request"("order_id");

-- CreateIndex
CREATE INDEX "return_request_status_updated_at_idx" ON "return_request"("status", "updated_at");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_occurred_at_idx" ON "audit_event"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_correlation_id_idx" ON "audit_event"("correlation_id");

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_collection" ADD CONSTRAINT "product_collection_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_collection" ADD CONSTRAINT "product_collection_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "product_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_line" ADD CONSTRAINT "inventory_reservation_line_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "inventory_reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservation_line" ADD CONSTRAINT "inventory_reservation_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart" ADD CONSTRAINT "cart_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart" ADD CONSTRAINT "cart_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_line" ADD CONSTRAINT "cart_line_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_line" ADD CONSTRAINT "cart_line_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_tracking_event" ADD CONSTRAINT "shipment_tracking_event_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_reverse_pickup_shipment_id_fkey" FOREIGN KEY ("reverse_pickup_shipment_id") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "return_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Rules Prisma cannot express (Stage 04). Each one backs an invariant from lib/modules/contracts.

ALTER SEQUENCE "order_number_seq" OWNED BY "order"."number";

-- Identity: normalized keys
ALTER TABLE "user" ADD CONSTRAINT "user_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "address" ADD CONSTRAINT "address_pin_code_format" CHECK ("pin_code" ~ '^[1-9][0-9]{5}$');
ALTER TABLE "address" ADD CONSTRAINT "address_country_india" CHECK ("country" = 'IN');

-- Catalogue: one active variant per SKU (archived variants keep their SKU for history)
CREATE UNIQUE INDEX "product_variant_sku_active_key" ON "product_variant" ("sku") WHERE "archived_at" IS NULL;
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_price_non_negative" CHECK ("price_paise" >= 0 AND ("compare_at_price_paise" IS NULL OR "compare_at_price_paise" >= 0));
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_sku_not_blank" CHECK (length(btrim("sku")) > 0);
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "product" ADD CONSTRAINT "product_handle_format" CHECK ("handle" ~ '^[a-z0-9][a-z0-9-]{0,254}$');
ALTER TABLE "collection" ADD CONSTRAINT "collection_handle_format" CHECK ("handle" ~ '^[a-z0-9][a-z0-9-]{0,254}$');

-- Inventory: available = on_hand - reserved - allocated, and nothing is ever negative (no overselling)
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_non_negative" CHECK ("on_hand" >= 0 AND "reserved" >= 0 AND "allocated" >= 0);
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_available_non_negative" CHECK ("on_hand" - "reserved" - "allocated" >= 0);
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_quantity_non_zero" CHECK ("quantity" <> 0);
ALTER TABLE "inventory_reservation_line" ADD CONSTRAINT "inventory_reservation_line_quantity_positive" CHECK ("quantity" > 0);

-- Cart: exactly one owner, sane quantities (same limits as the contracts)
ALTER TABLE "cart" ADD CONSTRAINT "cart_single_owner" CHECK (("user_id" IS NULL) <> ("session_id" IS NULL));
ALTER TABLE "cart_line" ADD CONSTRAINT "cart_line_quantity_range" CHECK ("quantity" BETWEEN 1 AND 99);

-- Promotions: a percentage or a fixed amount, never both
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_code_uppercase" CHECK ("code" = upper("code") AND length(btrim("code")) > 0);
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_value_matches_kind" CHECK (
  ("kind" = 'percent' AND "percent_basis_points" BETWEEN 1 AND 10000 AND "amount_off_paise" IS NULL)
  OR ("kind" = 'fixed_amount' AND "amount_off_paise" > 0 AND "percent_basis_points" IS NULL)
);
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_window" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_usage_non_negative" CHECK ("usage_count" >= 0 AND ("usage_limit" IS NULL OR "usage_limit" > 0) AND ("min_subtotal_paise" IS NULL OR "min_subtotal_paise" >= 0));

-- Orders: totals add up in integer paise; tax is added only when prices exclude it (decision 014)
ALTER TABLE "order" ADD CONSTRAINT "order_amounts_non_negative" CHECK ("subtotal_paise" >= 0 AND "discount_total_paise" >= 0 AND "shipping_fee_paise" >= 0 AND "tax_total_paise" >= 0 AND "grand_total_paise" >= 0);
ALTER TABLE "order" ADD CONSTRAINT "order_discount_within_subtotal" CHECK ("discount_total_paise" <= "subtotal_paise");
ALTER TABLE "order" ADD CONSTRAINT "order_grand_total_consistent" CHECK (
  "grand_total_paise" = "subtotal_paise" - "discount_total_paise" + "shipping_fee_paise" + CASE WHEN "prices_include_tax" THEN 0 ELSE "tax_total_paise" END
);
ALTER TABLE "order" ADD CONSTRAINT "order_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "order" ADD CONSTRAINT "order_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_amounts_non_negative" CHECK ("unit_price_paise" >= 0 AND "discount_paise" >= 0 AND "tax_paise" >= 0 AND "line_total_paise" >= 0);

-- Payments and refunds
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_amounts_non_negative" CHECK ("amount_paise" > 0 AND ("captured_amount_paise" IS NULL OR "captured_amount_paise" >= 0));
ALTER TABLE "refund" ADD CONSTRAINT "refund_amount_positive" CHECK ("amount_paise" > 0);
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cost_non_negative" CHECK ("shipping_cost_paise" IS NULL OR "shipping_cost_paise" >= 0);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_quantity_positive" CHECK ("quantity" > 0);

-- Append-only ledgers: inventory movements and audit events can be inserted, never changed
CREATE FUNCTION "reject_append_only_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "inventory_movement_append_only" BEFORE UPDATE OR DELETE ON "inventory_movement" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "inventory_movement_no_truncate" BEFORE TRUNCATE ON "inventory_movement" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "audit_event_append_only" BEFORE UPDATE OR DELETE ON "audit_event" FOR EACH ROW EXECUTE FUNCTION "reject_append_only_change"();
CREATE TRIGGER "audit_event_no_truncate" BEFORE TRUNCATE ON "audit_event" FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_change"();
