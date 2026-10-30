// Status vocabularies and allowed transitions for the Chaanavya commerce modules (Stage 02).
// Order, payment, reservation, fulfilment, shipment, return and refund statuses are separate
// machines: none is derived by copying another, and each has one authority (docs/architecture/
// commerce-contracts.md). This file is the single source of the transition tables; the state
// machine document is generated from it (scripts/print-state-machines.mjs).
//
// Runtime code, but self-contained: no runtime imports, so Node can load it directly in tests.

export const ORDER_STATUSES = ["pending_payment", "needs_review", "confirmed", "completed", "cancelled"] as const
export const PAYMENT_STATUSES = ["created", "authorized", "captured", "pending_reconciliation", "failed", "expired", "partially_refunded", "refunded"] as const
export const RESERVATION_STATUSES = ["active", "allocated", "released", "fulfilled"] as const
export const FULFILMENT_STATUSES = ["unfulfilled", "packing", "packed", "handed_over", "cancelled"] as const
export const SHIPMENT_STATUSES = [
  "booking_requested",
  "booked",
  "pickup_scheduled",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "rto_initiated",
  "rto_delivered",
  "cancelled",
  "lost",
] as const
export const RETURN_STATUSES = ["requested", "under_review", "pickup_initiated", "returned", "inspected", "approved", "rejected", "refunded", "withdrawn", "closed"] as const
export const REFUND_STATUSES = ["requested", "processing", "succeeded", "failed", "rejected"] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number]
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export type RefundStatus = (typeof REFUND_STATUSES)[number]

/** Who reported the change. Provider means a verified webhook or a server-side provider lookup. */
export type FactSource = "provider" | "staff" | "customer" | "system"

/**
 * Facts a guard may read. Callers load them inside the same database transaction as the write
 * (Stage 13); a missing fact counts as "not satisfied", so guards fail closed.
 */
export type GuardFacts = {
  source?: FactSource
  orderStatus?: OrderStatus
  /** Status of the order's most recent payment attempt. */
  paymentStatus?: PaymentStatus
  reservationStatus?: ReservationStatus
  fulfilmentStatus?: FulfilmentStatus
  /** Captured amount and currency equal the order's grand total. */
  amountMatches?: boolean
  reservationExpired?: boolean
  /** Holder of the needed permission approved this action (checked by the caller, Stage 05/06). */
  staffApproved?: boolean
  refundRequested?: boolean
  /** Total refunded equals the captured amount. */
  refundFullyCovered?: boolean
  refundSucceeded?: boolean
  withinReturnWindow?: boolean
  /** Any payment attempt exists for the order (Stage 13.09). False means the shopper never started paying. */
  paymentStarted?: boolean
  /** The shopper or staff asked to cancel the order before paying (Stage 13.09). */
  cancelRequested?: boolean
  hasAwb?: boolean
  allShipmentsDelivered?: boolean
}

export type Transition<S extends string> = {
  from: S
  to: S
  /** Stable identifier used in logs, audit events and tests. */
  precondition: string
  description: string
  guard: (facts: GuardFacts) => boolean
}

export type StateMachine<S extends string> = {
  name: string
  states: readonly S[]
  initial: S
  terminal: readonly S[]
  transitions: readonly Transition<S>[]
}

const fromProvider = (f: GuardFacts) => f.source === "provider"
const byStaff = (f: GuardFacts) => f.source === "staff" && f.staffApproved === true
const paymentClosedWithoutCapture = (f: GuardFacts) => f.paymentStatus === "failed" || f.paymentStatus === "expired"
const beforeDispatch = (f: GuardFacts) => f.fulfilmentStatus === "unfulfilled" || f.fulfilmentStatus === "packing" || f.fulfilmentStatus === "packed"

