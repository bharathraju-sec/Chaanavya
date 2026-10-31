// Transactional outbox (Stage 08). Write an event with the same transaction client as the change it
// describes: both commit or neither does. The worker delivers pending events at least once
// (apps/worker/src/jobs/outbox.ts), so handlers must be idempotent.
//
// Topics:
//   catalogue.updated   a product shoppers can see (or could see until now) changed. Payload: product
//                       id, handle, collection handles and why. Never written for draft-only edits, so
//                       events never reveal unpublished products. The worker turns it into a refresh of
//                       the storefront's catalogue caches (Stage 10.10). `change` is `stock` when what
//                       shoppers can buy changed (a stock movement or a signed count).
//   order.paid          an order was confirmed by its verified, captured payment (Stage 14.12). Written in the
//                       same transaction as the confirmation and the stock allocation, once per order. Payload:
//                       order id and number, the payment attempt, the captured amount in paise. Its handler
//                       tells the buyer and staff (notifications arrive in a later stage; until then it is logged).
import type { Tx } from "../db/client.ts"

export type CatalogueUpdated = {
  productId: string
  handle: string
  collections: string[]
  change: "published" | "unpublished" | "archived" | "changed" | "media" | "stock"
}

export type OrderPaid = { orderId: string; orderNumber: string; paymentAttemptId: string; capturedAmountPaise: number; currency: "INR" }

export type OutboxTopic = "catalogue.updated" | "order.paid"

export async function writeOutbox(tx: Tx, topic: OutboxTopic, aggregate: { type: string; id: string }, payload: CatalogueUpdated | OrderPaid) {
  await tx.outboxEvent.create({ data: { topic, aggregateType: aggregate.type, aggregateId: aggregate.id, payload } })
}

/**
 * A stock change that shoppers can see (Stage 10.10): the variant's product is live, so its pages may
 * now say "sold out" or "in stock". Written in the same transaction as the movement or count. Events
 * for products that are not live are never written. While an undelivered stock event already exists
 * for the product another is not added (one refresh covers both), so a burst of holds is one event.
 */
export async function announceStockChange(tx: Tx, variantId: string) {
  const variant = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: { product: { select: { id: true, handle: true, status: true, collections: { select: { collection: { select: { handle: true } } } } } } },
  })
  const product = variant?.product
  if (!product || product.status !== "active") return
  const pending = await tx.outboxEvent.findFirst({
    where: { topic: "catalogue.updated", aggregateId: product.id, dispatchedAt: null, payload: { path: ["change"], equals: "stock" } },
    select: { id: true },
  })
  if (pending) return
  await writeOutbox(tx, "catalogue.updated", { type: "product", id: product.id }, { productId: product.id, handle: product.handle, collections: product.collections.map(c => c.collection.handle), change: "stock" })
}
