-- Rollback for 20261015000000_init (Stage 04). Destroys every Chaanavya table: rehearsal and
-- development only. Take a backup first (npm run db:backup). Generated with:
--   prisma migrate diff --from-schema prisma/schema.prisma --to-empty --script

-- DropForeignKey
ALTER TABLE "public"."role" DROP CONSTRAINT "role_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."role" DROP CONSTRAINT "role_granted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."session" DROP CONSTRAINT "session_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."customer_profile" DROP CONSTRAINT "customer_profile_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."address" DROP CONSTRAINT "address_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_collection" DROP CONSTRAINT "product_collection_product_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_collection" DROP CONSTRAINT "product_collection_collection_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_variant" DROP CONSTRAINT "product_variant_product_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_variant" DROP CONSTRAINT "product_variant_media_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."product_media" DROP CONSTRAINT "product_media_product_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."inventory_balance" DROP CONSTRAINT "inventory_balance_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."inventory_movement" DROP CONSTRAINT "inventory_movement_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."inventory_reservation" DROP CONSTRAINT "inventory_reservation_order_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."inventory_reservation_line" DROP CONSTRAINT "inventory_reservation_line_reservation_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."inventory_reservation_line" DROP CONSTRAINT "inventory_reservation_line_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."cart" DROP CONSTRAINT "cart_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."cart" DROP CONSTRAINT "cart_session_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."cart_line" DROP CONSTRAINT "cart_line_cart_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."cart_line" DROP CONSTRAINT "cart_line_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."order" DROP CONSTRAINT "order_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."order" DROP CONSTRAINT "order_session_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."order" DROP CONSTRAINT "order_promotion_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."order_item" DROP CONSTRAINT "order_item_order_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."order_item" DROP CONSTRAINT "order_item_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."payment_attempt" DROP CONSTRAINT "payment_attempt_order_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."refund" DROP CONSTRAINT "refund_payment_attempt_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."shipment" DROP CONSTRAINT "shipment_order_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."shipment_tracking_event" DROP CONSTRAINT "shipment_tracking_event_shipment_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."return_request" DROP CONSTRAINT "return_request_order_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."return_request" DROP CONSTRAINT "return_request_reverse_pickup_shipment_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."return_request" DROP CONSTRAINT "return_request_refund_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."return_item" DROP CONSTRAINT "return_item_return_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."return_item" DROP CONSTRAINT "return_item_order_item_id_fkey";

-- DropTable
DROP TABLE "public"."user";

-- DropTable
DROP TABLE "public"."role";

-- DropTable
DROP TABLE "public"."session";

-- DropTable
DROP TABLE "public"."customer_profile";

-- DropTable
DROP TABLE "public"."address";

-- DropTable
DROP TABLE "public"."collection";

-- DropTable
DROP TABLE "public"."product";

-- DropTable
DROP TABLE "public"."product_collection";

-- DropTable
DROP TABLE "public"."product_variant";

-- DropTable
DROP TABLE "public"."product_media";

-- DropTable
DROP TABLE "public"."inventory_balance";

-- DropTable
DROP TABLE "public"."inventory_movement";

-- DropTable
DROP TABLE "public"."inventory_reservation";

-- DropTable
DROP TABLE "public"."inventory_reservation_line";

-- DropTable
DROP TABLE "public"."cart";

-- DropTable
DROP TABLE "public"."cart_line";

-- DropTable
DROP TABLE "public"."promotion";

-- DropTable
DROP TABLE "public"."order";

-- DropTable
DROP TABLE "public"."order_item";

-- DropTable
DROP TABLE "public"."payment_attempt";

-- DropTable
DROP TABLE "public"."provider_event";

-- DropTable
DROP TABLE "public"."refund";

-- DropTable
DROP TABLE "public"."shipment";

-- DropTable
DROP TABLE "public"."shipment_tracking_event";

-- DropTable
DROP TABLE "public"."return_request";

-- DropTable
DROP TABLE "public"."return_item";

-- DropTable
DROP TABLE "public"."audit_event";

-- DropEnum
DROP TYPE "public"."StaffRole";

-- DropEnum
DROP TYPE "public"."SessionKind";

-- DropEnum
DROP TYPE "public"."ActorKind";

-- DropEnum
DROP TYPE "public"."ProductStatus";

-- DropEnum
DROP TYPE "public"."MovementType";

-- DropEnum
DROP TYPE "public"."ReservationStatus";

-- DropEnum
DROP TYPE "public"."PromotionKind";

-- DropEnum
DROP TYPE "public"."OrderStatus";

-- DropEnum
DROP TYPE "public"."FulfilmentStatus";

-- DropEnum
DROP TYPE "public"."PaymentProvider";

-- DropEnum
DROP TYPE "public"."PaymentMode";

-- DropEnum
DROP TYPE "public"."PaymentStatus";

-- DropEnum
DROP TYPE "public"."ProviderEventOutcome";

-- DropEnum
DROP TYPE "public"."RefundStatus";

-- DropEnum
DROP TYPE "public"."CourierProvider";

-- DropEnum
DROP TYPE "public"."ShipmentStatus";

-- DropEnum
DROP TYPE "public"."ReturnStatus";


-- Hand-written objects from prisma/sql/init-constraints.sql (the sequence is dropped with "order").
DROP FUNCTION IF EXISTS "reject_append_only_change"();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261015000000_init';
