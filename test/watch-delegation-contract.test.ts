/**
 * The controlled delegation contract readers and strict request parsing.
 *
 * The nonce, digest and confirmation id belong to the prepare/confirm exchange;
 * a normal child view must not contain them. The readers reject extra fields
 * rather than letting a caller smuggle `userConsent` or `checked` into a
 * controlled decision.
 */

import { describe, expect, test } from "bun:test"

import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import {
  readWatchDelegationGrantPayload,
  readWatchDelegationViewPayload,
} from "../src/watch/delegation-contract.ts"
import { WATCH_DELEGATION_TERMS } from "../src/watch/delegation.ts"
import { watchDelegationRpc, watchDelegationViewRpc } from "../src/actions/watch-delegation-rpc.ts"

const review = {
  delegationTerms: WATCH_DELEGATION_TERMS,
  correctionTerms: WATCH_CORRECTION_TERMS,
  deploymentRequired: true,
  derivesCorrectionGrant: true,
}

const task = {
  taskID: "task-child",
  initiatorSessionID: "ses_parent",
  targetSessionID: "ses_child",
  goal: "Deliver the child work",
  mode: "limited-correction",
  watchState: "active",
  taskState: "not-started",
  version: 1,
  generation: 1,
  ownership: "this-instance",
  participation: "not-seen",
  attempts: { used: 0, limit: 3 },
  correction: { actual: "unavailable" },
  pause: null,
  lastReport: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  completedAt: null,
  endedAt: null,
}

const challenge = {
  challenge: "opaque-nonce",
  parentTaskID: "task-parent",
  expectedVersion: 1,
  generation: 1,
  mode: "limited-correction",
  targetSessionID: "ses_child",
  scopeDirectory: "/tmp/opencode/project",
  scopePeerScope: "project-a",
  deployment: "single-host-same-location",
  termsDigest: "digest",
  reviewSummary: WATCH_DELEGATION_TERMS,
  expiresAt: 2_000,
}

const grant = {
  grantID: "delegation-1",
  parentTaskID: "task-parent",
  parentSessionID: "ses_parent",
  mode: "limited-correction",
  state: "granted",
  version: 1,
  generation: 1,
  targetSessionID: "ses_child",
  scopeDirectory: "/tmp/opencode/project",
  scopePeerScope: "project-a",
  reviewSummary: WATCH_DELEGATION_TERMS,
  deployment: "single-host-same-location",
  grantedAt: 1_500,
  revokedAt: null,
}

function preparePayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    challenge,
    grant: null,
    task,
    capability: { mode: "limited-correction", monitoring: "observer-alerts" },
    controls: { pause: { enabled: true, reason: null } },
    review,
    failure: null,
    ...overrides,
  }
}

function viewPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    parentTaskID: "task-parent",
    parentSessionID: "ses_parent",
    grants: [grant],
    children: [
      {
        taskID: "task-child",
        parentTaskID: "task-parent",
        parentSessionID: "ses_parent",
        targetSessionID: "ses_child",
        authorized: true,
        authorization: {
          allowed: true,
          reason: null,
          grantID: "delegation-1",
          grantVersion: 1,
          mode: "limited-correction",
          scopeDirectory: "/tmp/opencode/project",
          scopePeerScope: "project-a",
          scopeSource: "recorded",
          checkedAt: 1_800,
        },
        task,
        alerts: null,
      },
    ],
    failure: null,
    ...overrides,
  }
}

const dummySessions = {
  async get() {
    throw new Error("not used")
  },
  async prompt() {
    throw new Error("not used")
  },
  async toolCalls() {
    return []
  },
}

