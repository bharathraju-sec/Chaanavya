// Authentication server (Stage 05), built on Better Auth 1.7.7 (decision 025).
//
// - Customers sign in with a 6-digit code sent to their email (no passwords). The first sign-in
//   creates the account and proves the address.
// - Staff sign in with email + password, then a TOTP code from an authenticator app. Better Auth
//   only runs the two-factor challenge for password sign-in, so every session records how it was
//   created (`authMethod`) and lib/auth/guards.ts requires "password_2fa" for privileged actions.
//   A staff member who signs in with an email code gets an ordinary customer session.
// - Sessions are server-side rows; the cookie is httpOnly, SameSite=Lax, Secure in production.
// - Rate limits are stored in the database so every server instance shares them.
//
// Server only. Never import from a client component (eslint.config.mjs).
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { createAuthMiddleware } from "better-auth/api"
import { emailOTP, twoFactor } from "better-auth/plugins"
import { adminUrl } from "@chaanavya/shared/admin/host"
import { readEnv, resolveEnvironment } from "@chaanavya/shared/config/env"
import { db, type Db } from "../db/client.ts"
import { correlationIdFrom } from "@chaanavya/shared/observability/logger"
import { recordIdentityEvent } from "./audit.ts"
import { deliverOtp, type OtpMessage } from "./otp-delivery.ts"

export const AUTH_BASE_PATH = "/api/auth"
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const OTP_TTL_SECONDS = 5 * 60

/** How a session came to exist, from the endpoint that created it. */
export function authMethodFor(path: string | undefined): "email_otp" | "password" | "password_2fa" | "unknown" {
  if (path === "/sign-in/email-otp") return "email_otp"
  if (path === "/sign-in/email") return "password"
  if (path === "/two-factor/verify-totp" || path === "/two-factor/verify-backup-code" || path === "/two-factor/verify-otp") return "password_2fa"
  return "unknown"
}

const AUDITED_PATHS: Record<string, "identity.signed_out" | "identity.password_reset"> = {
  "/sign-out": "identity.signed_out",
  "/email-otp/reset-password": "identity.password_reset",
}

// Two-factor changes are audited when the user row's flag actually changes, not by endpoint:
// the same verify-totp endpoint also completes sign-ins and re-verifications.
const pendingTwoFactorChange = new WeakMap<object, boolean>()

export type AuthOptions = {
  /** Origin of the separate admin host, if any (ADMIN_URL). */
  adminOrigin?: string | null
  db: Db
  secret: string
  baseURL: string
  sendOtp: (message: OtpMessage) => Promise<void>
  secureCookies: boolean
}

export function createAuth({ db: database, secret, baseURL, sendOtp, secureCookies, adminOrigin }: AuthOptions) {
  return betterAuth({
    appName: "Chaanavya",
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret,
    // The shop and the admin host (ADMIN_URL) both send sign-in requests here.
    trustedOrigins: [new URL(baseURL).origin, ...(adminOrigin ? [adminOrigin] : [])],
    telemetry: { enabled: false },
    database: prismaAdapter(database, { provider: "postgresql", transaction: true }),
    advanced: {
      // Better Auth skips its origin (CSRF) check when it detects a test environment; keep it on
      // everywhere so tests exercise the same protection production has.
      disableOriginCheck: false,
      cookiePrefix: "chaanavya",
      useSecureCookies: secureCookies,
      database: { generateId: false },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    // Staff only: public password sign-up is off; staff accounts are created by an owner (lib/auth/staff.ts).
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true },
    session: {
      modelName: "authSession",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 24 * 60 * 60,
      additionalFields: { authMethod: { type: "string", required: false, input: false, defaultValue: "unknown" } },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 5 },
        "/sign-in/email": { window: 60, max: 5 },
        "/email-otp/reset-password": { window: 60, max: 3 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const user = await database.user.findUnique({ where: { id: String(session.userId) }, select: { disabledAt: true } })
            if (user?.disabledAt) return false
            return { data: { ...session, authMethod: authMethodFor(context?.path) } }
          },
          after: async (session, context) => {
            const roles = await database.role.count({ where: { userId: String(session.userId) } })
            await recordIdentityEvent(database, {
              action: "identity.signed_in",
              actor: { kind: roles ? "staff" : "customer", id: String(session.userId) },
              entity: { type: "user", id: String(session.userId) },
              reason: authMethodFor(context?.path),
              correlationId: correlationIdFrom(context?.request?.headers),
            })
          },
        },
      },
      user: {
        update: {
          before: async (data, context) => {
            if (context && typeof data.twoFactorEnabled === "boolean") pendingTwoFactorChange.set(context, data.twoFactorEnabled)
          },
          after: async (user, context) => {
            const enabled = context ? pendingTwoFactorChange.get(context) : undefined
            if (enabled === undefined || !context) return
            pendingTwoFactorChange.delete(context)
            await recordIdentityEvent(database, {
              action: enabled ? "identity.two_factor_enabled" : "identity.two_factor_disabled",
              actor: { kind: "staff", id: user.id },
              entity: { type: "user", id: user.id },
              reason: context.path ?? "server",
              correlationId: correlationIdFrom(context.request?.headers),
            })
          },
        },
        create: {
          after: async (user, context) => {
            await recordIdentityEvent(database, {
              action: "identity.user_created",
              actor: { kind: "customer", id: user.id },
              entity: { type: "user", id: user.id },
              reason: context?.path ?? "server",
              correlationId: correlationIdFrom(context?.request?.headers),
            })
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async ctx => {
        const action = AUDITED_PATHS[ctx.path]
        const returned = ctx.context.returned as { status?: number } | undefined
        if (!action || returned instanceof Error || (returned?.status ?? 200) >= 400) return
        const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id ?? null
        await recordIdentityEvent(database, {
          action,
          actor: { kind: "customer", id: userId },
          entity: { type: "user", id: userId ?? "unknown" },
          reason: ctx.path,
          correlationId: correlationIdFrom(ctx.headers),
        })
      }),
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_TTL_SECONDS,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => sendOtp({ email, otp, type }),
      }),
      twoFactor({ issuer: "Chaanavya", skipVerificationOnEnable: false, backupCodeOptions: { amount: 10, length: 10 } }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

let instance: Auth | undefined

/** The application's auth instance, built from the environment on first use. */
export function auth(): Auth {
  if (instance) return instance
  const env = process.env
  const environment = resolveEnvironment(env)
  const secret = readEnv(env, "BETTER_AUTH_SECRET")
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be set (32+ characters) to enable sign-in")
  const baseURL = readEnv(env, "BETTER_AUTH_URL") ?? (environment === "development" ? "http://localhost:3000" : undefined)
  if (!baseURL) throw new Error("BETTER_AUTH_URL must be set outside development")
  // Secure cookies wherever the site is served over https (staging and production), and always in production.
  const secureCookies = environment === "production" || new URL(baseURL).protocol === "https:"
  instance = createAuth({ db: db(), secret, baseURL, sendOtp: deliverOtp, secureCookies, adminOrigin: adminUrl(env)?.origin ?? null })
  return instance
}
