// Limited staff actions on an order (Stage 13.13): put it on hold, release the hold, add an internal note.
// Capability orders.manage (ADMIN, OWNER), checked by @Access.permission with a two-factor session.
//
// Hold      stops fulfilment moving forward (packing, packed, handed over) until released; the database
//           refuses those moves on a held order whoever writes them, and transitionFulfilment reports
//           order_on_hold. Cancelling stays possible. Only an open order can be held: pending payment,
//           needs review or confirmed, and not yet handed to the courier.
// Changes   hold and release need a staff reason and the order's ETag (If-Match: 428 when missing, 412
//           when stale), so two staff members cannot undo each other's action unseen. Asking for the
//           state the order is already in is refused (409) and writes nothing.
// Replays   an Idempotency-Key (required for notes, optional for hold and release) makes a retry return
//           the first result without writing again; the same key for a different request is 409.
// Trail     every change writes, in one transaction: the order_admin_action row, an audit event (the
//           note's id and length, never its text) and, for holds, an order_event with a fixed reason code.
import { ApiError, assertIfMatch, etagOf } from "../admin/api.ts"
import { recordAdminEvent } from "../audit/catalogue.ts"
import type { Db, Tx } from "../db/client.ts"
import { isDuplicateKey } from "../inventory/ledger.ts"

export type OrderChange = { actorId: string; correlationId: string; idempotencyKey: string | null }

const HOLDABLE_STATUSES = ["pending_payment", "needs_review", "confirmed"]
const HOLDABLE_FULFILMENT = ["unfulfilled", "packing", "packed"]
const NOTE_MAX = 1000
// Control characters other than tab and line breaks.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** The ETag of an order for staff actions: what a hold or release depends on. */
export const orderEtag = (o: { id: string; status: string; fulfilmentStatus: string; heldAt: Date | null }) =>
  etagOf({ id: o.id, status: o.status, fulfilmentStatus: o.fulfilmentStatus, heldAt: o.heldAt?.toISOString() ?? null })

/** A note's text: trimmed, 1 to 1000 characters, no control characters other than line breaks and tabs. */
export function noteText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length < 1 || text.length > NOTE_MAX || CONTROL.test(text)) {
    throw new ApiError(400, "invalid_request", `a note of 1 to ${NOTE_MAX} characters is required`, { text: "invalid" })
  }
  return text
}

const keyOf = (change: OrderChange) => (change.idempotencyKey ? `staff:${change.actorId}:${change.idempotencyKey}` : null)

/** The earlier action with this key, if the same request is being retried; a different request is refused. */
async function earlier(tx: Tx, change: OrderChange, orderId: string, kind: string, body: string) {
  const key = keyOf(change)
  if (!key) return null
  const found = await tx.orderAdminAction.findUnique({ where: { idempotencyKey: key } })
  if (found && (found.orderId !== orderId || found.kind !== kind || found.body !== body)) throw new ApiError(409, "conflict", "this Idempotency-Key was already used for a different request")
  return found
}

type Locked = { id: string; status: string; fulfilment_status: string; held_at: Date | null }

async function lockOrder(tx: Tx, orderId: string) {
  // FOR NO KEY UPDATE: the order_event row written below takes a KEY SHARE lock on the order.
  const [row] = await tx.$queryRaw<Locked[]>`SELECT id, status::text AS status, fulfilment_status::text AS fulfilment_status, held_at FROM "order" WHERE id = ${orderId}::uuid FOR NO KEY UPDATE`
  if (!row) throw new ApiError(404, "not_found", "not found")
  return row
}

export async function holdState(db: Db, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, fulfilmentStatus: true, heldAt: true, heldBy: true } })
  if (!o) throw new ApiError(404, "not_found", "not found")
  return { held: o.heldAt !== null, heldAt: o.heldAt, heldBy: o.heldBy, etag: orderEtag(o) }
}

/** Puts an order on hold (hold = true) or releases it (hold = false). */
export async function setHold(db: Db, orderId: string, ifMatch: string | undefined, hold: boolean, reason: string, change: OrderChange) {
  const kind = hold ? "hold" : "release"
  try {
    await db.$transaction(async tx => {
      // A retried request with the same key returns the current state without checking the ETag again.
      if (await earlier(tx, change, orderId, kind, reason)) return
      const row = await lockOrder(tx, orderId)
      assertIfMatch(ifMatch, orderEtag({ id: row.id, status: row.status, fulfilmentStatus: row.fulfilment_status, heldAt: row.held_at }))
      if (hold && row.held_at) throw new ApiError(409, "conflict", "the order is already on hold; nothing was changed")
      if (!hold && !row.held_at) throw new ApiError(409, "conflict", "the order is not on hold; nothing was changed")
      if (hold && (!HOLDABLE_STATUSES.includes(row.status) || !HOLDABLE_FULFILMENT.includes(row.fulfilment_status))) {
        throw new ApiError(409, "conflict", `an order that is ${row.status} and ${row.fulfilment_status} cannot be put on hold`)
      }
      await tx.order.update({ where: { id: orderId }, data: hold ? { heldAt: new Date(), heldBy: change.actorId } : { heldAt: null, heldBy: null } })
      await record(tx, orderId, kind, reason, change)
      await tx.orderEvent.create({
        data: { orderId, kind: "hold", subjectId: orderId, fromState: hold ? "released" : "held", toState: hold ? "held" : "released", actorKind: "staff", actorId: change.actorId, correlationId: change.correlationId, reason: hold ? "staff_hold" : "staff_release" },
      })
      await recordAdminEvent(tx, { action: hold ? "order.held" : "order.released", actor: { kind: "staff", id: change.actorId }, entity: { type: "order", id: orderId }, reason, before: { held: !hold }, after: { held: hold }, correlationId: change.correlationId })
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error // a concurrent retry with the same key won; its result stands
  }
  return holdState(db, orderId)
}

/** Adds an internal note. The Idempotency-Key is required, so a retried request never adds it twice. */
export async function addNote(db: Db, orderId: string, text: string, change: OrderChange) {
  if (!change.idempotencyKey) throw new ApiError(400, "invalid_request", "an Idempotency-Key header is required to add a note", { "Idempotency-Key": "required" })
  try {
    const note = await db.$transaction(async tx => {
      const found = await earlier(tx, change, orderId, "note", text)
      if (found) return found
      if (!(await tx.order.findUnique({ where: { id: orderId }, select: { id: true } }))) throw new ApiError(404, "not_found", "not found")
      const created = await record(tx, orderId, "note", text, change)
      await recordAdminEvent(tx, { action: "order.note_added", actor: { kind: "staff", id: change.actorId }, entity: { type: "order", id: orderId }, reason: "", after: { noteId: created.id, length: text.length }, correlationId: change.correlationId })
      return created
    })
    return actionView(note)
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    return actionView(await db.orderAdminAction.findUniqueOrThrow({ where: { idempotencyKey: keyOf(change)! } }))
  }
}

function record(tx: Tx, orderId: string, kind: string, body: string, change: OrderChange) {
  return tx.orderAdminAction.create({ data: { orderId, kind, actorId: change.actorId, body, idempotencyKey: keyOf(change), correlationId: change.correlationId } })
}

/** A hold, release or note as staff see it: the reason or note text, who and when. */
export const actionView = (a: { id: string; kind: string; body: string; actorId: string; createdAt: Date }) => ({ id: a.id, kind: a.kind, text: a.body, actorId: a.actorId, createdAt: a.createdAt })
