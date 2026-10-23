import { readEnv, resolveEnvironment } from "../config/env.ts"

// TEMPORARY development switch (set ADMIN_TWO_FACTOR=off): staff may use the admin with a password
// sign-in alone, so the admin can be built and tried before real staff accounts exist.
//
// It is off unless explicitly set, and it only ever takes effect when the environment is
// `development`: in staging or production the value is ignored here and the API refuses to start with
// it set (the setting's check in config/env.ts). Remove the setting, or set it to `on`, to restore
// the rule that every staff sign-in passes two-factor, which is the real design (decision 029).
export function twoFactorWaived(env: Readonly<Record<string, string | undefined>>): boolean {
  return resolveEnvironment(env) === "development" && readEnv(env, "ADMIN_TWO_FACTOR") === "off"
}
