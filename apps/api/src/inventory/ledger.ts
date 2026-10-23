// Inventory ledger (Stage 09). The only code that changes a stock balance. Accounting:
//
//   onHand     units physically in the shop's stock (counted, received, minus written off / shipped)
//   reserved   units held for orders awaiting payment (bounded hold, released or allocated once)
//   allocated  units belonging to paid orders, not yet handed to the courier
//   available  onHand - reserved - allocated: what can still be sold. Never negative.
//
// Every movement is one conditional UPDATE of the balance (it only succeeds if no bucket and not
// available would go below zero, so concurrent requests cannot oversell) plus one append-only ledger
// row with the balance after it, in the caller's transaction. A movement with an idempotency key is
// applied at most once: the key is unique in the ledger, so a retry or a concurrent duplicate finds
// the first row (or fails its insert and rolls its whole transaction back).
import { Prisma } from "../db/generated/client.ts"
import type { Tx } from "../db/client.ts"
import type { ActorKind, MovementType } from "../db/generated/enums.ts"
import { announceStockChange } from "../outbox/outbox.ts"

/** How each movement type changes the three buckets, for a positive quantity. */
export const EFFECT: Readonly<Record<MovementType, { onHand: number; reserved: number; allocated: number }>> = {
  receipt: { onHand: 1, reserved: 0, allocated: 0 },
  correction: { onHand: 1, reserved: 0, allocated: 0 },
  return: { onHand: 1, reserved: 0, allocated: 0 },
  write_off: { onHand: -1, reserved: 0, allocated: 0 },
  reservation: { onHand: 0, reserved: 1, allocated: 0 },
  release: { onHand: 0, reserved: -1, allocated: 0 },
  allocation: { onHand: 0, reserved: -1, allocated: 1 },
  fulfilment: { onHand: -1, reserved: 0, allocated: -1 },
}

export type Balance = { onHand: number; reserved: number; allocated: number; version: number }

export class InsufficientStockError extends Error {
  readonly variantId: string
  constructor(variantId: string) {
    super(`not enough stock for ${variantId}`)
    this.variantId = variantId
  }
}

export type MovementInput = {
  variantId: string
  type: MovementType
  /** Units moved. Positive, except corrections, which carry their sign (+found, -missing). */
  quantity: number
  reason: string
  reasonCode: string
  actor: { kind: ActorKind; id: string | null }
  reference: { type: string; id: string }
  idempotencyKey?: string
}

export type MovementResult = { applied: boolean; balance: Balance; movementId: string }

export async function applyMovement(tx: Tx, m: MovementInput): Promise<MovementResult> {
  if (!Number.isSafeInteger(m.quantity) || m.quantity === 0 || (m.type !== "correction" && m.quantity < 0)) throw new Error(`invalid quantity ${m.quantity} for ${m.type}`)
  if (m.idempotencyKey) {
    const earlier = await tx.inventoryMovement.findUnique({ where: { idempotencyKey: m.idempotencyKey }, select: { id: true, variantId: true } })
    if (earlier) {
      if (earlier.variantId !== m.variantId) throw new Error("idempotency key reused for another SKU")
      return { applied: false, balance: await currentBalance(tx, m.variantId), movementId: earlier.id }
    }
  }
  const e = EFFECT[m.type]
  const [dOnHand, dReserved, dAllocated] = [e.onHand * m.quantity, e.reserved * m.quantity, e.allocated * m.quantity]
  const rows = await tx.$queryRaw<{ on_hand: number; reserved: number; allocated: number; version: number }[]>`
    UPDATE "inventory_balance"
       SET "on_hand" = "on_hand" + ${dOnHand}, "reserved" = "reserved" + ${dReserved}, "allocated" = "allocated" + ${dAllocated},
           "version" = "version" + 1, "updated_at" = now()
     WHERE "variant_id" = ${m.variantId}::uuid
       AND "on_hand" + ${dOnHand} >= 0 AND "reserved" + ${dReserved} >= 0 AND "allocated" + ${dAllocated} >= 0
       AND ("on_hand" + ${dOnHand}) - ("reserved" + ${dReserved}) - ("allocated" + ${dAllocated}) >= 0
    RETURNING "on_hand", "reserved", "allocated", "version"`
  if (rows.length !== 1) throw new InsufficientStockError(m.variantId)
  const after = rows[0]
  const movement = await tx.inventoryMovement.create({
    data: {
      variantId: m.variantId,
      type: m.type,
      quantity: m.type === "write_off" ? -m.quantity : m.quantity,
      reason: m.reason,
      reasonCode: m.reasonCode,
      actorKind: m.actor.kind,
      actorId: m.actor.id,
      referenceType: m.reference.type,
      referenceId: m.reference.id,
      idempotencyKey: m.idempotencyKey ?? null,
      onHandAfter: after.on_hand,
      reservedAfter: after.reserved,
      allocatedAfter: after.allocated,
    },
  })
  await announceStockChange(tx, m.variantId)
  return { applied: true, balance: { onHand: after.on_hand, reserved: after.reserved, allocated: after.allocated, version: after.version }, movementId: movement.id }
}

export async function currentBalance(tx: Tx, variantId: string): Promise<Balance> {
  const b = await tx.inventoryBalance.findUnique({ where: { variantId }, select: { onHand: true, reserved: true, allocated: true, version: true } })
  if (!b) throw new Error(`no balance for ${variantId}`)
  return b
}

export const isDuplicateKey = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
