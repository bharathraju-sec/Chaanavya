// Worker (Stage 07): the housekeeping job removes only unusable sign-in rows, and the advisory lock
// lets exactly one instance run a job at a time. Runs the worker's own code against a throwaway
// database; no worker process is started.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { createLogger } from "../../../packages/shared/src/observability/logger.ts"
import { housekeeping, RATE_LIMIT_IDLE_MS } from "../../../apps/worker/src/jobs/housekeeping.ts"
import { runOnce } from "../../../apps/worker/src/runner.ts"
import { dropDatabase, freshDatabase, unique } from "./helpers.mjs"

const NAME = "chaanavya_test_s07_worker"
const logger = createLogger({ base: { service: "worker-test" }, sink: () => {} })
let db

before(() => {
  db = freshDatabase(NAME).client
})
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

describe("worker housekeeping", () => {
  test("deletes expired sessions, expired codes and idle counters; keeps everything still usable", async () => {
    const user = await db.user.create({ data: { email: `${unique("worker")}@example.com` } })
    const hour = 60 * 60 * 1000
    const [expired, live] = await Promise.all([
      db.authSession.create({ data: { token: unique("expired"), userId: user.id, expiresAt: new Date(Date.now() - hour) } }),
      db.authSession.create({ data: { token: unique("live"), userId: user.id, expiresAt: new Date(Date.now() + hour) } }),
    ])
    await db.verification.createMany({ data: [{ identifier: "old", value: "x", expiresAt: new Date(Date.now() - hour) }, { identifier: "new", value: "x", expiresAt: new Date(Date.now() + hour) }] })
    await db.rateLimit.createMany({ data: [{ key: unique("idle"), count: 1, lastRequest: BigInt(Date.now() - RATE_LIMIT_IDLE_MS - hour) }, { key: unique("busy"), count: 1, lastRequest: BigInt(Date.now()) }] })

    assert.equal(await runOnce(db, housekeeping, logger), "ok")
    assert.equal(await db.authSession.findUnique({ where: { id: expired.id } }), null)
    assert.ok(await db.authSession.findUnique({ where: { id: live.id } }))
    assert.deepEqual((await db.verification.findMany()).map(v => v.identifier), ["new"])
    assert.equal(await db.rateLimit.count(), 1)
    assert.ok(await db.user.findUnique({ where: { id: user.id } }), "users are never touched")
  })

  test("a second instance skips the job while the first holds its lock", async () => {
    let release
    const held = new Promise(resolve => (release = resolve))
    let lockTaken
    const taken = new Promise(resolve => (lockTaken = resolve))
    const slow = { ...housekeeping, async run(tx) {
      lockTaken()
      await held
      return housekeeping.run(tx)
    } }
    const first = runOnce(db, slow, logger)
    await taken
    assert.equal(await runOnce(db, housekeeping, logger), "skipped")
    release()
    assert.equal(await first, "ok")
    assert.equal(await runOnce(db, housekeeping, logger), "ok", "the lock is released when the run commits")
  })
})

describe("Stage 08 worker jobs", () => {
  test("outbox delivery: delivered once, failures retried later with the error kept", async () => {
    const { outboxJob, retryDelayMs } = await import("../../../apps/worker/src/jobs/outbox.ts")
    const product = { productId: "p", handle: "h", collections: [], change: "published" }
    const ok = await db.outboxEvent.create({ data: { topic: "catalogue.updated", aggregateType: "product", aggregateId: "a", payload: product } })
    const bad = await db.outboxEvent.create({ data: { topic: "unknown.topic", aggregateType: "product", aggregateId: "b", payload: product } })
    const delivered = []
    const job = outboxJob(logger, { "catalogue.updated": async event => void delivered.push(event.id) })
    assert.equal(await runOnce(db, job, logger), "ok")
    assert.deepEqual(delivered, [ok.id])
    assert.ok((await db.outboxEvent.findUnique({ where: { id: ok.id } })).dispatchedAt)
    const failed = await db.outboxEvent.findUnique({ where: { id: bad.id } })
    assert.equal(failed.dispatchedAt, null)
    assert.equal(failed.attempts, 1)
    assert.match(failed.lastError, /no handler/)
    assert.ok(failed.availableAt > new Date(), "retried later, not in a tight loop")
    await runOnce(db, job, logger)
    assert.deepEqual(delivered, [ok.id], "a delivered event is not delivered again")
    assert.deepEqual([1, 2, 3, 10].map(retryDelayMs), [60_000, 120_000, 240_000, 3_600_000])
  })

  test("media clean-up deletes abandoned uploads and photos removed more than 7 days ago, nothing else", async () => {
    const { mediaCleanupJob, REMOVED_MEDIA_GRACE_MS } = await import("../../../apps/worker/src/jobs/media-cleanup.ts")
    const removedKeys = []
    const storage = () => ({ remove: async key => void removedKeys.push(key) })
    const product = await db.product.create({ data: { handle: `cleanup-${Date.now()}`, title: "Clean-up fixture" } })
    const staffId = (await db.user.create({ data: { email: `cleanup-${Date.now()}@example.com` } })).id
    const checksum = "A".repeat(43) + "="
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await db.mediaUpload.create({ data: { productId: product.id, stagingKey: "staging/abandoned", contentType: "image/png", byteSize: 10, checksumSha256: checksum, createdById: staffId, createdAt: new Date(old.getTime() - 1000), expiresAt: old } })
    await db.mediaUpload.create({ data: { productId: product.id, stagingKey: "staging/open", contentType: "image/png", byteSize: 10, checksumSha256: checksum, createdById: staffId, expiresAt: new Date(Date.now() + 60_000) } })
    const longGone = await db.productMedia.create({ data: { productId: product.id, status: "approved", url: "https://media.example/public/a.png", storageKey: "public/a.png", removedAt: new Date(Date.now() - REMOVED_MEDIA_GRACE_MS - 1000) } })
    await db.productMedia.create({ data: { productId: product.id, status: "approved", url: "https://media.example/public/b.png", storageKey: "public/b.png", removedAt: new Date() } })
    await db.productMedia.create({ data: { productId: product.id, status: "approved", url: "https://media.example/public/c.png", storageKey: "public/c.png" } })
    assert.equal(await runOnce(db, mediaCleanupJob(storage), logger), "ok")
    assert.deepEqual(removedKeys.sort(), ["public/a.png", "staging/abandoned"])
    assert.equal((await db.productMedia.findUnique({ where: { id: longGone.id } })).storageKey, null, "the row stays for the audit trail")
    await runOnce(db, mediaCleanupJob(storage), logger)
    assert.equal(removedKeys.length, 2, "nothing is deleted twice")
  })
})
