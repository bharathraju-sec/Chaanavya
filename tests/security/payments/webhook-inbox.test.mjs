// CHV-S14-M10: a duplicate webhook changes state once. Every verified Razorpay event is kept once in
// payment_webhook_inbox (apps/api/src/payments/inbox.ts, migration 20261031010000_payment_webhook_inbox) before
// it is acknowledged, and the worker side (claim, complete, fail and retry) runs each event's handler once.
// Webhooks are delivered byte for byte through the web host's forwarder, signed as Razorpay signs them, with
// fake secrets; the handler is a test stand-in that counts its runs.
import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import { apiModule, ORIGIN, setup } from "../auth/helpers.mjs"

let ctx, forward, inbox

const SANDBOX = { PAYMENT_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_FAKE0000000020", RAZORPAY_KEY_SECRET: "fake-key-secret-14-10-0001", RAZORPAY_WEBHOOK_SECRET: "fake-webhook-secret-14-10-0001" }
const sign = bytes => createHmac("sha256", SANDBOX.RAZORPAY_WEBHOOK_SECRET).update(bytes).digest("hex")
const newId = () => `evt${randomBytes(8).toString("hex")}`
let seq = 0

/** A signed Razorpay event body (fake ids). */
function eventBody(event = "payment.captured", { amount = 189900, note = "" } = {}) {
  seq += 1
  const payment = { id: `pay_Fake1410${seq}`, entity: "payment", amount, currency: "INR", status: "captured", order_id: `order_Fake1410${seq}`, notes: { note } }
  return Buffer.from(JSON.stringify({ entity: "event", event, payload: { payment: { entity: payment } }, created_at: 1793000000 }), "utf8")
}

async function deliver(bytes, id) {
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.10", "x-razorpay-signature": sign(bytes), "x-razorpay-event-id": id })
  const response = await forward(new Request(`${ORIGIN}/api/webhooks/razorpay`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({}) })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: response.status, json, text }
}

const rowOf = async id => JSON.parse(JSON.stringify(await ctx.db.paymentWebhookInbox.findUniqueOrThrow({ where: { provider_eventId: { provider: "razorpay", eventId: id } } }), (_, v) => (typeof v === "bigint" ? String(v) : v)))
const inboxCount = () => ctx.db.paymentWebhookInbox.count()

/** A handler stand-in: counts runs per event, fails on demand. */
function counter() {
  const runs = new Map()
  const fail = new Map()
  const handler = async event => {
    runs.set(event.eventId, (runs.get(event.eventId) ?? 0) + 1)
    await new Promise(r => setTimeout(r, 5))
    const left = fail.get(event.eventId) ?? 0
    if (left > 0) {
      fail.set(event.eventId, left - 1)
      throw new Error("handler stand-in failed on purpose")
    }
  }
  return { runs, fail, handler }
}

before(async () => {
  ctx = await setup("chaanavya_test_s14_webhook_inbox")
  forward = ctx.routes.me.GET
  Object.assign(process.env, SANDBOX)
  inbox = await apiModule("payments/inbox")
})
after(() => {
  for (const name of Object.keys(SANDBOX)) delete process.env[name]
  return ctx?.teardown()
})
// Each test starts with nothing due, so a worker pass sees only that test's events: earlier tests' events are
// worked off by a no-op handler, a year ahead (the inbox's own rules allow nothing else).
beforeEach(async () => {
  const later = new Date(Date.now() + 365 * 24 * 60 * 60_000)
  for (const event of await inbox.claimWebhookEvents(ctx.db, { now: later, limit: 1000 })) await inbox.completeWebhookEvent(ctx.db, event, later)
})

