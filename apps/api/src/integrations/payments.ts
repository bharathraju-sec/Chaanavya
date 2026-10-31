// Which payment adapter serves this environment (Stage 14.04). The payment module asks for "the adapter" and
// never names a provider; this is the one place that does. Razorpay is the only provider switched on (owner
// decision, 30 October 2026). With no payment key configured, payments are off and this returns null; a key
// that breaks the sandbox boundary throws (apps/api/src/integrations/razorpay/config.ts).
import type { PaymentAdapter } from "@chaanavya/contracts/integrations/payment-gateway"
import type { Env } from "@chaanavya/shared/config/env"
import { razorpayAdapter } from "./razorpay/adapter.ts"
import { loadRazorpayConfig } from "./razorpay/config.ts"

export function paymentAdapterFor(env: Env): PaymentAdapter | null {
  const loaded = loadRazorpayConfig(env)
  return loaded.status === "ready" ? razorpayAdapter(loaded.config) : null
}