export const ORDER_MACHINE: StateMachine<OrderStatus> = {
  name: "order",
  states: ORDER_STATUSES,
  initial: "pending_payment",
  terminal: ["completed", "cancelled"],
  transitions: [
    {
      from: "pending_payment",
      to: "confirmed",
      precondition: "payment_captured_amount_matches_stock_allocated",
      description: "A verified capture for exactly the order total exists and the reservation was converted to allocated stock.",
      guard: f => f.paymentStatus === "captured" && f.amountMatches === true && f.reservationStatus === "allocated",
    },
    {
      from: "pending_payment",
      to: "needs_review",
      precondition: "capture_mismatched_or_stock_released",
      description: "Money was captured but the amount differs or the reservation was already released (late capture). Never auto-confirmed.",
      guard: f => f.paymentStatus === "captured" && (f.amountMatches === false || f.reservationStatus === "released"),
    },
    {
      from: "pending_payment",
      to: "cancelled",
      precondition: "payment_closed_without_capture_and_stock_released",
      description: "No payment was started, or the payment attempt failed or expired with no capture; and the reservation has been released (Stage 13.09).",
      guard: f => (paymentClosedWithoutCapture(f) || f.paymentStarted === false) && f.reservationStatus === "released",
    },
    {
      from: "needs_review",
      to: "confirmed",
      precondition: "staff_resolved_with_allocated_stock",
      description: "Permitted staff resolved the exception: capture matches and stock is allocated again.",
      guard: f => byStaff(f) && f.paymentStatus === "captured" && f.amountMatches === true && f.reservationStatus === "allocated",
    },
    {
      from: "needs_review",
      to: "cancelled",
      precondition: "staff_cancelled_with_refund_requested",
      description: "Permitted staff cancelled the exception and a refund for the captured money has been requested.",
      guard: f => byStaff(f) && f.refundRequested === true,
    },
    {
      from: "confirmed",
      to: "cancelled",
      precondition: "cancelled_before_courier_handover",
      description: "Staff cancel a paid order before the parcel reaches the courier, with a refund requested; the buyer asks the shop. After handover only returns or RTO apply.",
      guard: f => beforeDispatch(f) && f.refundRequested === true && byStaff(f),
    },
    {
      from: "confirmed",
      to: "completed",
      precondition: "handed_over_and_all_shipments_delivered",
      description: "Every shipment for the order has a courier delivered scan.",
      guard: f => f.fulfilmentStatus === "handed_over" && f.allShipmentsDelivered === true,
    },
  ],
}

export const PAYMENT_MACHINE: StateMachine<PaymentStatus> = {
  name: "payment",
  states: PAYMENT_STATUSES,
  initial: "created",
  terminal: ["failed", "expired", "refunded"],
  transitions: [
    { from: "created", to: "authorized", precondition: "provider_reports_authorized", description: "Verified provider event or lookup says the payment is authorized.", guard: fromProvider },
    { from: "created", to: "captured", precondition: "provider_reports_captured", description: "Verified provider event or lookup says the payment is captured (auto-capture).", guard: fromProvider },
    { from: "created", to: "failed", precondition: "provider_reports_failed", description: "Verified provider event or lookup says the payment failed.", guard: fromProvider },
    { from: "created", to: "expired", precondition: "session_ttl_passed_without_payment", description: "The payment session expired and a provider lookup shows no payment.", guard: f => f.source === "system" },
    {
      from: "created",
      to: "pending_reconciliation",
      precondition: "provider_outcome_unknown",
      description: "Timeout or unknown provider outcome. The shopper sees a pending state, never a false success.",
      guard: f => f.source === "system",
    },
    { from: "authorized", to: "captured", precondition: "provider_reports_captured", description: "Verified provider event or lookup says the authorized payment was captured.", guard: fromProvider },
    { from: "authorized", to: "expired", precondition: "provider_reports_authorization_lapsed", description: "The provider voided or auto-refunded an uncaptured authorization.", guard: fromProvider },
    { from: "authorized", to: "pending_reconciliation", precondition: "provider_outcome_unknown", description: "Capture outcome unknown after timeout.", guard: f => f.source === "system" },
    { from: "pending_reconciliation", to: "authorized", precondition: "reconciliation_found_authorized", description: "Provider lookup resolved the payment as authorized.", guard: fromProvider },
    { from: "pending_reconciliation", to: "captured", precondition: "reconciliation_found_captured", description: "Provider lookup resolved the payment as captured.", guard: fromProvider },
    { from: "pending_reconciliation", to: "failed", precondition: "reconciliation_found_failed", description: "Provider lookup resolved the payment as failed.", guard: fromProvider },
    { from: "pending_reconciliation", to: "expired", precondition: "reconciliation_found_no_payment", description: "Provider lookup found no payment and the session is closed.", guard: fromProvider },
    {
      from: "captured",
      to: "partially_refunded",
      precondition: "provider_reports_partial_refund",
      description: "A refund succeeded at the provider for less than the captured amount.",
      guard: f => fromProvider(f) && f.refundFullyCovered === false,
    },
    {
      from: "captured",
      to: "refunded",
      precondition: "provider_reports_full_refund",
      description: "Refunds at the provider now equal the captured amount.",
      guard: f => fromProvider(f) && f.refundFullyCovered === true,
    },
    {
      from: "partially_refunded",
      to: "refunded",
      precondition: "provider_reports_full_refund",
      description: "Refunds at the provider now equal the captured amount.",
      guard: f => fromProvider(f) && f.refundFullyCovered === true,
    },
  ],
}