describe("CHV-S14-M10 a duplicate delivery is kept once and changes nothing", () => {
  test("a new event is kept once, normalized, without its raw body or signature; repeats, in order and at once, change nothing", async () => {
    const bytes = eventBody("payment.captured", { note: "a private note that must not be kept" })
    const id = newId()
    const first = await deliver(bytes, id)
    assert.deepEqual([first.status, first.json?.event?.inbox], [200, "stored"], first.text)
    const stored = await rowOf(id)
    assert.deepEqual(
      [stored.status, stored.attempts, stored.type, stored.amountPaise, stored.currency, stored.processedAt, stored.claimId, stored.conflictAt],
      ["received", 0, "payment.captured", "189900", "INR", null, null, null],
    )
    const kept = JSON.stringify(stored)
    assert.ok(!kept.includes("private note") && !kept.includes(sign(bytes)), "only the normalized event is kept")

    const repeats = [await deliver(bytes, id), await deliver(bytes, id), ...(await Promise.all(Array.from({ length: 10 }, () => deliver(bytes, id))))]
    assert.deepEqual([...new Set(repeats.map(r => `${r.status}:${r.json?.event?.inbox}`))], ["200:duplicate"])
    assert.deepEqual(await rowOf(id), stored, "the kept event did not change")
    assert.equal(await ctx.db.paymentWebhookInbox.count({ where: { eventId: id } }), 1)
  })

  test("ten simultaneous first deliveries of one event keep it once: one 'stored', nine 'duplicate'", async () => {
    const bytes = eventBody()
    const id = newId()
    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(bytes, id)))
    assert.deepEqual(results.map(r => r.status), Array(10).fill(200))
    assert.deepEqual(results.map(r => r.json.event.inbox).sort(), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "stored"])
    assert.equal(await ctx.db.paymentWebhookInbox.count({ where: { eventId: id } }), 1)
  })

  test("the same event id with a different body is a conflict: never stored over the first, noted once", async () => {
    const id = newId()
    await deliver(eventBody("payment.captured", { amount: 189900 }), id)
    const original = await rowOf(id)
    const conflict = await deliver(eventBody("payment.captured", { amount: 100 }), id)
    assert.deepEqual([conflict.status, conflict.json.event.inbox], [200, "conflict"])
    const noted = await rowOf(id)
    assert.ok(noted.conflictAt, "the conflict is noted for staff")
    assert.deepEqual({ ...noted, conflictAt: null }, original, "the first event is kept as it was")
    assert.equal((await deliver(eventBody("payment.failed", { amount: 5 }), id)).json.event.inbox, "conflict")
    assert.equal((await rowOf(id)).conflictAt, noted.conflictAt, "noted once")
  })

  test("an event is acknowledged only once it is kept: if keeping it fails the provider gets an error, and its retry is kept", async () => {
    const bytes = eventBody()
    const id = newId()
    await ctx.db.$executeRawUnsafe(`CREATE FUNCTION test_inbox_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage is down'; END; $$`)
    await ctx.db.$executeRawUnsafe(`CREATE TRIGGER test_inbox_down BEFORE INSERT ON "payment_webhook_inbox" FOR EACH ROW EXECUTE FUNCTION test_inbox_down()`)
    let failed
    try {
      failed = await deliver(bytes, id)
    } finally {
      await ctx.db.$executeRawUnsafe(`DROP TRIGGER test_inbox_down ON "payment_webhook_inbox"`)
      await ctx.db.$executeRawUnsafe(`DROP FUNCTION test_inbox_down()`)
    }
    assert.ok(failed.status >= 500, `not acknowledged (${failed.status})`)
    assert.equal(await ctx.db.paymentWebhookInbox.count({ where: { eventId: id } }), 0)
    const retried = await deliver(bytes, id)
    assert.deepEqual([retried.status, retried.json.event.inbox], [200, "stored"])
  })

  test("a verified event of a type we do not act on is acknowledged and not kept", async () => {
    const before = await inboxCount()
    const bytes = Buffer.from(JSON.stringify({ entity: "event", event: "order.paid", payload: {}, created_at: 1793000000 }))
    const res = await deliver(bytes, newId())
    assert.deepEqual([res.status, res.json], [200, { received: true, event: null }])
    assert.equal(await inboxCount(), before)
  })
})

