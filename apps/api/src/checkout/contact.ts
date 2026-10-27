// The contact step (Stage 12.04): who to contact and where to deliver, entered for the shopper's own
// bag. A guest completes it without an account: no sign-up, no password, no code. It moves no money,
// reserves no stock and places no order; checkout stays closed until its own gates.
//
// Who       the shopper's current bag only (a guest session or a verified customer). No bag, or a bag
//           that is not theirs, is 404 not_found; an empty bag is 409.
// Email     where order emails go. A guest gives it; a customer's is the account's verified email and
//           a different one is refused. Trimmed and lower-cased; at most 254 characters.
// Phone     the delivery phone on the address (owner decision, 26 October 2026); no separate one.
// Address   checked by parseIndianAddress (12.01, 12.02); stored as a snapshot on the bag, never in a
//           guest's address book (guests have none).
// Consent   order emails need no marketing consent. Marketing sign-up is not offered until the owner
//           approves its wording (Stage 18, owner decision 26 October 2026): a request asking for it is
//           refused and nothing is stored.
// Lifetime  stored with the bag and removed with it; cleared when a guest bag is merged at sign-in.
//           Never logged; responses are no-store.
import type { IsoDateTime, Shopper } from "@chaanavya/contracts/modules/common"
import type { CheckoutContactV1, IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import { ApiError } from "../admin/api.ts"
import { findCurrentCart, lockCartOwner } from "../cart/ownership.ts"
import type { Db } from "../db/client.ts"
import { parseIndianAddress } from "./address.ts"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const notFound = () => new ApiError(404, "not_found", "not found")

export function parseEmail(value: unknown): string {
  if (value === undefined || value === null || value === "") throw new ApiError(400, "invalid_request", "enter an email address for order updates", { email: "required" })
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", "check the email address", { email: "invalid" })
  const email = value.trim().toLowerCase()
  if (!email) throw new ApiError(400, "invalid_request", "enter an email address for order updates", { email: "required" })
  if (email.length > 254 || !EMAIL.test(email)) throw new ApiError(400, "invalid_request", "check the email address", { email: "invalid" })
  return email
}

function marketingRefused(body: Record<string, unknown>) {
  const asked = body.marketingConsent
  if (asked === undefined || asked === null || asked === false) return
  throw new ApiError(400, "invalid_request", "marketing sign-up is not offered yet", { marketingConsent: "not_offered" })
}

function view(row: { email: string; shippingAddress: unknown; updatedAt: Date }): CheckoutContactV1 {
  return { email: row.email, shippingAddress: row.shippingAddress as IndianAddressV1, marketing: "not_offered", updatedAt: row.updatedAt.toISOString() as IsoDateTime }
}

/** The contact details saved for the shopper's bag, or null. */
export async function readContact(db: Db, owner: Shopper | null, now = new Date()) {
  if (!owner) return null
  const cart = await findCurrentCart(db, owner, now)
  if (!cart) return null
  const row = await db.cartContact.findUnique({ where: { cartId: cart.id } })
  return row ? view(row) : null
}

/** Saves the contact step for the shopper's bag. Every field is checked; nothing partial is stored. */
export async function saveContact(db: Db, owner: Shopper | null, body: Record<string, unknown>, now = new Date()) {
  if (!owner) throw notFound()
  marketingRefused(body)
  const problems: Record<string, string> = {}
  let email: string | null = null
  if (owner.kind === "guest") {
    try {
      email = parseEmail(body.email)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      Object.assign(problems, error.fields)
    }
  }
  let shippingAddress: IndianAddressV1 | null = null
  try {
    shippingAddress = parseIndianAddress(body.shippingAddress)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    for (const [field, problem] of Object.entries(error.fields ?? {})) problems[field === "address" ? "shippingAddress" : `shippingAddress.${field}`] = problem
  }
  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted fields", problems)

  return db.$transaction(async tx => {
    // The owner lock first, as every cart writer does, so this queues behind a sign-in merge.
    if (!(await lockCartOwner(tx, owner, now))) throw notFound()
    const cart = await findCurrentCart(tx, owner, now)
    if (!cart) throw notFound()
    if ((await tx.cartLine.count({ where: { cartId: cart.id } })) === 0) throw new ApiError(409, "conflict", "your bag is empty")
    if (owner.kind === "customer") {
      const account = await tx.user.findUniqueOrThrow({ where: { id: owner.customerId }, select: { email: true } })
      const accountEmail = account.email.toLowerCase()
      if (body.email !== undefined && body.email !== null && body.email !== "" && parseEmail(body.email) !== accountEmail) {
        throw new ApiError(400, "invalid_request", "order emails go to your account email", { email: "account_email" })
      }
      email = accountEmail
    }
    const data = { email: email!, shippingAddress: shippingAddress! }
    return view(await tx.cartContact.upsert({ where: { cartId: cart.id }, create: { cartId: cart.id, ...data }, update: data }))
  })
}
