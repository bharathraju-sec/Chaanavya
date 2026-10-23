// Loaded with `node --import ./scripts/support/register.mjs` by the security tests and admin scripts.
import { register } from "node:module"

register("./alias-hooks.mjs", import.meta.url)
