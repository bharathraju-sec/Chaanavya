// Admin sections (Stage 06). Each section is shown only to roles holding its capability, and each
// page checks the same capability on the server. `planned` marks sections whose module does not
// exist yet: their pages say so instead of showing invented data.
import type { Capability } from "@chaanavya/shared/auth/rbac"

export type AdminSection = {
  path: string
  label: string
  capability: Capability
  icon: "overview" | "orders" | "products" | "inventory" | "customers" | "shipments" | "payments" | "returns" | "promotions" | "audit" | "settings"
  planned?: { what: string; arrives: string }
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { path: "", label: "Overview", capability: "orders.read", icon: "overview" },
  { path: "/orders", label: "Orders", capability: "orders.read", icon: "orders", planned: { what: "Orders placed through Chaanavya checkout, with payment and fulfilment status.", arrives: "when Chaanavya checkout and the order module are built" } },
  { path: "/products", label: "Products", capability: "catalogue.read", icon: "products" },
  { path: "/inventory", label: "Inventory", capability: "inventory.read", icon: "inventory" },
  { path: "/customers", label: "Customers", capability: "customers.read", icon: "customers", planned: { what: "Customer accounts and their orders.", arrives: "with customer accounts and order history" } },
  { path: "/shipments", label: "Shipments", capability: "shipments.manage", icon: "shipments", planned: { what: "Courier bookings, labels and tracking.", arrives: "with the courier integration" } },
  { path: "/payments", label: "Payments", capability: "refunds.approve", icon: "payments", planned: { what: "Payment attempts, reconciliation and refunds.", arrives: "with the payment gateway integration" } },
  { path: "/returns", label: "Returns", capability: "returns.inspect", icon: "returns", planned: { what: "Return requests, pickups, inspection and refunds.", arrives: "with the returns module" } },
  { path: "/promotions", label: "Promotions", capability: "promotions.manage", icon: "promotions", planned: { what: "Discount codes with validity windows and usage limits.", arrives: "with the cart and promotions module" } },
  { path: "/audit", label: "Audit trail", capability: "audit.read", icon: "audit" },
  { path: "/settings", label: "Settings", capability: "settings.manage", icon: "settings" },
]

export const sectionFor = (path: string) => ADMIN_SECTIONS.find(s => s.path === path)
