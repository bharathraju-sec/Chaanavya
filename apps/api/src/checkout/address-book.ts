// A customer's saved addresses (Stage 12.03): list, add, edit, delete and choose the default.
//
// Who       a signed-in customer with a verified email, on their own addresses only. Every lookup
//           is by address id AND the customer's id, so another customer's address, a made-up id and
//           a deleted address all get the same 404 not_found and nothing changes; a refusal never
//           tells anyone that the address exists. Guests have no address book (12.01).
// Body      { address: {...}, isDefault? } to add; { address: {only the fields to change} } to edit.
// Checks    every write goes through parseIndianAddress (12.01, 12.02) and the database constraints.
//           An edit is merged onto the stored address and the whole result checked again.
// Default   at most one per customer (partial unique index address_one_default_per_user). The first
//           address becomes the default; deleting the default makes the newest remaining one the
//           default. Writes lock the customer's row first (the same owner lock as the cart, F01),
//           so concurrent changes queue instead of racing.
// Limit     ADDRESS_BOOK_LIMIT addresses per customer.
// Orders    keep their own frozen copy (addressSnapshot), so editing or deleting here never changes
//           an order.
// Privacy   address text is never logged or audited; errors name fields, not values.
import type { AddressId, IsoDateTime } from "@chaanavya/contracts/modules/common"
import type { SavedAddressV1 } from "@chaanavya/contracts/modules/checkout"
import { ApiError } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import { addressSnapshot, parseIndianAddress } from "./address.ts"

export const ADDRESS_BOOK_LIMIT = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SELECT = { id: true, name: true, phone: true, line1: true, line2: true, landmark: true, city: true, district: true, stateCode: true, pinCode: true, country: true, isDefault: true, updatedAt: true } as const

type Row = { id: string; name: string; phone: string; line1: string; line2: string | null; landmark: string | null; city: string; district: string; stateCode: string; pinCode: string; country: string; isDefault: boolean; updatedAt: Date }

export type AddressOwner = { userId: string; emailVerified: boolean }

const notFound = () => new ApiError(404, "not_found", "address not found")

function view(row: Row): SavedAddressV1 {
  return { version: 1, id: row.id as AddressId, address: addressSnapshot(row), isDefault: row.isDefault, updatedAt: row.updatedAt.toISOString() as IsoDateTime }
}

function verified(owner: AddressOwner) {
  if (owner.emailVerified !== true) throw new ApiError(403, "forbidden", "verify your email to save addresses")
  return owner.userId
}

/** Locks the customer's row; every address write takes it first. */
async function lockOwner(tx: Tx, userId: string) {
  const [user] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (email_verified AND disabled_at IS NULL) AS ok FROM "user" WHERE id = ${userId}::uuid FOR UPDATE`
  if (!user?.ok) throw new ApiError(403, "forbidden", "verify your email to save addresses")
}

async function ownRow(tx: Tx, userId: string, addressId: string) {
  if (!UUID.test(addressId)) throw notFound()
  const row = await tx.address.findFirst({ where: { id: addressId, userId }, select: SELECT })
  if (!row) throw notFound()
  return row
}

const newestFirst = [{ isDefault: "desc" as const }, { updatedAt: "desc" as const }, { id: "desc" as const }]

export async function listAddresses(db: Db | Tx, owner: AddressOwner) {
  const userId = verified(owner)
  const rows = await db.address.findMany({ where: { userId }, orderBy: newestFirst, select: SELECT, take: ADDRESS_BOOK_LIMIT })
  return rows.map(view)
}

export async function createAddress(db: Db, owner: AddressOwner, body: Record<string, unknown>) {
  const userId = verified(owner)
  const address = parseIndianAddress(body.address)
  const wantsDefault = body.isDefault === true
  return db.$transaction(async tx => {
    await lockOwner(tx, userId)
    const count = await tx.address.count({ where: { userId } })
    if (count >= ADDRESS_BOOK_LIMIT) throw new ApiError(409, "conflict", `an address book holds up to ${ADDRESS_BOOK_LIMIT} addresses`)
    const isDefault = wantsDefault || count === 0
    if (isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } })
    return view(await tx.address.create({ data: { userId, ...address, isDefault }, select: SELECT }))
  })
}

export async function updateAddress(db: Db, owner: AddressOwner, addressId: string, body: Record<string, unknown>) {
  const userId = verified(owner)
  const changes = body.address as Record<string, unknown>
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) throw new ApiError(400, "invalid_request", "send the address as an object", { address: "invalid" })
  return db.$transaction(async tx => {
    await lockOwner(tx, userId)
    const current = await ownRow(tx, userId, addressId)
    const merged = { ...addressSnapshot(current) } as Record<string, unknown>
    for (const field of ["name", "phone", "line1", "line2", "landmark", "city", "district", "stateCode", "pinCode", "country"]) {
      if (Object.hasOwn(changes, field)) merged[field] = changes[field]
    }
    const address = parseIndianAddress(merged)
    const { count } = await tx.address.updateMany({ where: { id: current.id, userId }, data: address })
    if (count !== 1) throw notFound()
    return view(await ownRow(tx, userId, current.id))
  })
}

export async function setDefaultAddress(db: Db, owner: AddressOwner, addressId: string) {
  const userId = verified(owner)
  return db.$transaction(async tx => {
    await lockOwner(tx, userId)
    const current = await ownRow(tx, userId, addressId)
    if (!current.isDefault) {
      await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } })
      await tx.address.updateMany({ where: { id: current.id, userId }, data: { isDefault: true } })
    }
    return view(await ownRow(tx, userId, current.id))
  })
}

export async function deleteAddress(db: Db, owner: AddressOwner, addressId: string) {
  const userId = verified(owner)
  await db.$transaction(async tx => {
    await lockOwner(tx, userId)
    const current = await ownRow(tx, userId, addressId)
    const { count } = await tx.address.deleteMany({ where: { id: current.id, userId } })
    if (count !== 1) throw notFound()
    if (current.isDefault) {
      const next = await tx.address.findFirst({ where: { userId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { id: true } })
      if (next) await tx.address.updateMany({ where: { id: next.id, userId }, data: { isDefault: true } })
    }
  })
}
