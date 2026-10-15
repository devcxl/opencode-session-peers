import { describe, expect, test } from "bun:test"

import {
  admitInbound,
  blockingAsk,
  canStartAsk,
  chooseAskToAnswer,
  deliveryFor,
  outstandingAsksFrom,
  pendingAsksFor,
} from "../src/domain/policy.ts"
import type { InboundPolicy } from "../src/domain/policy.ts"
import type { AskRecord } from "../src/domain/types.ts"

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

const NOW = 1_700_000_000_000

function ask(overrides: Partial<AskRecord> & { askID: string }): AskRecord {
  return {
    askerSessionID: "ses_asker",
    askerInstanceID: "instance-a",
    askerTitle: "Payments API",
    targetSessionID: "ses_us",
    question: "Why is the API frozen?",
    createdAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  }
}

describe("pendingAsksFor and outstandingAsksFrom", () => {
  test("count only the questions whose asker is still waiting", () => {
    const waiting = ask({ askID: "ask_waiting" })
    const ended = ask({ askID: "ask_ended", expiresAt: NOW - 1 })
    const elsewhere = ask({ askID: "ask_elsewhere", targetSessionID: "ses_other" })
    const asks = [waiting, ended, elsewhere]

    expect(pendingAsksFor(asks, "ses_us", NOW).map((entry) => entry.askID)).toEqual(["ask_waiting"])
    // From the asker's side the target does not matter: both of its own
    // waiting questions are outstanding, and the ended one is not.
    expect(outstandingAsksFrom(asks, "ses_asker", NOW).map((entry) => entry.askID)).toEqual([
      "ask_waiting",
      "ask_elsewhere",
    ])
    expect(pendingAsksFor(asks, "ses_nobody", NOW)).toEqual([])
  })

  test("list the oldest ask first", () => {
    const newer = ask({ askID: "ask_newer", createdAt: NOW - 500 })
    const older = ask({ askID: "ask_older", createdAt: NOW - 2_000 })
    expect(pendingAsksFor([newer, older], "ses_us", NOW).map((entry) => entry.askID)).toEqual([
      "ask_older",
      "ask_newer",
    ])
  })
})

describe("chooseAskToAnswer", () => {
  test("answers the only question this session was asked", () => {
    const only = ask({ askID: "ask_only" })
    expect(chooseAskToAnswer({ asks: [only], sessionID: "ses_us", now: NOW })).toEqual({
      kind: "answer",
      ask: only,
    })
  })

  test("has nothing to answer when no question was addressed here", () => {
    expect(
      chooseAskToAnswer({ asks: [ask({ askID: "ask_other" })], sessionID: "ses_other", now: NOW }),
    ).toEqual({ kind: "none" })
  })

  test("prefers the question whose asker is still waiting", () => {
    const ended = ask({ askID: "ask_ended", expiresAt: NOW - 1 })
    const waiting = ask({ askID: "ask_waiting", askerSessionID: "ses_second" })
    expect(chooseAskToAnswer({ asks: [ended, waiting], sessionID: "ses_us", now: NOW })).toEqual({
      kind: "answer",
      ask: waiting,
    })
  })

  test("still answers one whose wait has ended, so a late answer is not dropped", () => {
    const ended = ask({ askID: "ask_ended", expiresAt: NOW - 1 })
    expect(chooseAskToAnswer({ asks: [ended], sessionID: "ses_us", now: NOW })).toEqual({
      kind: "answer",
      ask: ended,
    })
  })

  test("names the asker by id, title or id prefix", () => {
    const first = ask({ askID: "ask_1", askerSessionID: "ses_aaaa1111", askerTitle: "Payments API" })
    const second = ask({ askID: "ask_2", askerSessionID: "ses_bbbb2222", askerTitle: "Docs site" })
    const asks = [first, second]

    for (const from of ["ses_bbbb2222", "docs site", "ses_bbbb"]) {
      expect(chooseAskToAnswer({ asks, sessionID: "ses_us", now: NOW, from })).toEqual({
        kind: "answer",
        ask: second,
      })
    }
    expect(chooseAskToAnswer({ asks, sessionID: "ses_us", now: NOW, from: "Nobody" })).toEqual({ kind: "none" })
  })

  test("names the question itself, which is what disambiguates two askers", () => {
    const first = ask({ askID: "ask_1" })
    const second = ask({ askID: "ask_2", askerSessionID: "ses_second" })
    expect(chooseAskToAnswer({ asks: [first, second], sessionID: "ses_us", now: NOW, replyTo: "ask_2" })).toEqual(
      { kind: "answer", ask: second },
    )
    expect(
      chooseAskToAnswer({ asks: [first, second], sessionID: "ses_us", now: NOW, replyTo: "ask_nope" }),
    ).toEqual({ kind: "none" })
  })

  test("refuses to choose between two waiting questions", () => {
    const first = ask({ askID: "ask_1", createdAt: NOW - 2_000 })
    const second = ask({ askID: "ask_2", askerSessionID: "ses_second", createdAt: NOW - 1_000 })
    const choice = chooseAskToAnswer({ asks: [first, second], sessionID: "ses_us", now: NOW })
    expect(choice.kind).toBe("ambiguous")
    if (choice.kind !== "ambiguous") return
    expect(choice.asks.map((entry) => entry.askID)).toEqual(["ask_1", "ask_2"])
  })
})

describe("blockingAsk", () => {
  test("blocks a send to anyone but the asker while a question waits", () => {
    const waiting = ask({ askID: "ask_waiting" })
    expect(blockingAsk([waiting], "ses_us", "ses_third", NOW)?.askID).toBe("ask_waiting")
    expect(blockingAsk([waiting], "ses_us", "ses_asker", NOW)).toBeUndefined()
  })

  test("blocks nothing once the wait has ended", () => {
    const ended = ask({ askID: "ask_ended", expiresAt: NOW - 1 })
    expect(blockingAsk([ended], "ses_us", "ses_third", NOW)).toBeUndefined()
  })
})