export const RESERVATION_MACHINE: StateMachine<ReservationStatus> = {
  name: "reservation",
  states: RESERVATION_STATUSES,
  initial: "active",
  terminal: ["released", "fulfilled"],
  transitions: [
    {
      from: "active",
      to: "allocated",
      precondition: "payment_captured_amount_matches",
      description: "Units still held and a matching verified capture exists: convert reserved to allocated exactly once.",
      guard: f => f.paymentStatus === "captured" && f.amountMatches === true,
    },
    {
      from: "active",
      to: "released",
      precondition: "expired_or_payment_closed_and_not_captured",
      description: "No capture, and the reservation expired, the payment failed or expired, the order was cancelled, or the shopper cancelled before paying (Stage 13.09).",
      guard: f => f.paymentStatus !== "captured" && (f.reservationExpired === true || paymentClosedWithoutCapture(f) || f.orderStatus === "cancelled" || (f.cancelRequested === true && f.paymentStarted === false)),
    },
    {
      from: "allocated",
      to: "fulfilled",
      precondition: "parcel_handed_to_courier",
      description: "Allocated units left the warehouse with the courier.",
      guard: f => f.fulfilmentStatus === "handed_over",
    },
    {
      from: "allocated",
      to: "released",
      precondition: "order_cancelled_before_dispatch",
      description: "The order was cancelled before handover; allocated units return to available stock.",
      guard: f => f.orderStatus === "cancelled" && (beforeDispatch(f) || f.fulfilmentStatus === "cancelled"),
    },
  ],
}

export const FULFILMENT_MACHINE: StateMachine<FulfilmentStatus> = {
  name: "fulfilment",
  states: FULFILMENT_STATUSES,
  initial: "unfulfilled",
  terminal: ["handed_over", "cancelled"],
  transitions: [
    {
      from: "unfulfilled",
      to: "packing",
      precondition: "order_confirmed_and_stock_allocated",
      description: "No unpaid fulfilment: packing starts only for a confirmed order with allocated stock.",
      guard: f => f.orderStatus === "confirmed" && f.reservationStatus === "allocated",
    },
    { from: "packing", to: "packed", precondition: "staff_marked_packed", description: "Permitted staff packed and weighed the parcel(s).", guard: byStaff },
    {
      from: "packed",
      to: "handed_over",
      precondition: "courier_pickup_scanned",
      description: "The courier reported pickup for a booked shipment (AWB assigned). Payment alone never ships an order.",
      guard: f => fromProvider(f) && f.hasAwb === true,
    },
    { from: "unfulfilled", to: "cancelled", precondition: "order_cancelled", description: "The order was cancelled before packing.", guard: f => f.orderStatus === "cancelled" },
    { from: "packing", to: "cancelled", precondition: "order_cancelled", description: "The order was cancelled during packing.", guard: f => f.orderStatus === "cancelled" },
    { from: "packed", to: "cancelled", precondition: "order_cancelled", description: "The order was cancelled before courier pickup.", guard: f => f.orderStatus === "cancelled" },
  ],
}

const scan = (from: ShipmentStatus, to: ShipmentStatus, description: string): Transition<ShipmentStatus> => ({
  from,
  to,
  precondition: `courier_scan_${to}`,
  description,
  guard: fromProvider,
})

