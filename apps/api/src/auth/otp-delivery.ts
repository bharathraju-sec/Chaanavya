// Delivery of one-time sign-in and recovery codes (Stage 05).
// No email provider is connected yet (Stage 18), so:
//   - development: the code is printed to the server console and kept in `devOutbox` (tests read it);
//   - staging and production: delivery fails loudly instead of pretending a code was sent.
import { resolveEnvironment } from "@chaanavya/shared/config/env"
import { maskEmail } from "@chaanavya/shared/observability/logger"

export type OtpPurpose = "sign-in" | "email-verification" | "forget-password" | "change-email"
export type OtpMessage = { email: string; otp: string; type: OtpPurpose | string }

export class OtpDeliveryUnavailableError extends Error {}

/** Development only. Holds the most recent codes for local testing; empty in other environments. */
export const devOutbox: OtpMessage[] = []

export async function deliverOtp(message: OtpMessage): Promise<void> {
  if (resolveEnvironment(process.env) !== "development") {
    throw new OtpDeliveryUnavailableError("One-time codes cannot be emailed yet: no email provider is configured (Stage 18).")
  }
  devOutbox.push(message)
  if (devOutbox.length > 50) devOutbox.shift()
  if (process.env.NODE_ENV !== "test") console.info(`[dev] ${message.type} code for ${maskEmail(message.email)}: ${message.otp}`)
}

/** Latest development code for an address (tests and local debugging). */
export const latestDevOtp = (email: string, type?: string) =>
  [...devOutbox].reverse().find(m => m.email.toLowerCase() === email.toLowerCase() && (!type || m.type === type))?.otp
