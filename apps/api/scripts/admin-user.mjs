// Staff account commands for operators with database access (Stage 06).
//
//   npm run admin:bootstrap-owner -- --email owner@example.com
//       One-time: creates the first OWNER. Refuses if any owner already exists.
//   npm run admin:add-staff -- --email person@example.com --role ADMIN --by owner@example.com --reason "joins packing team"
//       Creates (or gives a password to) a staff account on behalf of an existing owner who has
//       two-factor sign-in set up. Recorded in the audit trail as that owner's action.
//
// The password is read from ADMIN_INITIAL_PASSWORD or typed at a hidden prompt; it is never
// printed or logged. Every new staff member must set up two-factor sign-in before admin access
// works (enforced by the API's access guard, src/http/access.ts, and the admin pages).
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"

const { db } = await import("../src/db/client.ts")
const { auth } = await import("../src/auth/server.ts")
const { createStaffUser } = await import("../src/auth/staff.ts")
const { STAFF_ROLES } = await import("@chaanavya/shared/auth/rbac")

const [command, ...args] = process.argv.slice(2)
const option = name => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined)
const fail = message => {
  console.error(message)
  process.exit(1)
}

function askHidden(question) {
  if (!process.stdin.isTTY) fail("No terminal for a password prompt: set ADMIN_INITIAL_PASSWORD for this command instead.")
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = text => rl.output.write(text.includes(question) ? text : "")
    rl.question(question, answer => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer)
    })
  })
}

async function readPassword() {
  if (process.env.ADMIN_INITIAL_PASSWORD) return process.env.ADMIN_INITIAL_PASSWORD
  const first = await askHidden("Initial password (12 to 128 characters): ")
  const second = await askHidden("Type it again: ")
  if (first !== second) fail("The passwords do not match.")
  return first
}

const email = option("email")?.trim().toLowerCase()
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Pass --email with a valid address.")
const correlationId = `cli-${randomUUID()}`

try {
  if (command === "bootstrap-owner") {
    const owners = await db().role.count({ where: { role: "OWNER" } })
    if (owners > 0) fail("An owner already exists. Ask an owner to add you with admin:add-staff, or use the admin Settings page.")
    const user = await createStaffUser(auth(), db(), {
      email,
      password: await readPassword(),
      role: "OWNER",
      actor: { kind: "system", process: "bootstrap-owner" },
      reason: "first owner created with npm run admin:bootstrap-owner",
      correlationId,
    })
    console.log(`Owner account ready for ${email} (user ${user.id}).`)
    console.log("Next: sign in to the admin, then set up two-factor sign-in when asked. Admin pages stay closed until you do.")
  } else if (command === "add-staff") {
    const role = option("role")
    if (!STAFF_ROLES.includes(role)) fail(`Pass --role ${STAFF_ROLES.join("|")}.`)
    const reason = option("reason")?.trim()
    if (!reason || reason.length < 3) fail('Pass --reason "why this person needs access".')
    const by = option("by")?.trim().toLowerCase()
    const owner = by && (await db().user.findUnique({ where: { email: by }, select: { id: true, disabledAt: true, twoFactorEnabled: true, roles: { select: { role: true } } } }))
    if (!owner || owner.disabledAt || !owner.roles.some(r => r.role === "OWNER")) fail("Pass --by with the email of an active owner.")
    if (!owner.twoFactorEnabled) fail("That owner has not set up two-factor sign-in yet; they must do that first.")
    const user = await createStaffUser(auth(), db(), { email, password: await readPassword(), role, actor: { kind: "staff", id: owner.id }, reason, correlationId })
    console.log(`${role} access ready for ${email} (user ${user.id}). Share the initial password privately; they set up two-factor at first sign-in.`)
  } else {
    fail("Commands: bootstrap-owner, add-staff")
  }
} catch (error) {
  fail(error?.message ?? String(error))
} finally {
  await db().$disconnect()
}
