// Staff order reads (Stage 13.12): the order list with filters, one order in full, and the buyer's contact.
// Every route needs a staff role with the capability and a two-factor session (@Access.permission); a
// customer or a visitor never reaches these functions.
//
// Personal data  the list and the order view show the buyer masked: first name and last initial, the
//                email's first letter and domain, the phone's last four digits, and only the town, state
//                and PIN of the address. The full name, email, phone and addresses come only from
//                contactFor (customers.read), and every such read writes a customer.contact_viewed audit
//                event naming the staff member, so who looked at whose details is always on record.
// Money          amounts are whole paise from the order's own rows, never recomputed.
// Reads only     nothing here changes an order, a payment or stock; staff actions (hold, release, notes)
//                are in admin-actions.ts.
import { ORDER_STATUSES, FULFILMENT_STATUSES, PAYMENT_STATUSES, type OrderStatus, type FulfilmentStatus, type PaymentStatus } from "@chaanavya/contracts/modules/state-machines"
import { ApiError, oneOf, pageOf } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db } from "../db/client.ts"
import { toPaise } from "../db/money.ts"
import { actionView, orderEtag } from "./admin-actions.ts"

type Address = { name?: string; phone?: string; line1?: string; line2?: string | null; landmark?: string | null; city?: string; district?: string; stateCode?: string; pinCode?: string }
type Buyer = { kind?: string; email?: string; name?: string; phone?: string }

const NUMBER = /^CHV-\d{1,12}$/
const money = (paise: bigint, currency: string) => ({ amountPaise: toPaise(paise), currency })