describe("CHV-S14-M10 the worker runs each event once", () => {
  test("an event delivered three times is processed once; a later duplicate does not reopen it", async () => {
    const bytes = eventBody()
    const id = newId()
    for (let i = 0; i < 3; i++) await deliver(bytes, id)
    const { runs, handler } = counter()
    const first = await inbox.processWebhookInbox(ctx.db, handler)
    const second = await inbox.processWebhookInbox(ctx.db, handler)
    assert.deepEqual([first.processed, second.processed, runs.get(id)], [1, 0, 1])
    const done = await rowOf(id)
    assert.deepEqual([done.status, done.attempts, done.claimId, done.lastError], ["processed", 1, null, null])
    assert.ok(done.processedAt)
    assert.equal((await deliver(bytes, id)).json.event.inbox, "duplicate")
    await inbox.processWebhookInbox(ctx.db, handler)
    assert.deepEqual([(await rowOf(id)).status, runs.get(id)], ["processed", 1])
  })

  test("three workers at once over twelve events run every handler exactly once", async () => {
    const ids = Array.from({ length: 12 }, newId)
    for (const id of ids) await deliver(eventBody(), id)
    const { runs, handler } = counter()
    const passes = await Promise.all([1, 2, 3].map(() => inbox.processWebhookInbox(ctx.db, handler, { limit: 5 })))
    const last = await inbox.processWebhookInbox(ctx.db, handler)
    assert.deepEqual(ids.map(id => runs.get(id)), Array(12).fill(1))
    assert.equal(passes.reduce((n, p) => n + p.processed, 0) + last.processed, 12, "twelve completions in all, none twice")
    for (const id of ids) assert.equal((await rowOf(id)).status, "processed")
  })

  test("a failure is retried after a wait, then succeeds once; after the last try it is given up for staff", async () => {
    const id = newId()
    await deliver(eventBody(), id)
    const { runs, fail, handler } = counter()
    fail.set(id, 1)
    const now = new Date()
    assert.equal((await inbox.processWebhookInbox(ctx.db, handler, { now })).retrying, 1)
    const waiting = await rowOf(id)
    assert.deepEqual([waiting.status, waiting.attempts, waiting.lastError], ["received", 1, "handler stand-in failed on purpose"])
    assert.equal(new Date(waiting.nextAttemptAt).getTime(), now.getTime() + inbox.RETRY_WAITS_MS[0])
    assert.equal((await inbox.processWebhookInbox(ctx.db, handler, { now: new Date(now.getTime() + 30_000) })).processed, 0, "not before its wait")
    assert.equal((await inbox.processWebhookInbox(ctx.db, handler, { now: new Date(now.getTime() + inbox.RETRY_WAITS_MS[0] + 1) })).processed, 1)
    assert.deepEqual([(await rowOf(id)).status, runs.get(id)], ["processed", 2])

    const doomed = newId()
    await deliver(eventBody(), doomed)
    fail.set(doomed, 99)
    let at = Date.now()
    for (let i = 0; i < inbox.MAX_ATTEMPTS; i++) {
      await inbox.processWebhookInbox(ctx.db, handler, { now: new Date(at) })
      at += 3 * 60 * 60_000
    }
    const given = await rowOf(doomed)
    assert.deepEqual([given.status, given.attempts, runs.get(doomed)], ["failed", inbox.MAX_ATTEMPTS, inbox.MAX_ATTEMPTS])
    await inbox.processWebhookInbox(ctx.db, handler, { now: new Date(at + 24 * 60 * 60_000) })
    assert.equal(runs.get(doomed), inbox.MAX_ATTEMPTS, "a failed event is not claimed again")
  })

  test("without a given time a claim uses the database's clock, the clock that stamped the event due (found in 14.15)", async () => {
    const id = newId()
    await deliver(eventBody(), id)
    // Due by the database's own clock this instant; a host clock even a second behind would not see it yet.
    await ctx.db.$executeRawUnsafe(`UPDATE "payment_webhook_inbox" SET "next_attempt_at" = clock_timestamp() WHERE "event_id" = '${id}'`)
    assert.equal((await inbox.claimWebhookEvents(ctx.db, { now: new Date(Date.now() - 1_000) })).some(e => e.eventId === id), false, "a host clock behind misses it")
    const claimed = await inbox.claimWebhookEvents(ctx.db)
    assert.ok(claimed.some(e => e.eventId === id), "the database's clock finds it")
    for (const e of claimed) await inbox.completeWebhookEvent(ctx.db, e)
  })

  test("a lapsed claim is taken over; the first holder can no longer finish or fail it", async () => {
    const id = newId()
    await deliver(eventBody(), id)
    const now = new Date()
    const [held] = await inbox.claimWebhookEvents(ctx.db, { now, leaseMs: 1_000 })
    assert.equal(held.eventId, id)
    assert.equal((await inbox.claimWebhookEvents(ctx.db, { now: new Date(now.getTime() + 500) })).length, 0, "held while its lease lasts")
    const [taken] = await inbox.claimWebhookEvents(ctx.db, { now: new Date(now.getTime() + 1_001) })
    assert.deepEqual([taken.eventId, taken.attempt], [id, 2])
    assert.equal(await inbox.completeWebhookEvent(ctx.db, held), false)
    assert.equal(await inbox.failWebhookEvent(ctx.db, held, "late"), "not_held")
    assert.equal(await inbox.completeWebhookEvent(ctx.db, taken), true)
    assert.equal(await inbox.completeWebhookEvent(ctx.db, taken), false, "done once")
  })
})