export const SHIPMENT_MACHINE: StateMachine<ShipmentStatus> = {
  name: "shipment",
  states: SHIPMENT_STATUSES,
  initial: "booking_requested",
  terminal: ["delivered", "rto_delivered", "cancelled", "lost"],
  transitions: [
    {
      from: "booking_requested",
      to: "booked",
      precondition: "courier_assigned_awb",
      description: "The courier accepted the booking and returned an AWB.",
      guard: f => fromProvider(f) && f.hasAwb === true && f.fulfilmentStatus === "packed",
    },
    { from: "booking_requested", to: "cancelled", precondition: "booking_rejected_or_withdrawn", description: "The courier rejected the booking or staff withdrew it.", guard: f => fromProvider(f) || byStaff(f) },
    scan("booked", "pickup_scheduled", "Pickup slot confirmed by the courier."),
    { from: "booked", to: "cancelled", precondition: "staff_cancelled_before_pickup", description: "Staff cancelled the booking before pickup.", guard: byStaff },
    scan("pickup_scheduled", "picked_up", "Courier pickup scan."),
    { from: "pickup_scheduled", to: "cancelled", precondition: "staff_cancelled_before_pickup", description: "Staff cancelled the booking before pickup.", guard: byStaff },
    scan("picked_up", "in_transit", "First in-transit scan."),
    scan("picked_up", "out_for_delivery", "Courier skipped intermediate scans."),
    scan("in_transit", "out_for_delivery", "Out-for-delivery scan."),
    scan("in_transit", "delivered", "Delivered scan without an out-for-delivery scan."),
    scan("in_transit", "rto_initiated", "Courier started return to origin while in transit."),
    { from: "in_transit", to: "lost", precondition: "courier_or_staff_declared_lost", description: "Courier declared the parcel lost, or staff did after a dispute.", guard: f => fromProvider(f) || byStaff(f) },
    scan("out_for_delivery", "delivered", "Delivered scan."),
    scan("out_for_delivery", "delivery_failed", "Delivery attempt failed (customer unavailable, refused, address issue)."),
    scan("delivery_failed", "out_for_delivery", "Courier re-attempted delivery."),
    scan("delivery_failed", "rto_initiated", "Courier started return to origin after failed attempts."),
    scan("rto_initiated", "rto_delivered", "Parcel returned to the pickup location. Distinct from a customer return."),
  ],
}

export const RETURN_MACHINE: StateMachine<ReturnStatus> = {
  name: "return",
  states: RETURN_STATUSES,
  initial: "requested",
  terminal: ["withdrawn", "closed"],
  transitions: [
    { from: "requested", to: "under_review", precondition: "staff_opened_review", description: "Permitted staff started reviewing the request.", guard: byStaff },
    { from: "requested", to: "rejected", precondition: "outside_return_window", description: "The request arrived outside the return window.", guard: f => f.withinReturnWindow === false },
    { from: "requested", to: "withdrawn", precondition: "customer_withdrew", description: "The customer withdrew the request.", guard: f => f.source === "customer" },
    {
      from: "under_review",
      to: "pickup_initiated",
      precondition: "staff_approved_pickup_within_window",
      description: "Permitted staff approved a reverse pickup for an eligible item within the window.",
      guard: f => byStaff(f) && f.withinReturnWindow === true,
    },
    { from: "under_review", to: "rejected", precondition: "staff_rejected", description: "Permitted staff rejected the request with a customer-visible reason.", guard: byStaff },
    { from: "under_review", to: "withdrawn", precondition: "customer_withdrew", description: "The customer withdrew the request.", guard: f => f.source === "customer" },
    { from: "pickup_initiated", to: "returned", precondition: "item_received_at_warehouse", description: "Reverse pickup delivered, or staff logged a hand-in.", guard: f => fromProvider(f) || byStaff(f) },
    { from: "returned", to: "inspected", precondition: "staff_inspected", description: "Staff inspected the item and recorded restockable or not per unit.", guard: byStaff },
    { from: "inspected", to: "approved", precondition: "inspection_passed", description: "Permitted staff accepted the return. Restocking is a separate ledger entry, never automatic.", guard: byStaff },
    { from: "inspected", to: "rejected", precondition: "inspection_failed", description: "Permitted staff refused the return after inspection.", guard: byStaff },
    { from: "approved", to: "refunded", precondition: "refund_succeeded", description: "The linked refund reached succeeded at the provider.", guard: f => f.refundSucceeded === true },
    { from: "refunded", to: "closed", precondition: "case_closed", description: "Nothing left to do for this request.", guard: f => f.source === "system" || byStaff(f) },
    { from: "rejected", to: "closed", precondition: "case_closed", description: "Rejection communicated and any item sent back.", guard: f => f.source === "system" || byStaff(f) },
  ],
}