describe("delegation contract readers", () => {
  test("accepts a prepare payload and a normal child view", () => {
    expect(readWatchDelegationGrantPayload(preparePayload())).toMatchObject({
      ok: true,
      challenge: { challenge: "opaque-nonce", reviewSummary: WATCH_DELEGATION_TERMS },
      review,
    })
    const view = readWatchDelegationViewPayload(viewPayload())
    expect(view).toMatchObject({
      ok: true,
      parentTaskID: "task-parent",
      children: [{ taskID: "task-child", authorized: true }],
    })
  })

  test("rejects a caller-inserted consent/checked flag and a smuggled nonce", () => {
    expect(readWatchDelegationGrantPayload(preparePayload({ userConsent: true }))).toBeUndefined()
    expect(
      readWatchDelegationGrantPayload(preparePayload({ challenge: { ...challenge, checked: true } })),
    ).toBeUndefined()
    expect(
      readWatchDelegationGrantPayload(preparePayload({ challenge: { ...challenge, confirmationID: "x" } })),
    ).toBeUndefined()
  })

  test("rejects a truncated or reworded terms review", () => {
    expect(
      readWatchDelegationGrantPayload(preparePayload({ review: { ...review, delegationTerms: "short" } })),
    ).toBeUndefined()
    expect(
      readWatchDelegationGrantPayload(preparePayload({ review: { ...review, correctionTerms: "short" } })),
    ).toBeUndefined()
  })

  test("an unauthorized child cannot hide a task or alerts in the view", () => {
    const child = viewPayload().children[0]!
    const leaking = viewPayload({
      children: [
        {
          ...child,
          authorized: false,
          authorization: { ...child.authorization, allowed: false, reason: "revoked" },
        },
      ],
    })
    expect(readWatchDelegationViewPayload(leaking)).toBeUndefined()

    const safe = viewPayload({
      children: [
        {
          ...child,
          authorized: false,
          authorization: { ...child.authorization, allowed: false, reason: "revoked" },
          task: null,
          alerts: null,
        },
      ],
    })
    const view = readWatchDelegationViewPayload(safe)
    expect(view?.children[0]?.task).toBeNull()
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain("opaque-nonce")
    expect(serialized).not.toContain("termsDigest")
    expect(serialized).not.toContain("confirmationID")
    expect(serialized).not.toContain("Deliver the child work")
  })

  test("the view reader rejects an extra challenge field", () => {
    expect(readWatchDelegationViewPayload(viewPayload({ challenge }))).toBeUndefined()
  })
})

describe("delegation RPC parsing", () => {
  const deps = { enabled: false, sessions: dummySessions, directory: "/tmp" }

  test("rejects a model-supplied consent/consumed/stopProof field on prepare", async () => {
    const result = await watchDelegationRpc(deps, {
      operation: "prepare",
      sessionID: "ses_parent",
      parentTaskID: "task-parent",
      expectedVersion: 1,
      targetSessionID: "ses_child",
      mode: "alert",
      confirm: true,
    })
    expect(result).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
  })

  test("rejects unknown view fields and reports disabled after valid parsing", async () => {
    expect(
      await watchDelegationViewRpc(deps, {
        sessionID: "ses_parent",
        parentTaskID: "task-parent",
        checked: true,
      }),
    ).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })

    await expect(
      watchDelegationViewRpc(deps, { sessionID: "ses_parent", parentTaskID: "task-parent" }),
    ).resolves.toMatchObject({ ok: false, failure: { code: "E_WATCH_DISABLED" } })
  })

  test("a limited prepare needs the explicit deployment declaration", async () => {
    const result = await watchDelegationRpc(deps, {
      operation: "prepare",
      sessionID: "ses_parent",
      parentTaskID: "task-parent",
      expectedVersion: 1,
      targetSessionID: "ses_child",
      mode: "limited-correction",
    })
    expect(result).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
  })

  test("revoke does not require a mode or deployment", async () => {
    const result = await watchDelegationRpc(deps, {
      operation: "revoke",
      sessionID: "ses_parent",
      parentTaskID: "task-parent",
      expectedVersion: 1,
      targetSessionID: "ses_child",
    })
    expect(result).toMatchObject({ ok: false, failure: { code: "E_WATCH_DISABLED" } })

    await expect(
      watchDelegationRpc(deps, {
        operation: "revoke",
        sessionID: "ses_parent",
        parentTaskID: "task-parent",
        expectedVersion: 1,
        targetSessionID: "ses_child",
        mode: "alert",
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
  })
})
