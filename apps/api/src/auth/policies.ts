// Approval policies that depend on a staff member's capabilities (Stage 06).
import type { Capability } from "@chaanavya/shared/auth/rbac"

/**
 * Refund approval limits (decision 030). STAFF cannot approve refunds; ADMIN up to the threshold; OWNER without
 * limit. The threshold is ₹5,000 per refund (owner decision, 31 October 2026, at the Stage 14 gate).
 */
export const REFUND_LARGE_THRESHOLD_PAISE = 500_000 // Rs 5,000

export function refundApprovalLimitPaise(capabilities: ReadonlySet<Capability>): number | null {
  if (capabilities.has("refunds.approve_large")) return null
  if (capabilities.has("refunds.approve")) return REFUND_LARGE_THRESHOLD_PAISE
  return 0
}

export function canApproveRefund(capabilities: ReadonlySet<Capability>, amountPaise: number) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return false
  const limit = refundApprovalLimitPaise(capabilities)
  return limit === null || amountPaise <= limit
}
