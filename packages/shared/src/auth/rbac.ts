// Staff roles and capabilities (Stage 05). Pure data and functions; the API's access guard
// (apps/api/src/http/access.ts) enforces them on the server. Hiding a button in the UI is never the check.
//
// OWNER: everything, including staff, settings and large refunds.
// ADMIN: runs the shop day to day, but cannot manage staff or settings.
// STAFF: fulfils orders and handles returns; reads what that work needs.
//
// Catalogue (Stage 08): STAFF read products; ADMIN also edit drafts, variants and photos;
// publishing, approving photos and editing a live product is OWNER only (catalogue.publish), so
// claims, prices and descriptions reach shoppers only after an owner confirms them (proposed,
// decision 033).
//
// Inventory (Stage 09): STAFF read stock; ADMIN also receive, adjust, write off and count stock;
// approving a stocktake (signing the reconciliation report that makes counts sellable) is OWNER
// only (inventory.approve, proposed in decision 035).

export const STAFF_ROLES = ["OWNER", "ADMIN", "STAFF"] as const
export type StaffRole = (typeof STAFF_ROLES)[number]

export const CAPABILITIES = [
  "orders.read",
  "orders.manage",
  "orders.pack",
  "customers.read",
  "catalogue.read",
  "catalogue.write",
  "catalogue.publish",
  "inventory.read",
  "inventory.adjust",
  "inventory.approve",
  "shipments.manage",
  "returns.inspect",
  "returns.manage",
  "refunds.approve",
  "refunds.approve_large",
  "promotions.manage",
  "audit.read",
  "staff.manage",
  "settings.manage",
] as const
export type Capability = (typeof CAPABILITIES)[number]

const STAFF: readonly Capability[] = ["orders.read", "orders.pack", "customers.read", "catalogue.read", "inventory.read", "shipments.manage", "returns.inspect"]
const ADMIN: readonly Capability[] = [
  ...STAFF,
  "orders.manage",
  "catalogue.write",
  "inventory.adjust",
  "returns.manage",
  "refunds.approve",
  "promotions.manage",
  "audit.read",
]

export const ROLE_CAPABILITIES: Readonly<Record<StaffRole, readonly Capability[]>> = {
  OWNER: CAPABILITIES,
  ADMIN,
  STAFF,
}

/** Union of the capabilities of every role held. Unknown role names grant nothing. */
export function capabilitiesFor(roles: readonly string[]): Set<Capability> {
  const granted = new Set<Capability>()
  for (const role of roles) for (const capability of ROLE_CAPABILITIES[role as StaffRole] ?? []) granted.add(capability)
  return granted
}

export const can = (roles: readonly string[], capability: Capability) => capabilitiesFor(roles).has(capability)
