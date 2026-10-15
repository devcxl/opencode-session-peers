import { describe, expect, test } from "bun:test"

import { admitInbound, canStartAsk, deliveryFor } from "../src/domain/policy.ts"
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

describe("admitInbound", () => {
  test("a peer that declares always takes any message", () => {
    expect(admitInbound({ declared: "always", exchange: false })).toEqual({ ok: true })
    expect(admitInbound({ declared: "always", exchange: true })).toEqual({ ok: true })
  })

  test("replies admits only the two directions of an exchange", () => {
    expect(admitInbound({ declared: "replies", exchange: true })).toEqual({ ok: true })
    expect(admitInbound({ declared: "replies", exchange: false })).toEqual({
      ok: false,
      code: "E_TARGET_REPLIES_ONLY",
    })
  })

  test("never admits nothing", () => {
    expect(admitInbound({ declared: "never", exchange: true })).toEqual({ ok: false, code: "E_TARGET_REFUSES" })
    expect(admitInbound({ declared: "never", exchange: false })).toEqual({ ok: false, code: "E_TARGET_REFUSES" })
  })

  test("a record that carries no declaration fails closed", () => {
    expect(admitInbound({ declared: undefined, exchange: false })).toEqual({
      ok: false,
      code: "E_TARGET_POLICY_UNKNOWN",
    })
    expect(admitInbound({ declared: undefined, exchange: true })).toEqual({
      ok: false,
      code: "E_TARGET_POLICY_UNKNOWN",
    })
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
