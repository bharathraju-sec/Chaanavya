// CHV-S02-003: duplicate provider events have stable, idempotent semantics.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { classifyProviderEvent, replayPaymentEvents } from "../../packages/contracts/src/modules/state-machines.ts"

const event = (eventId, target, fingerprint = `fp-${eventId}`, extra = {}) => ({ provider: "razorpay", eventId, fingerprint, target, ...extra })

describe("CHV-S02-003 duplicate provider events", () => {
  test("classification: new, duplicate, conflicting", () => {
    const seen = new Map([["razorpay:evt_1", "fp-a"]])
    assert.equal(classifyProviderEvent(seen, { provider: "razorpay", eventId: "evt_2", fingerprint: "fp-b" }), "apply")
    assert.equal(classifyProviderEvent(seen, { provider: "razorpay", eventId: "evt_1", fingerprint: "fp-a" }), "duplicate")
    assert.equal(classifyProviderEvent(seen, { provider: "razorpay", eventId: "evt_1", fingerprint: "fp-tampered" }), "conflict")
    assert.equal(classifyProviderEvent(seen, { provider: "phonepe", eventId: "evt_1", fingerprint: "fp-a" }), "apply", "IDs are scoped by provider")
  })

  test("a duplicated capture has one financial effect", () => {
    const result = replayPaymentEvents("created", [event("e1", "authorized"), event("e2", "captured"), event("e2", "captured")])
    assert.equal(result.status, "captured")
    assert.deepEqual(result.applied, ["e1", "e2"])
    assert.deepEqual(result.duplicates, ["e2"])
  })

  test("out-of-order events never move the status backwards", () => {
    const result = replayPaymentEvents("created", [event("e2", "captured"), event("e1", "authorized")])
    assert.equal(result.status, "captured")
    assert.deepEqual(result.applied, ["e2"])
    assert.deepEqual(result.ignored, ["e1"])
  })

  test("a second event ID for the state we are already in is a no-op", () => {
    const result = replayPaymentEvents("captured", [event("e9", "captured")])
    assert.equal(result.status, "captured")
    assert.deepEqual(result.applied, [])
    assert.deepEqual(result.duplicates, ["e9"])
  })

  test("same event ID with a different body is a conflict and changes nothing", () => {
    const result = replayPaymentEvents("created", [event("e1", "failed", "fp-1"), event("e1", "captured", "fp-2")])
    assert.equal(result.status, "failed")
    assert.deepEqual(result.conflicts, ["e1"])
  })

  test("replaying the whole stream gives the same final state", () => {
    const stream = [event("e1", "authorized"), event("e2", "captured"), event("r1", "partially_refunded", "fp-r1", { refundFullyCovered: false }), event("r2", "refunded", "fp-r2", { refundFullyCovered: true })]
    const once = replayPaymentEvents("created", stream)
    const twice = replayPaymentEvents("created", [...stream, ...stream])
    assert.equal(once.status, "refunded")
    assert.equal(twice.status, once.status)
    assert.deepEqual(twice.applied, once.applied)
    assert.equal(twice.duplicates.length, stream.length)
  })

  test("events after a terminal state are ignored", () => {
    const result = replayPaymentEvents("created", [event("e1", "failed"), event("e2", "captured")])
    assert.equal(result.status, "failed")
    assert.deepEqual(result.ignored, ["e2"])
  })
})
