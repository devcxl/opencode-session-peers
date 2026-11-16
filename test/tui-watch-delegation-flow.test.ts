/**
 * Targeted tests for the controlled delegation grant flow.
 *
 * Verifies two-step exact RPC payloads, fail-closed handling of mismatched
 * review terms, nonce protection (the nonce is never echoed in errors or
 * toasts), and lifecycle isolation (late responses after close/dispose do
 * not arm challenges or toast).
 */

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

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

const runtimeVersion = (() => {
  const db = new Database(":memory:")
  const row = db.query("SELECT sqlite_version() AS version").get() as { version: string }
  db.close()
  return row.version
})()
const safeRuntime = (() => {
  const left = runtimeVersion.split(".").map((part) => Number.parseInt(part, 10))
  const right = [3, 51, 3]
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
})()

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

    // Confirm for alert mode carries mode: alert and NO deployment declaration
    await flow.confirm()
    expect(fake.delegationCalls).toHaveLength(2)
    expect(fake.delegationCalls[1]).toMatchObject({
      operation: "confirm",
      sessionID: SELF,
      parentTaskID: "task_parent_001",
      expectedVersion: 3,
      targetSessionID: "ses_child_001",
      mode: "alert",
    })
    expect(fake.delegationCalls[1]?.deployment).toBeUndefined()

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
              derivesCorrectionGrant: true,
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
      mode: "limited-correction",
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

  test("derivesCorrectionGrant bit mismatch fails closed and does not arm confirm", async () => {
    const { fake, flow, dispose } = setupFlow({
      delegation: async () =>
        delegationGrantPayload({
          challenge: delegationChallenge({
            targetSessionID: "ses_child_001",
            mode: "limited-correction",
            deployment: "single-host-same-location",
          }),
          review: {
            delegationTerms: WATCH_DELEGATION_TERMS,
            correctionTerms: WATCH_CORRECTION_TERMS,
            deploymentRequired: true,
            derivesCorrectionGrant: false, // Mismatched bit!
          },
        }),
    })

    const prepared = await flow.prepare("ses_child_001", "limited-correction")
    expect(prepared).toBeUndefined()
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toBe(
      "Could not prepare delegation grant: the challenge terms summary did not match canonical terms.",
    )

    // Confirm is not armed
    await flow.confirm()
    expect(fake.delegationCalls.map((c) => c.operation)).toEqual(["prepare"])
    dispose()
  })

  test("failure payload carrying nonce in code, reason or detail is sanitized and does not leak", async () => {
    const leakNonce = "leaked-secret-nonce-99999"
    const { fake, flow, dispose } = setupFlow({
      delegation: async (request) => {
        if (request.operation === "prepare") {
          return delegationGrantPayload({
            challenge: delegationChallenge({
              targetSessionID: "ses_child_001",
              challenge: leakNonce,
            }),
          })
        }
        return delegationGrantPayload({
          ok: false,
          failure: {
            code: `E_WATCH_STALE-${leakNonce}` as never,
            reason: `expired challenge with nonce ${leakNonce}`,
            detail: leakNonce,
          },
        })
      },
    })

    const prepared = await flow.prepare("ses_child_001", "alert")
    expect(prepared).toBeDefined()

    await flow.confirm()
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    // Nonce must NOT be present in toast message
    expect(fake.toasts[0]?.message).not.toContain(leakNonce)
    expect(fake.toasts[0]?.message).toBe("Could not confirm delegation grant: the grant was not recorded.")
    dispose()
  })
})

