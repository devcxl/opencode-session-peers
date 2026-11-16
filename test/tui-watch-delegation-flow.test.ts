/**
 * Targeted tests for the controlled delegation grant flow.
 *
 * Verifies two-step exact RPC payloads, fail-closed handling of mismatched
 * review terms, nonce protection (the nonce is never echoed in errors or
 * toasts), and lifecycle isolation (late responses after close/dispose do
 * not arm challenges or toast).
 */

import { describe, expect, test } from "bun:test"

import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import { WATCH_DELEGATION_TERMS } from "../src/watch/delegation.ts"
import { createWatchDelegationFeed } from "../src/tui/watch-delegation-feed.ts"
import { createDelegationFlow } from "../src/tui/watch-delegation-flow.ts"
import {
  SELF,
  delegationChallenge,
  delegationGrantPayload,
  fakePort,
} from "./tui-watch-fake.ts"

function setupFlow(options: Parameters<typeof fakePort>[0] = {}) {
  const fake = fakePort(options)
  let open = true
  let sessionID: string | undefined = SELF
  let parentTaskID: string | undefined = "task_parent_001"
  let expectedVersion: number | undefined = 3
  let disposed = false
  let epoch = 1

  const feed = createWatchDelegationFeed(fake.port.watchDelegation)
  const flow = createDelegationFlow({
    port: fake.port,
    feed,
    isDisposed: () => disposed,
    panel: () => ({
      open,
      sessionID,
      parentTaskID,
      expectedVersion,
    }),
    epoch: () => epoch,
  })

  return {
    fake,
    feed,
    flow,
    setOpen: (val: boolean) => {
      open = val
    },
    setSessionID: (id: string | undefined) => {
      sessionID = id
    },
    setParentTaskID: (id: string | undefined) => {
      parentTaskID = id
    },
    setExpectedVersion: (v: number | undefined) => {
      expectedVersion = v
    },
    nextEpoch: () => {
      epoch += 1
    },
    dispose: () => {
      disposed = true
      feed.dispose()
      flow.clear()
    },
  }
}

describe("delegation flow exact RPC payloads", () => {
  test("prepare for alert mode sends only required fields and no deployment declaration", async () => {
    const { fake, flow, dispose } = setupFlow({
      delegation: async (request) => {
        if (request.operation === "prepare") {
          return delegationGrantPayload({
            challenge: delegationChallenge({
              parentTaskID: "task_parent_001",
              expectedVersion: 3,
              targetSessionID: "ses_child_001",
              mode: "alert",
            }),
          })
        }
        return delegationGrantPayload()
      },
    })

    const prepared = await flow.prepare("ses_child_001", "alert")
    expect(prepared).toBeDefined()
    expect(prepared?.targetSessionID).toBe("ses_child_001")
    expect(prepared?.mode).toBe("alert")
    expect(prepared?.reviewSummary).toBe(WATCH_DELEGATION_TERMS)

    expect(fake.delegationCalls).toHaveLength(1)
    expect(fake.delegationCalls[0]).toEqual({
      operation: "prepare",
      sessionID: SELF,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_001",
      mode: "alert",
    })
    // Ensure deployment is NOT present for alert mode
    expect(fake.delegationCalls[0]?.deployment).toBeUndefined()

    dispose()
  })

  test("prepare for limited-correction carries deployment declaration and confirm consumes challenge with exact fields", async () => {
    const secretNonce = "secret-delegation-nonce-777"
    const challenge = delegationChallenge({
      challenge: secretNonce,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_002",
      mode: "limited-correction",
      deployment: "single-host-same-location",
      scopeDirectory: "/tmp/project",
      scopePeerScope: "scope-a",
      termsDigest: "terms-digest-abc",
    })

    const { fake, flow, dispose } = setupFlow({
      delegation: async (request) => {
        if (request.operation === "prepare") {
          return delegationGrantPayload({
            challenge,
            review: {
              delegationTerms: WATCH_DELEGATION_TERMS,
              correctionTerms: WATCH_CORRECTION_TERMS,
              deploymentRequired: true,
            },
          })
        }
        if (request.operation === "confirm") {
          return delegationGrantPayload({
            ok: true,
            grant: {
              grantID: "grant-001",
              parentTaskID: "task_parent_001",
              parentSessionID: SELF,
              mode: "limited-correction",
              state: "granted",
              version: 1,
              generation: 1,
              targetSessionID: "ses_child_002",
              scopeDirectory: "/tmp/project",
              scopePeerScope: "scope-a",
              reviewSummary: WATCH_DELEGATION_TERMS,
              deployment: "single-host-same-location",
              grantedAt: 1_000,
              revokedAt: null,
            },
          })
        }
        return delegationGrantPayload()
      },
    })

    const prepared = await flow.prepare("ses_child_002", "limited-correction")
    expect(prepared).toBeDefined()
    expect(fake.delegationCalls[0]).toEqual({
      operation: "prepare",
      sessionID: SELF,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_002",
      mode: "limited-correction",
      deployment: "single-host-same-location",
    })

    // Confirm consumes stored challenge
    await flow.confirm()
    expect(fake.delegationCalls).toHaveLength(2)
    expect(fake.delegationCalls[1]).toEqual({
      operation: "confirm",
      sessionID: SELF,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_002",
      challenge: secretNonce,
      generation: 1,
      termsDigest: "terms-digest-abc",
      scopeDirectory: "/tmp/project",
      scopePeerScope: "scope-a",
      deployment: "single-host-same-location",
    })

    expect(fake.toasts).toContainEqual({
      message: "Delegation grant recorded; authorization is not delivery. Check child status.",
      variant: "success",
    })

    dispose()
  })

  test("revoke sends only exact fields and no mode", async () => {
    const { fake, flow, dispose } = setupFlow({
      delegation: async (request) => {
        if (request.operation === "revoke") {
          return delegationGrantPayload({
            ok: true,
            grant: {
              grantID: "grant-001",
              parentTaskID: "task_parent_001",
              parentSessionID: SELF,
              mode: "alert",
              state: "revoked",
              version: 2,
              generation: 1,
              targetSessionID: "ses_child_003",
              scopeDirectory: "/tmp/project",
              scopePeerScope: "scope-a",
              reviewSummary: WATCH_DELEGATION_TERMS,
              deployment: null,
              grantedAt: 1_000,
              revokedAt: 2_000,
            },
          })
        }
        return delegationGrantPayload()
      },
    })

    await flow.revoke("ses_child_003")
    expect(fake.delegationCalls).toHaveLength(1)
    expect(fake.delegationCalls[0]).toEqual({
      operation: "revoke",
      sessionID: SELF,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_003",
    })
    // Revoke must NOT send mode
    expect((fake.delegationCalls[0] as unknown as Record<string, unknown>)["mode"]).toBeUndefined()

    expect(fake.toasts).toContainEqual({
      message: "Delegation grant revoked for ses_child_003. Existing child attempts are unchanged.",
      variant: "success",
    })

    dispose()
  })
})

