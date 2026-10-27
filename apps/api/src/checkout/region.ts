// PIN code and state checks (Stage 12.02). Two questions kept apart:
//
// Format    is this a well-formed PIN (six digits, first 1 to 9) and a real state or union
//           territory code (ISO 3166-2:IN, the 36 codes current since November 2023)? Answered here,
//           with no outside data. Codes replaced in 2023 (CT, OR, TS, UT) and the two merged in 2020
//           (DD, DN) are accepted and stored as their current code.
// Delivery  can a courier deliver to this PIN? Never answered by the format. A well-formed PIN that
//           no courier has confirmed is "unknown", which is not deliverable; only a courier answer
//           (Stage 12.08, ServiceabilityV1) can make it "serviceable", and only a live courier
//           makes it deliverable.
//
// Not checked: whether the PIN lies in the chosen state. India Post's PIN ranges cross state lines
// in places (for example Yanam, Puducherry, has an Andhra Pradesh range), so a prefix table would
// refuse real addresses; the courier's answer covers it.
import type { DeliveryCheckV1 } from "@chaanavya/contracts/modules/checkout"
import type { ServiceabilityV1 } from "@chaanavya/contracts/integrations/courier-gateway"

export const PIN_CODE = /^[1-9][0-9]{5}$/

/** ISO 3166-2:IN subdivision codes and names: 28 states and 8 union territories. */
export const INDIAN_STATES = {
  "IN-AN": "Andaman and Nicobar Islands",
  "IN-AP": "Andhra Pradesh",
  "IN-AR": "Arunachal Pradesh",
  "IN-AS": "Assam",
  "IN-BR": "Bihar",
  "IN-CH": "Chandigarh",
  "IN-CG": "Chhattisgarh",
  "IN-DH": "Dadra and Nagar Haveli and Daman and Diu",
  "IN-DL": "Delhi",
  "IN-GA": "Goa",
  "IN-GJ": "Gujarat",
  "IN-HR": "Haryana",
  "IN-HP": "Himachal Pradesh",
  "IN-JK": "Jammu and Kashmir",
  "IN-JH": "Jharkhand",
  "IN-KA": "Karnataka",
  "IN-KL": "Kerala",
  "IN-LA": "Ladakh",
  "IN-LD": "Lakshadweep",
  "IN-MP": "Madhya Pradesh",
  "IN-MH": "Maharashtra",
  "IN-MN": "Manipur",
  "IN-ML": "Meghalaya",
  "IN-MZ": "Mizoram",
  "IN-NL": "Nagaland",
  "IN-OD": "Odisha",
  "IN-PY": "Puducherry",
  "IN-PB": "Punjab",
  "IN-RJ": "Rajasthan",
  "IN-SK": "Sikkim",
  "IN-TN": "Tamil Nadu",
  "IN-TG": "Telangana",
  "IN-TR": "Tripura",
  "IN-UP": "Uttar Pradesh",
  "IN-UK": "Uttarakhand",
  "IN-WB": "West Bengal",
} as const

export type IndianStateCode = keyof typeof INDIAN_STATES

const REPLACED: Record<string, IndianStateCode> = { "IN-CT": "IN-CG", "IN-OR": "IN-OD", "IN-TS": "IN-TG", "IN-UT": "IN-UK", "IN-DD": "IN-DH", "IN-DN": "IN-DH" }

/** The current state code for a code as entered (any case, "IN-" included), or null. */
export function stateCodeOf(value: string): IndianStateCode | null {
  const code = value.trim().toUpperCase()
  if (Object.hasOwn(INDIAN_STATES, code)) return code as IndianStateCode
  return REPLACED[code] ?? null
}

export function isPinCode(value: unknown): value is string {
  return typeof value === "string" && PIN_CODE.test(value)
}

/**
 * What is known about delivering to a PIN. Format first: a malformed PIN is "invalid_format".
 * A well-formed PIN is "unknown" until a courier has answered for it; only a live courier answer
 * that says serviceable makes it deliverable. A test (sandbox) answer is shown as what it said, with
 * source "test", and never makes a PIN deliverable (Stage 12.08).
 */
export function deliveryCheck(pinCode: unknown, courier: ServiceabilityV1 | null = null, source: "test" | "live" = "live"): DeliveryCheckV1 {
  if (!isPinCode(pinCode)) return { pinCode: typeof pinCode === "string" ? pinCode : "", format: "invalid", delivery: "unknown", deliverable: false, source: "none" }
  if (!courier) return { pinCode, format: "valid", delivery: "unknown", deliverable: false, source: "none" }
  if (courier.reason === "provider_unavailable") return { pinCode, format: "valid", delivery: "unknown", deliverable: false, source }
  if (courier.serviceable && courier.reason === "ok") return { pinCode, format: "valid", delivery: "serviceable", deliverable: source === "live", source }
  return { pinCode, format: "valid", delivery: "not_serviceable", deliverable: false, source }
}
