import { describe, expect, test } from "bun:test"

import { canStartAsk, deliveryFor, shouldDeliver } from "../src/domain/policy.ts"
import type { InboundPolicy } from "../src/domain/policy.ts"

const ALWAYS_STEER: InboundPolicy = { trigger: "always", busyDelivery: "steer" }

describe("deliveryFor", () => {
  test("queues for an idle recipient so the message starts its own turn", () => {
    expect(deliveryFor({ recipientIdle: true, policy: ALWAYS_STEER })).toBe("queue")
  })

  test("uses the configured delivery for a recipient that is mid-turn", () => {
    expect(deliveryFor({ recipientIdle: false, policy: ALWAYS_STEER })).toBe("steer")
    expect(deliveryFor({ recipientIdle: false, policy: { trigger: "always", busyDelivery: "queue" } })).toBe("queue")
  })
})

describe("shouldDeliver", () => {
  test("always admits both questions and plain messages", () => {
    expect(shouldDeliver({ expectsReply: true, policy: ALWAYS_STEER })).toBe(true)
    expect(shouldDeliver({ expectsReply: false, policy: ALWAYS_STEER })).toBe(true)
  })

  test("replies admits only answers to an ask", () => {
    const policy: InboundPolicy = { trigger: "replies", busyDelivery: "steer" }
    expect(shouldDeliver({ expectsReply: true, policy })).toBe(true)
    expect(shouldDeliver({ expectsReply: false, policy })).toBe(false)
  })

  test("never admits nothing", () => {
    const policy: InboundPolicy = { trigger: "never", busyDelivery: "steer" }
    expect(shouldDeliver({ expectsReply: true, policy })).toBe(false)
    expect(shouldDeliver({ expectsReply: false, policy })).toBe(false)
  })
})

describe("canStartAsk", () => {
  test("admits an ask when nothing is outstanding", () => {
    expect(canStartAsk({ askInFlight: false, targetAskToUs: false })).toEqual({ ok: true })
  })

  test("refuses a second concurrent ask", () => {
    expect(canStartAsk({ askInFlight: true, targetAskToUs: false })).toEqual({ ok: false, code: "E_ASK_IN_FLIGHT" })
  })

  test("refuses a mutual ask in favour of answering first", () => {
    expect(canStartAsk({ askInFlight: false, targetAskToUs: true })).toEqual({ ok: false, code: "E_MUTUAL_ASK" })
  })
})
