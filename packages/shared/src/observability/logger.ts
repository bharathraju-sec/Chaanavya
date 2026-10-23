// Structured, redacting logger with correlation IDs (Stage 03). One JSON object per line, so
// Vercel and any log drain can filter by event, level or correlation ID.
//
// Redaction happens before anything is written: card numbers (PAN), CVV, OTPs, passwords, tokens,
// API keys, provider signatures, authorization headers, cookies and full addresses never reach the log. Emails and phone numbers are masked. Prefer logging IDs and statuses.
//
// Server code should use this instead of console.*. Self-contained runtime code.

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const REDACTED = "[redacted]"

/** Keys whose values are dropped entirely, at any depth. */
const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|signature|api[-_]?key|private[-_]?key|card|pan$|cvv|cvc|otp|pin$|razorpay_signature|x-razorpay-signature)/i
/** Address parts: kept out completely; PIN code and state are useful for support, so they stay. */
const ADDRESS_KEY = /^(address|address1|address2|line1|line2|street|landmark|house|flat|apartment)$/i
const EMAIL_KEY = /e-?mail/i
const PHONE_KEY = /(phone|mobile|whatsapp)/i

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
// Ten-digit Indian mobile number, optionally with +91; never matched inside a longer digit run.
const INDIAN_PHONE = /(?<![\d+])(\+?91[\s-]?)?([6-9]\d)\d{4}(\d{4})(?!\d)/g
const DIGIT_RUN = /\b(?:\d[ -]?){12,18}\d\b/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const PROVIDER_KEY = /\b(rzp_(?:test|live)_)[A-Za-z0-9]+|\b(sk-ant-)[A-Za-z0-9_-]+/g

/** Luhn check, so order numbers and timestamps are not mistaken for card numbers. */
function luhn(digits: string) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export const maskEmail = (value: string) => value.replace(EMAIL, "$1***@$2")

/** Redacts sensitive fragments inside free text (error messages, URLs, provider responses). */
export function redactText(text: string): string {
  return text
    .replace(BEARER, "$1 [redacted]")
    .replace(PROVIDER_KEY, (_m, rzp: string | undefined, other: string | undefined) => `${rzp ?? other}[redacted]`)
    .replace(DIGIT_RUN, run => {
      const digits = run.replace(/[ -]/g, "")
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[redacted-pan]" : run
    })
    .replace(EMAIL, "$1***@$2")
    .replace(INDIAN_PHONE, (_m, _cc, first: string, last: string) => `${first}******${last}`)
}

/** Deep copy with sensitive keys removed and remaining strings redacted. Handles cycles. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[circular]"
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (Array.isArray(value)) return value.map(item => redact(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || ADDRESS_KEY.test(key)) out[key] = REDACTED
    else if (EMAIL_KEY.test(key) && typeof item === "string") out[key] = maskEmail(item)
    else if (PHONE_KEY.test(key) && typeof item === "string") out[key] = item.replace(/\d(?=\d{4})/g, "*")
    else out[key] = redact(item, seen)
  }
  return out
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/

/** Reuses a well-formed inbound correlation ID (ours, then Vercel's) or creates one. */
export function correlationIdFrom(headers?: { get(name: string): string | null }): string {
  for (const name of ["x-correlation-id", "x-vercel-id"]) {
    const value = headers?.get(name)
    if (value && CORRELATION_ID.test(value)) return value
  }
  return crypto.randomUUID()
}

export type LogRecord = { time: string; level: LogLevel; event: string; correlationId: string } & LogFields

export type Logger = {
  readonly correlationId: string
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

export type LoggerOptions = {
  correlationId?: string
  level?: LogLevel
  base?: LogFields
  /** Where lines go; defaults to console. Tests pass a collector. */
  sink?: (level: LogLevel, line: string) => void
}

const consoleSink = (level: LogLevel, line: string) => (level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.log(line))

export function createLogger(options: LoggerOptions = {}): Logger {
  const correlationId = options.correlationId ?? crypto.randomUUID()
  const envLevel = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined) as LogLevel | undefined
  const threshold = LEVELS[options.level ?? (envLevel && envLevel in LEVELS ? envLevel : "info")]
  const sink = options.sink ?? consoleSink
  const base = options.base ?? {}

  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return
    const record = redact({ ...base, ...fields }) as LogFields
    const line: LogRecord = { time: new Date().toISOString(), level, event: redactText(event), correlationId, ...record }
    sink(level, JSON.stringify(line))
  }

  return {
    correlationId,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: fields => createLogger({ ...options, correlationId, base: { ...base, ...fields } }),
  }
}