export const REFUND_MACHINE: StateMachine<RefundStatus> = {
  name: "refund",
  states: REFUND_STATUSES,
  initial: "requested",
  terminal: ["succeeded", "rejected"],
  transitions: [
    {
      from: "requested",
      to: "processing",
      precondition: "approved_within_permission_and_amount",
      description: "Approved by staff with refund permission (or by the system for an automatic cancellation refund), within the refundable balance.",
      guard: f => byStaff(f) || f.source === "system",
    },
    { from: "requested", to: "rejected", precondition: "staff_rejected", description: "Permitted staff declined the refund.", guard: byStaff },
    { from: "processing", to: "succeeded", precondition: "provider_reports_refund_processed", description: "Verified provider event or lookup says the refund was processed.", guard: fromProvider },
    { from: "processing", to: "failed", precondition: "provider_reports_refund_failed", description: "Verified provider event or lookup says the refund failed.", guard: fromProvider },
    { from: "failed", to: "processing", precondition: "staff_retried", description: "Permitted staff retried a failed refund with the same idempotency key.", guard: byStaff },
  ],
}

/**
 * Who may make each order, fulfilment and payment transition (Stage 13.06; payment and courier kept
 * apart, Stage 13.07), by the actor's class: a signed-in customer, a guest, staff (with the needed
 * permission, checked by the caller), a background job (system), a verified payment provider event,
 * or a verified courier event. A payment provider can move payments and the order's financial status,
 * never fulfilment; a courier can move fulfilment and complete an order, never a payment. The guard
 * decides whether the facts allow the move; this decides whether this actor may ask for it at all.
 * Anything not listed is refused, and the database refuses every move that is not a transition.
 */
export type TransitionActor = "customer" | "guest" | "staff" | "system" | "payment_provider" | "courier"

export const ORDER_TRANSITION_ACTORS: Readonly<Record<string, readonly TransitionActor[]>> = {
  "pending_payment->confirmed": ["payment_provider", "system"],
  "pending_payment->needs_review": ["payment_provider", "system"],
  // The shopper may cancel their own unpaid order (Stage 13.09); a job cancels it when its window ends.
  "pending_payment->cancelled": ["payment_provider", "system", "customer", "guest"],
  "needs_review->confirmed": ["staff"],
  "needs_review->cancelled": ["staff"],
  // A paid order is cancelled by staff only, who then refund it; the buyer asks the shop (owner decision, 30 October 2026).
  "confirmed->cancelled": ["staff"],
  "confirmed->completed": ["courier", "system"],
}

export const FULFILMENT_TRANSITION_ACTORS: Readonly<Record<string, readonly TransitionActor[]>> = {
  "unfulfilled->packing": ["staff"],
  "packing->packed": ["staff"],
  "packed->handed_over": ["courier"],
  "unfulfilled->cancelled": ["staff", "system"],
  "packing->cancelled": ["staff", "system"],
  "packed->cancelled": ["staff", "system"],
}

/** Payment attempts move only on payment provider events, or a system job where the machine says so. */
export const PAYMENT_TRANSITION_ACTORS: Readonly<Record<string, readonly TransitionActor[]>> = Object.fromEntries(
  PAYMENT_MACHINE.transitions.map(t => [`${t.from}->${t.to}`, t.guard({ source: "system" }) ? ["system"] : ["payment_provider"]] as const),
)

// Only the payment provider the shop launches with (owner decision, 30 October 2026); add PhonePe here once signed up.
export const PAYMENT_PROVIDERS = ["razorpay"] as const
export const COURIER_PROVIDERS = ["shiprocket", "sandbox"] as const

/**
 * The class of an actor as the database records it (kind and id). A provider is a payment provider or
 * a courier by its name; a provider with any other name has no class and may make no move.
 */
export function actorClassOf(actor: { kind: string; id: string | null }): TransitionActor | null {
  if (actor.kind === "provider") {
    if ((PAYMENT_PROVIDERS as readonly string[]).includes(actor.id ?? "")) return "payment_provider"
    if ((COURIER_PROVIDERS as readonly string[]).includes(actor.id ?? "")) return "courier"
    return null
  }
  return ["customer", "guest", "staff", "system"].includes(actor.kind) ? (actor.kind as TransitionActor) : null
}

