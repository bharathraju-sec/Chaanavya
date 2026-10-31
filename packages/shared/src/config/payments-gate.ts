// The legal gate for live payments (Stage 14.02). Until the owner confirms the merchant KYC, the bank
// account and the tax registration, and records who approved it and when, live payment keys are refused
// everywhere: by the configuration check at start-up (env.ts) and by the payment client before every call
// (apps/api/src/integrations/razorpay/config.ts). Opening the gate is a code change made on the owner's
// written approval, reviewed like any other, never a setting someone can flip on a server.

export type LivePaymentsGate = {
  readonly merchantKyc: boolean
  readonly banking: boolean
  readonly tax: boolean
  /** Who approved live payments, and the date (YYYY-MM-DD). */
  readonly approvedBy: string | null
  readonly approvedOn: string | null
}

export const LIVE_PAYMENTS_GATE: LivePaymentsGate = Object.freeze({
  merchantKyc: false,
  banking: false,
  tax: false,
  approvedBy: null,
  approvedOn: null,
})

/** Live payments are allowed only when every condition is confirmed and the approval is recorded. */
export function livePaymentsApproved(gate: LivePaymentsGate = LIVE_PAYMENTS_GATE) {
  return gate.merchantKyc && gate.banking && gate.tax && Boolean(gate.approvedBy?.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(gate.approvedOn ?? "")
}

export const LIVE_GATE_CLOSED = "live payments are not allowed until the owner confirms merchant KYC, banking and tax (legal gate)"