describe("real host delegation RPC bridge test", () => {
  const testBridge = safeRuntime ? test : test.skip

  testBridge("UI delegation flow bridges to real registered RPC and real SQLite ledger", async () => {
    const { fakeHost } = await import("./fake-host.ts")
    const pluginModule = await import("../src/index.ts")
    const { WATCH_STATE_DIR_ENV } = await import("../src/host/watch.ts")
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const stateDir = mkdtempSync(join(tmpdir(), "tui-watchdog-63-bridge-"))
    const PARENT_SESSION = "ses_bridge_parent"
    const CHILD_SESSION = "ses_bridge_child"
    const DIRECTORY = "/tmp/project-bridge"

    const host = fakeHost({
      caller: PARENT_SESSION,
      location: DIRECTORY,
      appVersion: "2.3.0-watchdog-location.1",
      sessions: [
        { id: PARENT_SESSION, directory: DIRECTORY },
        { id: CHILD_SESSION, parentID: PARENT_SESSION, directory: DIRECTORY },
      ],
    })

    const prevEnv = process.env[WATCH_STATE_DIR_ENV]
    process.env[WATCH_STATE_DIR_ENV] = stateDir
    let disposePlugin: (() => Promise<void> | void) | undefined

    try {
      disposePlugin = await pluginModule.default.setup(host.context)
      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC registered")

      // Enroll parent task via tool path
      const enrollResult = await host.call(
        "peers",
        {
          action: "watch",
          watch: {
            operation: "enroll",
            requestId: "bridge-req-1",
            goal: "Bridge test goal",
          },
        },
        PARENT_SESSION,
      )
      const parentTask = (
        (enrollResult.details as Record<string, unknown>).watch as Record<string, unknown>
      ).task as Record<string, unknown>
      const parentTaskID = parentTask["taskID"] as string
      const parentVersion = parentTask["version"] as number

      // Bridge TuiPort to real registered RPC surface using type-safe fakePort
      const fake = fakePort({
        sessionID: PARENT_SESSION,
        delegation: (req) => rpc.call("watchDelegation", req as unknown as Record<string, unknown>),
        delegationView: (req) => rpc.call("watchDelegationView", req as unknown as Record<string, unknown>),
      })

      const feed = createWatchDelegationFeed(fake.port.watchDelegation)
      const flow = createDelegationFlow({
        port: fake.port,
        feed,
        isDisposed: () => false,
        panel: () => ({
          open: true,
          sessionID: PARENT_SESSION,
          parentTaskID,
          expectedVersion: parentVersion,
        }),
        epoch: () => 1,
      })

      // 1. Prepare via real RPC
      const prepared = await flow.prepare(CHILD_SESSION, "limited-correction")
      expect(prepared).toBeDefined()
      expect(prepared?.targetSessionID).toBe(CHILD_SESSION)
      expect(prepared?.mode).toBe("limited-correction")

      // 2. Confirm via real RPC
      await flow.confirm()
      expect(fake.toasts).toContainEqual({
        message: "Delegation grant recorded; authorization is not delivery. Check child status.",
        variant: "success",
      })

      // 3. Verify real SQLite ledger via real watchDelegationView RPC
      const viewResult = (await rpc.call("watchDelegationView", {
        sessionID: PARENT_SESSION,
        parentTaskID,
      })) as Record<string, unknown>
      expect(viewResult["ok"]).toBe(true)
      const grants = viewResult["grants"] as Record<string, unknown>[]
      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({
        parentTaskID,
        targetSessionID: CHILD_SESSION,
        mode: "limited-correction",
        state: "granted",
        deployment: "single-host-same-location",
      })

      feed.dispose()
    } finally {
      if (prevEnv === undefined) delete process.env[WATCH_STATE_DIR_ENV]
      else process.env[WATCH_STATE_DIR_ENV] = prevEnv
      await disposePlugin?.()
      rmSync(stateDir, { recursive: true, force: true })
    }
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

  test("prepare reply during parent version change does not arm challenge", async () => {
    let slowResolve: ((val: unknown) => void) | undefined
    const slowPromise = new Promise((resolve) => {
      slowResolve = resolve
    })

    const { fake, flow, setExpectedVersion, dispose } = setupFlow({
      delegation: () => slowPromise,
    })

    const prepPromise = flow.prepare("ses_child_001", "alert")
    expect(fake.delegationCalls).toHaveLength(1)

    // Parent task version advances while prepare RPC is in flight
    setExpectedVersion(4)

    slowResolve?.(
      delegationGrantPayload({
        challenge: delegationChallenge({ expectedVersion: 3 }),
      }),
    )

    const result = await prepPromise
    expect(result).toBeUndefined()

    // Confirm must NOT be armed
    await flow.confirm()
    expect(fake.delegationCalls).toHaveLength(1)
    dispose()
  })

  test("route change without opening panel fences late confirm from toasting", async () => {
    let slowConfirmResolve: ((val: unknown) => void) | undefined
    const slowConfirmPromise = new Promise((resolve) => {
      slowConfirmResolve = resolve
    })

    const { fake, flow, dispose } = setupFlow({
      delegation: async (req) => {
        if (req.operation === "prepare") {
          return delegationGrantPayload({ challenge: delegationChallenge() })
        }
        return slowConfirmPromise
      },
    })

    const prepared = await flow.prepare("ses_child_001", "alert")
    expect(prepared).toBeDefined()

    const confirmPromise = flow.confirm()
    expect(fake.delegationCalls.map((c) => c.operation)).toEqual(["prepare", "confirm"])

    // Route switches to another session before confirm response returns
    fake.setSession("ses_other_user")

    slowConfirmResolve?.(delegationGrantPayload({ ok: true }))
    await confirmPromise

    // Because route changed, confirm must NOT toast success or update state
    expect(fake.toasts).toEqual([])
    dispose()
  })

  test("feed fails closed and rejects payload for wrong parent task or session", async () => {
    const { fakePort, delegationViewPayload } = await import("./tui-watch-fake.ts")
    const { createWatchDelegationFeed } = await import("../src/tui/watch-delegation-feed.ts")

    const fake = fakePort({
      delegationView: async () =>
        delegationViewPayload({
          parentTaskID: "task_WRONG_PARENT", // Mismatched task ID
          parentSessionID: SELF,
        }),
    })

    const feed = createWatchDelegationFeed(fake.port.watchDelegation)
    feed.open(SELF, "task_EXPECTED_PARENT")

    // Allow read promise to settle
    await new Promise((r) => setTimeout(r, 10))

    const state = feed.state()
    expect(state.kind).toBe("failed")
    if (state.kind === "failed") {
      expect(state.reason).toContain("belonged to another task or session")
    }
    feed.dispose()
  })
})
