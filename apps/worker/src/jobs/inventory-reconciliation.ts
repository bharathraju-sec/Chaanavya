// Inventory reconciliation (Stage 09). Hourly, read-only checks that the books agree with themselves:
//   reserved  = units in active reservations, per SKU
//   allocated = units in allocated reservations, per SKU
//   onHand    = receipts + corrections + returns - write-offs - fulfilments in the ledger, per SKU
//               (only for SKUs whose first ledger row predates nothing else: balances created with
//               a starting quantity outside the ledger, like the synthetic seed, are reported once)
// It never "fixes" a balance: a mismatch is an audit event (inventory.discrepancy) for staff to
// investigate, written at most once per SKU and problem per day.
import type { Tx } from "@chaanavya/api/db/client"
import type { Job, JobResult } from "../runner.ts"

type Row = { variant_id: string; on_hand: number; reserved: number; allocated: number; held: number; shipping: number; ledger_on_hand: number | null }

export const reconciliationQuery = (tx: Tx) => tx.$queryRaw<Row[]>`
  SELECT b."variant_id", b."on_hand", b."reserved", b."allocated",
         COALESCE((SELECT sum(l."quantity") FROM "inventory_reservation_line" l JOIN "inventory_reservation" r ON r."id" = l."reservation_id" WHERE l."variant_id" = b."variant_id" AND r."status" = 'active'), 0)::int AS "held",
         COALESCE((SELECT sum(l."quantity") FROM "inventory_reservation_line" l JOIN "inventory_reservation" r ON r."id" = l."reservation_id" WHERE l."variant_id" = b."variant_id" AND r."status" = 'allocated'), 0)::int AS "shipping",
         (SELECT sum(CASE m."type" WHEN 'fulfilment' THEN -m."quantity" WHEN 'receipt' THEN m."quantity" WHEN 'correction' THEN m."quantity" WHEN 'return' THEN m."quantity" WHEN 'write_off' THEN m."quantity" ELSE 0 END)
            FROM "inventory_movement" m WHERE m."variant_id" = b."variant_id")::int AS "ledger_on_hand"
    FROM "inventory_balance" b`

export function problemsOf(row: Row): string[] {
  const problems: string[] = []
  if (row.reserved !== row.held) problems.push(`reserved ${row.reserved} but active reservations hold ${row.held}`)
  if (row.allocated !== row.shipping) problems.push(`allocated ${row.allocated} but allocated reservations hold ${row.shipping}`)
  if ((row.ledger_on_hand ?? 0) !== row.on_hand) problems.push(`on hand ${row.on_hand} but the ledger adds up to ${row.ledger_on_hand ?? 0}`)
  return problems
}

export const inventoryReconciliationJob: Job = {
  name: "inventory-reconciliation",
  lockKey: 7_005,
  everyMs: 60 * 60 * 1000,
  async run(tx: Tx): Promise<JobResult> {
    const rows = await reconciliationQuery(tx)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    let mismatched = 0
    let reported = 0
    for (const row of rows) {
      const problems = problemsOf(row)
      if (!problems.length) continue
      mismatched++
      for (const problem of problems) {
        const seen = await tx.auditEvent.count({ where: { action: "inventory.discrepancy", entityId: row.variant_id, occurredAt: { gte: since }, after: { path: ["problem"], equals: problem } } })
        if (seen) continue
        await tx.auditEvent.create({
          data: { action: "inventory.discrepancy", actorKind: "system", actorId: "system:inventory-reconciliation", entityType: "product_variant", entityId: row.variant_id, reason: "reconciliation", after: { problem }, correlationId: `worker:inventory-reconciliation:${Date.now()}` },
        })
        reported++
      }
    }
    return { checked: rows.length, mismatched, reported }
  },
}