describe("delegation terms and challenge fail-closed validation", () => {
  test("mismatched challenge terms are rejected fail-closed, does not arm confirm, and toasts generic error", async () => {
    const secretNonce = "leakable-secret-nonce-12345"
    const alteredTerms = "Altered delegation terms: unrestricted delegation allowed."
    const { fake, flow, dispose } = setupFlow({
      delegation: async () =>
        delegationGrantPayload({
          challenge: delegationChallenge({
            challenge: secretNonce,
            parentTaskID: "task_parent_001",
            expectedVersion: 3,
            targetSessionID: "ses_child_mismatch",
            reviewSummary: alteredTerms,
          }),
        }),
    })

    const prepared = await flow.prepare("ses_child_mismatch", "alert")
    expect(prepared).toBeUndefined()

    // Generic error toasted without leaking secretNonce or altered terms
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("Could not prepare delegation grant")
    expect(fake.toasts[0]?.message).not.toContain(secretNonce)
    expect(fake.toasts[0]?.message).not.toContain(alteredTerms)

    // Confirm is not armed
    await flow.confirm()
    expect(fake.delegationCalls.map((c) => c.operation)).toEqual(["prepare"])

    dispose()
  })

  test("a challenge for another task version is rejected fail-closed", async () => {
    const { fake, flow, dispose } = setupFlow({
      delegation: async () =>
        delegationGrantPayload({
          challenge: delegationChallenge({
            parentTaskID: "task_parent_001",
            expectedVersion: 4, // Mismatched version
            targetSessionID: "ses_child_v4",
          }),
        }),
    })

    const prepared = await flow.prepare("ses_child_v4", "alert")
    expect(prepared).toBeUndefined()

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("another task or target parameters")

    await flow.confirm()
    expect(fake.delegationCalls.map((c) => c.operation)).toEqual(["prepare"])

    dispose()
  })
})

describe("delegation lifecycle isolation", () => {
  test("late prepare response after close or epoch switch does not arm challenge or toast", async () => {
    let slowResolve: ((val: unknown) => void) | undefined
    const slowPromise = new Promise((resolve) => {
      slowResolve = resolve
    })

    const { fake, flow, setOpen, nextEpoch, dispose } = setupFlow({
      delegation: () => slowPromise,
    })

    const prepPromise = flow.prepare("ses_child_slow", "alert")
    expect(fake.delegationCalls).toHaveLength(1)

    // Close panel and advance epoch before slow response arrives
    setOpen(false)
    nextEpoch()

    slowResolve?.(delegationGrantPayload({ challenge: delegationChallenge() }))
    const result = await prepPromise
    expect(result).toBeUndefined()
    expect(fake.toasts).toEqual([])

    // Subsequent confirm is a no-op
    await flow.confirm()
    expect(fake.delegationCalls).toHaveLength(1)

    dispose()
  })
})
