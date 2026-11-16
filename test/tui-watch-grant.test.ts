/**
 * The controlled grant flow through the TuiPort seam: review first, prepare a
 * short-lived challenge, confirm only after explicit confirmation, and never
 * expose the challenge itself in the panel or use it as human proof.
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import { installWatch } from "../src/tui/watch-command.tsx"
import {
  SELF,
  attempt,
  commandOf,
  control,
  correction,
  deferred,
  fakePort,
  grantChallenge,
  grantPayload,
  mountPanel,
  payload,
  task,
  tick,
} from "./tui-watch-fake.ts"

function grantableView(
  overrides: Partial<NonNullable<WatchPayload["task"]>["correction"]["controls"]> = {},
): WatchPayload {
  return payload({
    task: task({
      correction: correction({
        controls: {
          grant: control(),
          downgrade: control(false, "no grant is active"),
          ...overrides,
        },
      }),
    }),
  })
}

function panelText(setup: Awaited<ReturnType<typeof mountPanel>>): string {
  return setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
}

describe("controlled correction grant", () => {
  test("opening correction and reviewing terms writes nothing", async () => {
    const fake = fakePort({ read: async () => grantableView() })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    await panel.flush()

    const text = panelText(panel).replace(/\/ /g, "/")
    expect(text).toContain("3 permanent auto attempts")
    expect(text).toContain("5 min observation after each")
    expect(text).toContain("same OS user/location")
    expect(text).toContain("single-host declaration is not proof")
    expect(text).toContain("channel is not human authentication")
    expect(text).toContain("never reset attempts or window")
    expect(text).toContain("Queue admission is not consumption and is irreversible")
    expect(fake.grantCalls).toEqual([])
    expect(fake.calls).toEqual([])
    dispose()
    panel.renderer.destroy()
  })

  test("review displays the exact canonical WATCH_CORRECTION_TERMS before preparing", async () => {
    const fake = fakePort({ read: async () => grantableView() })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    await panel.flush()

    const text = panelText(panel).replace(/\/ /g, "/")
    expect(text).toContain(WATCH_CORRECTION_TERMS)
    expect(text).toContain("y: declare + prepare challenge · n: cancel")
    expect(fake.grantCalls).toEqual([])
    dispose()
    panel.renderer.destroy()
  })

  test("n cancels a review without preparing a challenge", async () => {
    let prepares = 0
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async () => {
        prepares += 1
        return grantPayload()
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("n")
    await panel.flush()

    expect(prepares).toBe(0)
    expect(fake.grantCalls).toEqual([])
    expect(panelText(panel)).not.toContain("three permanent attempts")
    dispose()
    panel.renderer.destroy()
  })

  test("prepare and confirm carry the exact controlled request and no nonce reaches the screen", async () => {
    let current = grantableView()
    const challenge = grantChallenge()
    const fake = fakePort({
      read: async () => current,
      grant: async (request) => {
        if (request.operation === "prepare") {
          return grantPayload({ challenge, task: current.task })
        }
        current = payload({
          task: task({
            correction: correction({
              authorization: {
                mode: "limited-correction",
                state: "granted",
                deployment: "single-host-same-location",
                version: 2,
                reviewSummary: challenge.reviewSummary,
                grantedAt: 2_000,
              },
              controls: {
                grant: control(false, "grant is recorded"),
                downgrade: control(true),
              },
            }),
          }),
        })
        return grantPayload({ task: current.task })
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    expect(fake.grantCalls[0]).toEqual({
      operation: "prepare",
      sessionID: SELF,
      taskID: "task_0001",
      expectedVersion: 3,
      deployment: "single-host-same-location",
    })
    expect(panelText(panel)).toContain("Challenge prepared")
    expect(panelText(panel)).not.toContain("challenge-once")

    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()
    expect(fake.grantCalls[1]).toEqual({
      operation: "confirm",
      sessionID: SELF,
      taskID: "task_0001",
      expectedVersion: 3,
      challenge: "challenge-once",
      generation: 1,
      termsDigest: "terms-digest",
      deployment: "single-host-same-location",
    })
    expect(fake.toasts).toContainEqual({
      message: "Grant recorded; authorization is not delivery. Check attempt status.",
      variant: "success",
    })
    expect(panelText(panel)).toContain("limited correction")
    expect(panelText(panel)).toContain("Grant active; actual send remains unavailable")
    expect(panelText(panel)).not.toContain("challenge-once")
    dispose()
    panel.renderer.destroy()
  })

  test("a failed prepare is reported once and is not retried automatically", async () => {
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async () =>
        grantPayload({
          ok: false,
          challenge: null,
          failure: {
            code: "E_WATCH_STALE",
            reason: "the task version changed",
            detail: null,
          },
        }),
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.grantCalls).toHaveLength(1)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("E_WATCH_STALE")
    expect(panelText(panel)).not.toContain("Challenge prepared")
    dispose()
    panel.renderer.destroy()
  })

  test("a failed confirm does not prepare again", async () => {
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async (request) =>
        request.operation === "prepare"
          ? grantPayload({ challenge: grantChallenge() })
          : grantPayload({
              ok: false,
              challenge: null,
              failure: {
                code: "E_WATCH_STALE",
                reason: "the challenge expired",
                detail: null,
              },
            }),
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.grantCalls.map((call) => call.operation)).toEqual(["prepare", "confirm"])
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("E_WATCH_STALE")
    dispose()
    panel.renderer.destroy()
  })

  test("server-disabled grant is not armed, even though global detection is partial", async () => {
    let prepares = 0
    const fake = fakePort({
      read: async () =>
        grantableView({
          grant: control(false, "the current activation does not own this task"),
        }),
      grant: async () => {
        prepares += 1
        return grantPayload()
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()

    expect(prepares).toBe(0)
    expect(panelText(panel)).toContain("does not own this task")
    dispose()
    panel.renderer.destroy()
  })

  test("downgrade sends only the four downgrade fields and preserves used attempts", async () => {
    let current = payload({
      task: task({
        correction: correction({
          attempts: { used: 2, limit: 3 },
          history: [
            attempt({ attemptID: "attempt_0001", ordinal: 1, phase: "rejected" }),
            attempt({ attemptID: "attempt_0002", ordinal: 2, phase: "recovered" }),
          ],
          controls: {
            grant: control(false, "grant is recorded"),
            downgrade: control(true),
          },
        }),
      }),
    })
    const fake = fakePort({
      read: async () => current,
      grant: async (request) => {
        if (request.operation === "downgrade") {
          current = payload({
            task: task({
              correction: correction({
                attempts: { used: 2, limit: 3 },
                history: [
                  attempt({ attemptID: "attempt_0001", ordinal: 1, phase: "rejected" }),
                  attempt({ attemptID: "attempt_0002", ordinal: 2, phase: "recovered" }),
                ],
                authorization: {
                  mode: "alert",
                  state: "revoked",
                  deployment: "single-host-same-location",
                  version: 3,
                  reviewSummary: "downgraded",
                  grantedAt: 1_000,
                },
                controls: {
                  grant: control(),
                  downgrade: control(false, "no grant is active"),
                },
              }),
            }),
          })
        }
        return grantPayload({ task: current.task })
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("d")
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.grantCalls).toEqual([
      {
        operation: "downgrade",
        sessionID: SELF,
        taskID: "task_0001",
        expectedVersion: 3,
      },
    ])
    expect(fake.toasts).toContainEqual({
      message: "Downgraded to alert-only. Business work continues; used attempts are unchanged.",
      variant: "success",
    })
    expect(panelText(panel)).toContain("2 of 3 used")
    dispose()
    panel.renderer.destroy()
  })
})

describe("late grant work", () => {
  test("a prepare response after close does not arm a challenge or toast", async () => {
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async () => grantableView(),
      grant: () => slow.promise,
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    expect(fake.grantCalls).toHaveLength(1)

    fake.close()
    slow.resolve(grantPayload({ challenge: grantChallenge() }))
    await tick(0)

    expect(fake.toasts).toEqual([])
    expect(fake.grantCalls).toHaveLength(1)
    dispose()
    panel.renderer.destroy()
  })

  test("a confirm response after dispose does not toast or reopen", async () => {
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async (request) =>
        request.operation === "prepare"
          ? grantPayload({ challenge: grantChallenge() })
          : slow.promise,
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    panel.mockInput.pressKey("y")
    await panel.flush()
    expect(fake.grantCalls.map((call) => call.operation)).toEqual(["prepare", "confirm"])

    dispose()
    slow.resolve(grantPayload())
    await tick(0)

    expect(fake.toasts).toEqual([])
    expect(fake.subscribed()).toBe(false)
    panel.renderer.destroy()
  })
})

describe("grant changes and stale challenges", () => {
  test("a challenge with mismatched reviewSummary is rejected fail-closed, does not confirm, does not display challenge, and toasts a generic error", async () => {
    const secretNonce = "secret-mismatched-nonce-999"
    const mismatchedTerms = "Altered terms: arbitrary send permitted without limits."
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async (request) => {
        if (request.operation === "prepare") {
          return grantPayload({
            challenge: grantChallenge({
              challenge: secretNonce,
              reviewSummary: mismatchedTerms,
            }),
          })
        }
        return grantPayload()
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    // 1. Prepare was called, but challenge was rejected fail-closed
    expect(fake.grantCalls.map((c) => c.operation)).toEqual(["prepare"])
    // 2. Generic nonce-safe error toasted without echoing nonce, payload text or canonical terms
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toBe(
      "Could not prepare the correction grant: the challenge terms summary did not match the canonical terms.",
    )
    expect(fake.toasts[0]?.message).not.toContain(secretNonce)
    expect(fake.toasts[0]?.message).not.toContain(mismatchedTerms)
    expect(fake.toasts[0]?.message).not.toContain(WATCH_CORRECTION_TERMS)
    // 3. Screen does not enter confirm stage ("Challenge prepared" not shown) and does not show nonce
    expect(panelText(panel)).not.toContain("Challenge prepared")
    expect(panelText(panel)).not.toContain(secretNonce)

    // 4. Pressing y does not confirm
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    expect(fake.grantCalls.map((c) => c.operation)).toEqual(["prepare"])

    dispose()
    panel.renderer.destroy()
  })

  test("a challenge for another task version is refused and not confirmed", async () => {
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async () => grantPayload({ challenge: grantChallenge({ expectedVersion: 4 }) }),
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()

    expect(fake.grantCalls).toHaveLength(1)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.message).toContain("another task version")
    expect(panelText(panel)).not.toContain("Challenge prepared")
    dispose()
    panel.renderer.destroy()
  })

  test("a prepare response after opening B does not arm the old panel", async () => {
    const other = "ses_other9999"
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async (request) => panelPayloadFor(request.sessionID),
      grant: () => slow.promise,
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panelA = await mountPanel(fake)
    panelA.mockInput.pressKey("c")
    panelA.mockInput.pressKey("g")
    panelA.mockInput.pressKey("y")
    await panelA.flush()
    expect(fake.grantCalls).toHaveLength(1)

    fake.setSession(other)
    commandOf(fake).run()
    await tick(0)
    slow.resolve(grantPayload({ challenge: grantChallenge() }))
    await tick(0)

    expect(fake.toasts).toEqual([])
    expect(fake.grantCalls).toHaveLength(1)
    const panelB = await mountPanel(fake)
    expect(panelText(panelB)).not.toContain("Challenge prepared")
    dispose()
    panelA.renderer.destroy()
    panelB.renderer.destroy()
  })
})

function panelPayloadFor(sessionID: string): WatchPayload {
  return payload({
    task: task({
      taskID: sessionID === SELF ? "task_0001" : "task_b",
      initiatorSessionID: sessionID,
      targetSessionID: sessionID,
      correction: correction({
        controls: { grant: control(), downgrade: control(false, "no grant") },
      }),
    }),
  })
}

describe("grant challenge redaction", () => {
  test("a rejected confirm error containing the nonce is not echoed to toast or screen", async () => {
    const nonce = "secret-challenge-once"
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async (request) => {
        if (request.operation === "prepare") {
          return grantPayload({ challenge: grantChallenge({ challenge: nonce }) })
        }
        throw new Error(`RPC rejected request ${nonce}`)
      },
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.grantCalls.map((call) => call.operation)).toEqual(["prepare", "confirm"])
    expect(fake.reads.length).toBeGreaterThan(1)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).not.toContain(nonce)
    expect(panelText(panel)).not.toContain(nonce)
    dispose()
    panel.renderer.destroy()
  })

  test("a response failure reason containing the nonce renders only the safe code", async () => {
    const nonce = "secret-challenge-once"
    const fake = fakePort({
      read: async () => grantableView(),
      grant: async (request) =>
        request.operation === "prepare"
          ? grantPayload({ challenge: grantChallenge({ challenge: nonce }) })
          : grantPayload({
              ok: false,
              challenge: null,
              failure: {
                code: "E_WATCH_STALE",
                reason: `the challenge ${nonce} expired`,
                detail: null,
              },
            }),
    })
    const dispose = installWatch(fake.port, { now: () => 1_000 })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("c")
    panel.mockInput.pressKey("g")
    panel.mockInput.pressKey("y")
    await panel.flush()
    panel.mockInput.pressKey("y")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.grantCalls.map((call) => call.operation)).toEqual(["prepare", "confirm"])
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.message).toContain("E_WATCH_STALE")
    expect(fake.toasts[0]?.message).not.toContain(nonce)
    expect(panelText(panel)).not.toContain(nonce)
    dispose()
    panel.renderer.destroy()
  })
})