/** "Synthetic Buyer" -> "Synthetic B." */
export function maskName(name: string | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ""
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts.at(-1)![0]}.`
}
/** "buyer@example.com" -> "b***@example.com" */
export function maskEmail(email: string | undefined) {
  const [local = "", domain = ""] = (email ?? "").split("@")
  return local && domain ? `${local[0]}***@${domain}` : "***"
}
/** "+91 60000 01234" -> "******1234" */
export function maskPhone(phone: string | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "")
  return digits.length >= 4 ? `******${digits.slice(-4)}` : "***"
}

const buyerOf = (order: { email: string; userId: string | null; customerSnapshot: unknown; shippingAddress: unknown }) => {
  const snap = (order.customerSnapshot ?? {}) as Buyer
  const ship = (order.shippingAddress ?? {}) as Address
  return {
    kind: snap.kind === "customer" || order.userId ? "customer" : "guest",
    name: maskName(snap.name ?? ship.name),
    email: maskEmail(snap.email ?? order.email),
    phone: maskPhone(snap.phone ?? ship.phone),
  }
}
const placeOf = (address: unknown) => {
  const a = (address ?? {}) as Address
  return { city: a.city ?? "", stateCode: a.stateCode ?? "", pinCode: a.pinCode ?? "" }
}

// ---- list ------------------------------------------------------------------------------------

export type OrderFilters = {
  status: OrderStatus | null
  fulfilmentStatus: FulfilmentStatus | null
  paymentStatus: PaymentStatus | null
  placedFrom: Date | null
  placedTo: Date | null
  number: string | null
}

function day(value: string | null, field: string) {
  if (value === null) return null
  const at = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) ? new Date(value) : new Date(NaN)
  if (Number.isNaN(at.getTime())) throw new ApiError(400, "invalid_request", `${field} must be an ISO date`, { [field]: "invalid" })
  return at
}

/** Reads the list filters from the query; anything unknown is refused, not ignored. */
export function filtersOf(query: URLSearchParams): OrderFilters {
  const pick = <T extends string>(name: string, allowed: readonly T[]) => (query.get(name) === null ? null : oneOf(query.get(name), allowed, name))
  const number = query.get("number")?.trim().toUpperCase() ?? null
  if (number !== null && !NUMBER.test(number)) throw new ApiError(400, "invalid_request", "number must look like CHV-1001", { number: "invalid" })
  return {
    status: pick("status", ORDER_STATUSES),
    fulfilmentStatus: pick("fulfilmentStatus", FULFILMENT_STATUSES),
    paymentStatus: pick("paymentStatus", PAYMENT_STATUSES),
    placedFrom: day(query.get("placedFrom"), "placedFrom"),
    placedTo: day(query.get("placedTo"), "placedTo"),
    number,
  }
}

export type OrderCursor = { createdAt: string; id: string }
export const isOrderCursor = (v: unknown): v is OrderCursor => typeof (v as OrderCursor)?.createdAt === "string" && typeof (v as OrderCursor)?.id === "string"

/** Newest first, `limit` at a time. */
export async function listOrders(db: Db, filters: OrderFilters, { limit, after }: { limit: number; after: OrderCursor | null }) {
  const at = after ? new Date(after.createdAt) : null
  if (at && Number.isNaN(at.getTime())) throw new ApiError(400, "invalid_request", "cursor is malformed", { cursor: "malformed" })
  const rows = await db.order.findMany({
    where: {
      ...(filters.status && { status: filters.status }),
      ...(filters.fulfilmentStatus && { fulfilmentStatus: filters.fulfilmentStatus }),
      ...(filters.paymentStatus && { payments: { some: { status: filters.paymentStatus } } }),
      ...(filters.number && { number: filters.number }),
      ...((filters.placedFrom || filters.placedTo) && { createdAt: { ...(filters.placedFrom && { gte: filters.placedFrom }), ...(filters.placedTo && { lt: filters.placedTo }) } }),
      ...(at && after && { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: after.id } }] }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      number: true,
      status: true,
      fulfilmentStatus: true,
      grandTotalPaise: true,
      currency: true,
      email: true,
      userId: true,
      customerSnapshot: true,
      shippingAddress: true,
      payableUntil: true,
      heldAt: true,
      createdAt: true,
      _count: { select: { items: true } },
      payments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
  })
  const { items, nextCursor } = pageOf(rows, limit, r => ({ createdAt: r.createdAt.toISOString(), id: r.id }))
  return {
    items: items.map(o => ({
      id: o.id,
      number: o.number,
      status: o.status,
      fulfilmentStatus: o.fulfilmentStatus,
      paymentStatus: o.payments[0]?.status ?? null,
      grandTotal: money(o.grandTotalPaise, o.currency),
      lines: o._count.items,
      held: o.heldAt !== null,
      buyer: buyerOf(o),
      deliverTo: placeOf(o.shippingAddress),
      payableUntil: o.payableUntil,
      createdAt: o.createdAt,
    })),
    nextCursor,
  }
}

// ---- one order -------------------------------------------------------------------------------

export async function loadOrder(db: Db, id: string) {
  const o = await db.order.findUnique({
    where: { id },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
      reservation: { select: { status: true, expiresAt: true } },
      events: { orderBy: { occurredAt: "asc" } },
      adminActions: { orderBy: { createdAt: "asc" } },
      recoveryCases: { orderBy: { detectedAt: "asc" }, select: { id: true, kind: true, status: true, check: true, detectedAt: true, closedAt: true } },
    },
  })
  if (!o) throw new ApiError(404, "not_found", "not found")
  const exceptions = await db.auditEvent.findMany({ where: { action: "payment.late_capture", entityType: "order", entityId: id }, orderBy: { occurredAt: "asc" }, select: { reason: true, after: true, occurredAt: true } })
  const shipping = (o.shippingSnapshot ?? null) as { courierName?: string; mode?: string; estimatedDeliveryDays?: number } | null
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    fulfilmentStatus: o.fulfilmentStatus,
    buyer: buyerOf(o),
    deliverTo: placeOf(o.shippingAddress),
    totals: {
      subtotal: money(o.subtotalPaise, o.currency),
      discount: money(o.discountTotalPaise, o.currency),
      shipping: money(o.shippingFeePaise, o.currency),
      tax: money(o.taxTotalPaise, o.currency),
      grandTotal: money(o.grandTotalPaise, o.currency),
      pricesIncludeTax: o.pricesIncludeTax,
    },
    items: o.items.map(i => ({
      sku: i.sku,
      productTitle: i.productTitle,
      variantTitle: i.variantTitle,
      hsnCode: i.hsnCode,
      quantity: i.quantity,
      unitPricePaise: toPaise(i.unitPricePaise),
      discountPaise: toPaise(i.discountPaise),
      taxPaise: toPaise(i.taxPaise),
      lineTotalPaise: toPaise(i.lineTotalPaise),
    })),
    delivery: shipping ? { courierName: shipping.courierName ?? null, mode: shipping.mode ?? null, estimatedDeliveryDays: shipping.estimatedDeliveryDays ?? null } : null,
    payments: o.payments.map(p => ({
      id: p.id,
      provider: p.provider,
      mode: p.mode,
      status: p.status,
      amountPaise: toPaise(p.amountPaise),
      capturedAmountPaise: p.capturedAmountPaise === null ? null : toPaise(p.capturedAmountPaise),
      createdAt: p.createdAt,
    })),
    stockHold: o.reservation ? { status: o.reservation.status, expiresAt: o.reservation.expiresAt } : null,
    exceptions: exceptions.map(e => {
      const after = (e.after ?? {}) as { paymentAttemptId?: string; capturedAmountPaise?: number }
      return { reason: e.reason, paymentAttemptId: after.paymentAttemptId ?? null, capturedAmountPaise: after.capturedAmountPaise ?? null, occurredAt: e.occurredAt }
    }),
    events: o.events.map(e => ({ kind: e.kind, fromState: e.fromState, toState: e.toState, actorKind: e.actorKind, reason: e.reason, occurredAt: e.occurredAt })),
    hold: o.heldAt ? { heldAt: o.heldAt, heldBy: o.heldBy } : null,
    staffActions: o.adminActions.map(actionView),
    recoveryCases: o.recoveryCases,
    payableUntil: o.payableUntil,
    createdAt: o.createdAt,
    etag: orderEtag(o),
  }
}

// ---- contact (customers.read, audited) -------------------------------------------------------

const fullAddress = (address: unknown) => {
  if (!address) return null
  const a = address as Address
  return { name: a.name ?? "", phone: a.phone ?? "", line1: a.line1 ?? "", line2: a.line2 ?? null, landmark: a.landmark ?? null, city: a.city ?? "", district: a.district ?? "", stateCode: a.stateCode ?? "", pinCode: a.pinCode ?? "" }
}

/** The buyer's full contact details, for one order; the read is recorded in the same transaction. */
export async function contactFor(db: Db, id: string, staff: { userId: string }, correlationId: string) {
  return db.$transaction(async tx => {
    const o = await tx.order.findUnique({ where: { id }, select: { id: true, email: true, customerSnapshot: true, shippingAddress: true, billingAddress: true } })
    if (!o) throw new ApiError(404, "not_found", "not found")
    const snap = (o.customerSnapshot ?? {}) as Buyer
    const ship = fullAddress(o.shippingAddress)
    await recordAdminEvent(tx, { action: "customer.contact_viewed", actor: { kind: "staff", id: staff.userId }, entity: { type: "order", id: o.id }, reason: "order contact viewed", after: { fields: "name,email,phone,shippingAddress,billingAddress" }, correlationId })
    return { name: snap.name ?? ship?.name ?? "", email: snap.email ?? o.email, phone: snap.phone ?? ship?.phone ?? "", shippingAddress: ship, billingAddress: fullAddress(o.billingAddress) }
  })
}
