-- Rollback for 20261031010000_payment_webhook_inbox (Stage 14.10). The inbox and its events are lost; payment
-- attempts, orders, stock and provider_event are untouched, since the inbox changes none of them itself.
DROP TABLE IF EXISTS "payment_webhook_inbox";
DROP FUNCTION IF EXISTS "payment_webhook_inbox_kept"();
DROP FUNCTION IF EXISTS "payment_webhook_inbox_guard"();
DROP TYPE IF EXISTS "WebhookInboxStatus";
