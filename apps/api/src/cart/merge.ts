// Guest-to-customer merge policy (Stage 11.07; applied in one transaction by Stage 11.08). Decided by
// the owner on 25 October 2026. This file is the policy: a pure function from the two bags to the
// merged bag, with no database access, so the same two bags always give the same result.
//
// Same item   the larger of the two quantities, capped at the per-line limit (guest 2 + account 1
//             gives 2). Not capped at the stock free now: a bag may already hold more than is free,
//             and stock is checked again at quote time. Taking the larger also means merging the
//             same guest bag twice gives the same result.
// Unavailable guest items no longer on sale, or out of stock, are brought over like any other line
//             and shown flagged in the bag (the read already flags items that are off sale), so
//             the shopper decides whether to remove them.
// Line limit  every account line stays. Guest items for variants the account bag does not hold
//             fill the remaining room, most recently added first (ties by line id); the rest are
//             reported as left behind.
// Expired     only live bags take part: an expired guest bag or guest session has nothing to merge,
//             and an expired account bag is replaced by a new one before merging.
// Afterwards  the guest bag is emptied and its guest session revoked (11.08), so signing out never
//             brings the old guest bag back and nothing is merged twice.
// Ownership   the guest cart never becomes the customer's: its lines are copied into the account
//             cart and the guest cart keeps its guest owner (CHECK cart_single_owner). Prices are
//             never copied; lines hold only a variant and a quantity.
import { CART_LIMITS } from "./cart.ts"

export type MergeInputLine = { id: string; variantId: string; quantity: number; createdAt: Date }

export type MergedLine = {
  variantId: string
  quantity: number
  /** Where the merged quantity came from. */
  source: "account" | "guest" | "both"
}

export type MergePlan = {
  /** The account bag after the merge: account lines in their order, then guest additions. */
  lines: MergedLine[]
  /** Guest lines that did not fit under the line limit, newest first. */
  leftBehind: { variantId: string; quantity: number }[]
  /** False when the guest bag adds nothing (empty, or every quantity already covered). */
  changesAccount: boolean
}

const byNewest = (a: MergeInputLine, b: MergeInputLine) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byOldest = (a: MergeInputLine, b: MergeInputLine) => -byNewest(a, b)

/**
 * Merges a guest bag into an account bag. Deterministic: the result depends only on the lines'
 * variants, quantities, creation times and ids, never on the order they are passed in.
 */
export function planMerge(account: readonly MergeInputLine[], guest: readonly MergeInputLine[], limits = CART_LIMITS): MergePlan {
  // One line per variant on each side (the database enforces this; the policy does not rely on it).
  const accountByVariant = new Map<string, MergeInputLine>()
  for (const line of [...account].sort(byOldest)) if (!accountByVariant.has(line.variantId)) accountByVariant.set(line.variantId, line)
  const guestByVariant = new Map<string, MergeInputLine>()
  for (const line of [...guest].sort(byNewest)) if (!guestByVariant.has(line.variantId)) guestByVariant.set(line.variantId, line)

  // Quantities are whole numbers from 1 to the per-line limit (the database holds them in range too).
  const cap = (q: number) => Math.min(limits.maxQuantity, Math.max(1, Math.trunc(q)))
  let changesAccount = false
  const lines: MergedLine[] = [...accountByVariant.values()].map(a => {
    const mine = cap(a.quantity)
    const g = guestByVariant.get(a.variantId)
    if (!g) return { variantId: a.variantId, quantity: mine, source: "account" }
    const theirs = cap(g.quantity)
    if (theirs > mine) changesAccount = true
    return { variantId: a.variantId, quantity: Math.max(mine, theirs), source: theirs > mine ? "guest" : theirs === mine ? "both" : "account" }
  })

  const leftBehind: MergePlan["leftBehind"] = []
  const additions = [...guestByVariant.values()].filter(g => !accountByVariant.has(g.variantId)).sort(byNewest)
  for (const g of additions) {
    if (lines.length < limits.maxLines) {
      lines.push({ variantId: g.variantId, quantity: cap(g.quantity), source: "guest" })
      changesAccount = true
    } else leftBehind.push({ variantId: g.variantId, quantity: cap(g.quantity) })
  }
  return { lines, leftBehind, changesAccount }
}