/** The guard's fact source for an actor class: a guest acts as a customer, payment and courier events as the provider. */
export const sourceOf = (actor: TransitionActor): FactSource => (actor === "guest" ? "customer" : actor === "payment_provider" || actor === "courier" ? "provider" : actor)

/** Whether this actor may ask for this move. Unknown moves and actors without a class are refused. */
export function actorMayTransition(actors: Readonly<Record<string, readonly TransitionActor[]>>, from: string, to: string, actor: TransitionActor | null): boolean {
  return actor !== null && (actors[`${from}->${to}`] ?? []).includes(actor)
}

export const STATE_MACHINES = [ORDER_MACHINE, PAYMENT_MACHINE, RESERVATION_MACHINE, FULFILMENT_MACHINE, SHIPMENT_MACHINE, RETURN_MACHINE, REFUND_MACHINE] as const

export type TransitionPlan =
  | { kind: "apply"; precondition: string }
  /** Already in the target state: a retried command or replayed event changes nothing. */
  | { kind: "noop" }
  | { kind: "rejected"; reason: "unknown_state" | "not_allowed" | "precondition_failed"; precondition?: string }

/** Decides whether `from -> to` may happen. Pure: the caller performs and audits the write. */
export function planTransition<S extends string>(machine: StateMachine<S>, from: S, to: S, facts: GuardFacts): TransitionPlan {
  if (!machine.states.includes(from) || !machine.states.includes(to)) return { kind: "rejected", reason: "unknown_state" }
  if (from === to) return { kind: "noop" }
  const transition = machine.transitions.find(t => t.from === from && t.to === to)
  if (!transition) return { kind: "rejected", reason: "not_allowed" }
  if (!transition.guard(facts)) return { kind: "rejected", reason: "precondition_failed", precondition: transition.precondition }
  return { kind: "apply", precondition: transition.precondition }
}

/**
 * Provider event identity. `fingerprint` is a hash of the verified raw body, computed by the
 * adapter; the same event ID with a different fingerprint is a conflict, never applied.
 */
export type ProviderEventRef = { provider: string; eventId: string; fingerprint: string }

export type EventDecision = "apply" | "duplicate" | "conflict"

/** Deduplicates by provider and event ID. `seen` maps `${provider}:${eventId}` to the fingerprint first stored. */
export function classifyProviderEvent(seen: ReadonlyMap<string, string>, event: ProviderEventRef): EventDecision {
  const previous = seen.get(`${event.provider}:${event.eventId}`)
  if (previous === undefined) return "apply"
  return previous === event.fingerprint ? "duplicate" : "conflict"
}

export type PaymentEvent = ProviderEventRef & { target: PaymentStatus; refundFullyCovered?: boolean }

export type PaymentReplayResult = {
  status: PaymentStatus
  /** Event IDs that changed state, in order. Each is one financial effect. */
  applied: string[]
  duplicates: string[]
  conflicts: string[]
  /** Valid, new events that could not apply (out of order or stale); kept for reconciliation. */
  ignored: string[]
}

/**
 * Reference semantics for payment webhooks: events are deduplicated, a replay of the current
 * state is a no-op, and a stale or out-of-order event never moves the status backwards.
 * Stage 14 implements this inside a database transaction; this function pins the behaviour.
 */
export function replayPaymentEvents(initial: PaymentStatus, events: readonly PaymentEvent[]): PaymentReplayResult {
  const seen = new Map<string, string>()
  const result: PaymentReplayResult = { status: initial, applied: [], duplicates: [], conflicts: [], ignored: [] }
  for (const event of events) {
    const decision = classifyProviderEvent(seen, event)
    if (decision === "duplicate") {
      result.duplicates.push(event.eventId)
      continue
    }
    if (decision === "conflict") {
      result.conflicts.push(event.eventId)
      continue
    }
    seen.set(`${event.provider}:${event.eventId}`, event.fingerprint)
    const plan = planTransition(PAYMENT_MACHINE, result.status, event.target, { source: "provider", refundFullyCovered: event.refundFullyCovered })
    if (plan.kind === "apply") {
      result.status = event.target
      result.applied.push(event.eventId)
    } else if (plan.kind === "noop") {
      result.duplicates.push(event.eventId)
    } else {
      result.ignored.push(event.eventId)
    }
  }
  return result
}