describe("CHV-S14-M10 the database keeps the inbox honest", () => {
  test("a kept event's fields never change, status only moves forward, and events are never deleted", async () => {
    const id = newId()
    await deliver(eventBody(), id)
    const where = `"event_id" = '${id}'`
    const refused = async (sql, what) => assert.rejects(ctx.db.$executeRawUnsafe(sql), /kept as it was received|can only be claimed|stays so|kept|never goes back|check constraint|violates/, what)
    await refused(`UPDATE "payment_webhook_inbox" SET "amount_paise" = 100 WHERE ${where}`, "amount")
    await refused(`UPDATE "payment_webhook_inbox" SET "fingerprint" = 'sha256:other' WHERE ${where}`, "fingerprint")
    await refused(`UPDATE "payment_webhook_inbox" SET "provider_order_id" = 'order_Other' WHERE ${where}`, "order")
    await refused(`UPDATE "payment_webhook_inbox" SET "status" = 'processed', "processed_at" = now() WHERE ${where}`, "received straight to processed")
    await refused(`DELETE FROM "payment_webhook_inbox" WHERE ${where}`, "delete")
    await refused(`INSERT INTO "payment_webhook_inbox" ("id", "provider", "event_id", "fingerprint", "type", "provider_order_id", "amount_paise", "occurred_at") VALUES (gen_random_uuid(), 'razorpay', '${newId()}', 'sha256:x', 'order.paid', 'order_X', 100, now())`, "an unknown type")
    await refused(`INSERT INTO "payment_webhook_inbox" ("id", "provider", "event_id", "fingerprint", "type", "provider_order_id", "amount_paise", "currency", "occurred_at") VALUES (gen_random_uuid(), 'razorpay', '${newId()}', 'sha256:x', 'payment.captured', 'order_X', 100, 'USD', now())`, "not INR")

    const { handler } = counter()
    await inbox.processWebhookInbox(ctx.db, handler)
    await refused(`UPDATE "payment_webhook_inbox" SET "status" = 'received', "processed_at" = NULL WHERE ${where}`, "processed back to received")
    await refused(`UPDATE "payment_webhook_inbox" SET "attempts" = 0 WHERE ${where}`, "attempts back")
    assert.equal((await rowOf(id)).status, "processed")
  })
})
