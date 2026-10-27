// Indian shipping addresses (Stage 12.01). One shape, IndianAddressV1, read from the request and
// checked here on the server; the browser's own checks are never relied on.
//
// Fields    recipient name, phone, line 1 (house and street), optional line 2 and landmark, city,
//           district, state (ISO 3166-2:IN code), PIN code and country. Mandatory: name, phone,
//           line1, city, district, stateCode, pinCode. Text is trimmed and inner runs of spaces
//           collapsed; control characters are refused. Name, city and district up to 100
//           characters, address lines up to 200.
// Phone     an Indian mobile number (10 digits starting 6 to 9), the number couriers call and
//           text on delivery. Spaces, hyphens, brackets and a +91, 91 or 0 prefix are accepted and
//           stored as E.164 (+91XXXXXXXXXX).
// PIN/state six digits, first digit 1 to 9, and one of the 36 ISO 3166-2:IN codes (./region.ts,
//           Stage 12.02; replaced codes are stored as the current one). A well-formed PIN says
//           nothing about delivery: see deliveryCheck in ./region.ts.
// Country   India only ("IN"); omitted means India.
//
// Two separate uses, never mixed:
// Saved     a customer's address book (table `address`, a verified customer only). Checked here
//           and again by database constraints, so invalid mandatory data cannot be stored even by
//           a direct write. Routes come in Stage 12.03.
// Snapshot  the frozen copy an order keeps (order.shipping_address). A guest only ever has a
//           snapshot: guest addresses are never written to the address book. A snapshot taken from
//           a saved address is a plain copy with no id or owner, so later edits to the address
//           book never change it.
import type { CustomerId } from "@chaanavya/contracts/modules/common"
import type { IndianAddressV1 } from "@chaanavya/contracts/modules/checkout"
import { ApiError } from "../admin/api.ts"
import type { Db, Tx } from "../db/client.ts"
import { isPinCode, stateCodeOf } from "./region.ts"

export const ADDRESS_LIMITS = { name: 100, line: 200, place: 100 }

export const MOBILE_E164 = /^\+91[6-9][0-9]{9}$/

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

type Problems = Record<string, string>

function text(value: unknown, field: string, max: number, problems: Problems, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) problems[field] = "required"
    return null
  }
  if (typeof value !== "string" || CONTROL.test(value)) {
    problems[field] = "invalid"
    return null
  }
  const clean = value.trim().replace(/\s+/g, " ")
  if (!clean) {
    if (required) problems[field] = "required"
    return null
  }
  if (clean.length > max) {
    problems[field] = "too_long"
    return null
  }
  return clean
}

/** An Indian mobile number in E.164, or null when it is not one. */
export function normaliseMobile(value: string): string | null {
  const digits = value.replace(/[\s\-().]/g, "")
  const national = /^(?:\+91|91|0)?([6-9][0-9]{9})$/.exec(digits)
  return national ? `+91${national[1]}` : null
}

/**
 * Checks an address from a request and returns it cleaned. Every problem is reported at once, in
 * `fields` (required, invalid or too_long), with a 400 invalid_request.
 */
export function parseIndianAddress(body: unknown): IndianAddressV1 {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError(400, "invalid_request", "send the address as an object", { address: "invalid" })
  const input = body as Record<string, unknown>
  const problems: Problems = {}

  const name = text(input.name, "name", ADDRESS_LIMITS.name, problems, true)
  const line1 = text(input.line1, "line1", ADDRESS_LIMITS.line, problems, true)
  const line2 = text(input.line2, "line2", ADDRESS_LIMITS.line, problems, false)
  const landmark = text(input.landmark, "landmark", ADDRESS_LIMITS.line, problems, false)
  const city = text(input.city, "city", ADDRESS_LIMITS.place, problems, true)
  const district = text(input.district, "district", ADDRESS_LIMITS.place, problems, true)

  const rawPhone = text(input.phone, "phone", 20, problems, true)
  const phone = rawPhone === null ? null : normaliseMobile(rawPhone)
  if (rawPhone !== null && phone === null) problems.phone = "invalid"

  const rawState = text(input.stateCode, "stateCode", 20, problems, true)
  const stateCode = rawState === null ? null : stateCodeOf(rawState)
  if (rawState !== null && stateCode === null) problems.stateCode = "invalid"

  const pinCode = text(input.pinCode, "pinCode", 20, problems, true)
  if (pinCode !== null && !isPinCode(pinCode)) problems.pinCode = "invalid"

  if (input.country !== undefined && input.country !== null && input.country !== "IN") problems.country = "invalid"

  if (Object.keys(problems).length > 0) throw new ApiError(400, "invalid_request", "check the highlighted address fields", problems)
  return { name: name!, phone: phone!, line1: line1!, line2, landmark, city: city!, district: district!, stateCode: stateCode!, pinCode: pinCode!, country: "IN" }
}

/** The fields a saved address shares with the snapshot. */
const ADDRESS_FIELDS = { name: true, phone: true, line1: true, line2: true, landmark: true, city: true, district: true, stateCode: true, pinCode: true, country: true } as const

type SavedAddressRow = { name: string; phone: string; line1: string; line2: string | null; landmark: string | null; city: string; district: string; stateCode: string; pinCode: string; country: string }

/** A frozen copy of a saved address for an order: the address fields only, no id, owner or flags. */
export function addressSnapshot(saved: SavedAddressRow): IndianAddressV1 {
  const { name, phone, line1, line2, landmark, city, district, stateCode, pinCode } = saved
  return { name, phone, line1, line2, landmark, city, district, stateCode, pinCode, country: "IN" }
}

/** A guest's address: checked and returned as a snapshot. Nothing is written to the address book. */
export function guestAddressSnapshot(body: unknown): IndianAddressV1 {
  return parseIndianAddress(body)
}

/** Adds an address to a customer's address book after checking it. */
export async function saveAddress(db: Db | Tx, customerId: CustomerId, body: unknown, options: { isDefault?: boolean } = {}) {
  const address = parseIndianAddress(body)
  return db.address.create({
    data: { userId: customerId, ...address, isDefault: options.isDefault === true },
    select: { id: true, isDefault: true, ...ADDRESS_FIELDS },
  })
}
