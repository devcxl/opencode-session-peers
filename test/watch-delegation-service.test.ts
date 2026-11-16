/**
 * The delegation application through its service methods, with a real ledger.
 *
 * The model-facing action and the controlled RPC are parent wiring; these tests
 * exercise the application so the security-critical behavior is pinned before
 * that wiring: only a fresh direct-parent/scope fact enrolls a child, a parent
 * cannot read a delegated child as an ordinary task, and a receipt after a
 * revoke records "seen" without a continue permit.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionLookup, SessionRecord } from "../src/host/session.ts"
import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import { openWatchLedger, type WatchLedger } from "../src/watch/ledger.ts"
import { createDelegationAuthority, type ScopeFact } from "../src/watch/delegation-authority.ts"
import { createWatchApplication, type WatchApplication } from "../src/watch/service.ts"

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
const describeService = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DIRECTORY = "/tmp/opencode/delegation-service"
const SCOPE = "project-a"
const OWNER = "act-parent"

interface Harness {
  readonly app: WatchApplication
  readonly ledger: WatchLedger
  readonly sessions: Map<string, SessionRecord>
  readonly scopes: Map<string, ScopeFact | null>
  readonly clock: { value: number }
  readonly close: () => void
}

function harness(options: { readonly withAuthority: boolean }): Harness {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-delegation-service-"))
  scratch.push(directory)
  const path = join(directory, "watch-ledger.sqlite3")
  const clock = { value: 1_000 }
  const opened = openWatchLedger({ path, busyTimeoutMs: 2_000, openAttempts: 20, now: () => clock.value })
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.detail}`)
  const ledger = opened.ledger
  const sessions = new Map<string, SessionRecord>([
    [PARENT, { id: PARENT, directory: DIRECTORY, projectID: "proj" }],
    [CHILD, { id: CHILD, parentID: PARENT, directory: DIRECTORY, projectID: "proj" }],
  ])
  const scopes = new Map<string, ScopeFact | null>([
    [PARENT, { scope: SCOPE, source: "recorded" }],
    [CHILD, { scope: SCOPE, source: "recorded" }],
  ])
  const sessionsLookup: SessionLookup = {
    async get(sessionID) {
      const session = sessions.get(sessionID)
      if (session === undefined) throw new Error("Session.NotFoundError")
      return session
    },
    async prompt() {
      throw new Error("the watch application must not prompt")
    },
    async toolCalls() {
      throw new Error("the watch application must not read a transcript")
    },
  }
  const authority = options.withAuthority
    ? createDelegationAuthority({
        ledger,
        sessions: sessionsLookup,
        scopeOf: async (sessionID) => scopes.get(sessionID) ?? null,
        activationID: OWNER,
        closing: () => false,
        now: () => clock.value,
      })
    : undefined
  const app = createWatchApplication({
    ledgerPath: path,
    activationID: OWNER,
    runtime: { appName: "opencode", appVersion: "2.3.0", platform: "linux", arch: "x64" },
    now: () => clock.value,
    ...(authority === undefined ? {} : { delegation: authority }),
  })
  return {
    app,
    ledger,
    sessions,
    scopes,
    clock,
    close() {
      app.dispose()
      ledger.close()
    },
  }
}

function enrollParent(app: WatchApplication, requestID = "parent"): { taskID: string; version: number } {
  const enrolled = app.enroll({
    callerSessionID: PARENT,
    requestID,
    goal: "Ship the parent task",
  })
  if (!enrolled.ok || enrolled.task === null) throw new Error(JSON.stringify(enrolled.failure))
  return { taskID: enrolled.task.taskID, version: enrolled.task.version }
}

async function prepareAndConfirm(app: WatchApplication, parentTaskID: string, version: number) {
  const prepared = await app.prepareDelegationGrant({
    callerSessionID: PARENT,
    parentTaskID,
    expectedVersion: version,
    targetSessionID: CHILD,
    mode: "limited-correction",
    deployment: "single-host-same-location",
  })
  if (!prepared.ok || prepared.challenge === null) throw new Error(JSON.stringify(prepared.failure))
  const confirmed = await app.confirmDelegationGrant({
    callerSessionID: PARENT,
    parentTaskID,
    expectedVersion: prepared.challenge.expectedVersion,
    generation: prepared.challenge.generation,
    targetSessionID: CHILD,
    mode: prepared.challenge.mode,
    scopeDirectory: prepared.challenge.scopeDirectory,
    scopePeerScope: prepared.challenge.scopePeerScope,
    termsDigest: prepared.challenge.termsDigest,
    challenge: prepared.challenge.challenge,
    deployment: "single-host-same-location",
  })
  if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.failure))
  return { prepared, confirmed }
}

async function enrollChild(app: WatchApplication, parentTaskID: string, version: number) {
  const enrolled = await app.delegate({
    callerSessionID: PARENT,
    parentTaskID,
    targetSessionID: CHILD,
    requestID: "child-1",
    goal: "Deliver the child work",
    mode: "limited-correction",
    expectedVersion: version,
  })
  if (!enrolled.ok || enrolled.task === null) throw new Error(JSON.stringify(enrolled.failure))
  return enrolled.task
}

describeService("delegation application", () => {
  test("prepare, confirm, delegate, read, revoke", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      const { prepared } = await prepareAndConfirm(h.app, parent.taskID, parent.version)
      expect(prepared.review).toMatchObject({
        delegationTerms: expect.stringContaining("direct child"),
        correctionTerms: WATCH_CORRECTION_TERMS,
        deploymentRequired: true,
      })
      expect(prepared.challenge).not.toBeNull()

      const child = await enrollChild(h.app, parent.taskID, parent.version)
      expect(child).toMatchObject({
        initiatorSessionID: PARENT,
        targetSessionID: CHILD,
        mode: "limited-correction",
        ownership: "this-instance",
      })

      const childShow = h.app.show({ sessionID: PARENT, taskID: child.taskID })
      expect(childShow.ok).toBe(false)
      expect(childShow.failure?.code).toBe("E_WATCH_UNSUPPORTED")

      const view = await h.app.delegationView({ sessionID: PARENT, parentTaskID: parent.taskID })
      expect(view.ok).toBe(true)
      expect(view.grants).toHaveLength(1)
      expect(view.children).toHaveLength(1)
      expect(view.children[0]).toMatchObject({
        taskID: child.taskID,
        targetSessionID: CHILD,
        authorized: true,
        authorization: { mode: "limited-correction", scopeDirectory: DIRECTORY, scopePeerScope: SCOPE },
        task: { goal: "Deliver the child work", taskState: "not-started" },
      })

      const revoked = await h.app.revokeDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        expectedVersion: parent.version,
      })
      expect(revoked.ok).toBe(true)
      expect(revoked.grant).toMatchObject({ state: "revoked", targetSessionID: CHILD })

      const after = await h.app.delegationView({ sessionID: PARENT, parentTaskID: parent.taskID })
      expect(after.children[0]).toMatchObject({
        authorized: false,
        task: null,
        alerts: null,
      })
      expect(JSON.stringify(after.children[0])).not.toContain("Deliver the child work")
      expect((await h.app.checkDelegatedAuthority(child.taskID)).allowed).toBe(false)
    } finally {
      h.close()
    }
  })

  test("a wrong host parent or a changed scope is refused before any child task exists", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      const wrong = h.sessions.get(CHILD)
      if (wrong !== undefined) h.sessions.set(CHILD, { ...wrong, parentID: "ses_other" })
      const refused = await h.app.prepareDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        expectedVersion: parent.version,
        targetSessionID: CHILD,
        mode: "alert",
      })
      expect(refused.ok).toBe(false)
      expect(refused.failure?.code).toBe("E_WATCH_CALLER_MISMATCH")

      if (wrong !== undefined) h.sessions.set(CHILD, wrong)
      h.scopes.set(CHILD, { scope: "project-b", source: "recorded" })
      const crossScope = await h.app.prepareDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        expectedVersion: parent.version,
        targetSessionID: CHILD,
        mode: "alert",
      })
      expect(crossScope.ok).toBe(false)
      expect(crossScope.failure?.code).toBe("E_WATCH_UNSUPPORTED")
    } finally {
      h.close()
    }
  })

  test("delegate after revoke is refused and no child task is created", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const revoked = await h.app.revokeDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        expectedVersion: parent.version,
      })
      expect(revoked.ok).toBe(true)
      const enrolled = await h.app.delegate({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        requestID: "child-after-revoke",
        goal: "Deliver after revoke",
        mode: "alert",
        expectedVersion: parent.version,
      })
      expect(enrolled.ok).toBe(false)
      expect(enrolled.failure?.code).toBe("E_WATCH_UNSUPPORTED")
      expect(await h.app.delegationView({ sessionID: PARENT, parentTaskID: parent.taskID })).toMatchObject({
        children: [],
      })
    } finally {
      h.close()
    }
  })

  test("show without a task id returns the parent's own task, not a delegated child", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      await enrollChild(h.app, parent.taskID, parent.version)
      const shown = h.app.show({ sessionID: PARENT })
      expect(shown.ok).toBe(true)
      expect(shown.task).toMatchObject({ taskID: parent.taskID, goal: "Ship the parent task", targetSessionID: PARENT })
    } finally {
      h.close()
    }
  })

  test("a repeat delegation request after completion returns the same task without a new wake", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      let version = child.version
      for (const [kind, reportId, evidence] of [
        ["begin", "repeat-begin", {}],
        ["progress", "repeat-progress", { summary: "done", reference: "result-1" }],
        ["completed", "repeat-completed", { summary: "finished", reference: "result-2" }],
      ] as const) {
        const report = h.app.report({
          callerSessionID: CHILD,
          taskID: child.taskID,
          expectedVersion: version,
          reportID: reportId,
          kind,
          evidence,
        })
        if (!report.ok || report.task === null) throw new Error("report failed")
        version = report.task.version
      }
      const repeat = await h.app.delegate({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        requestID: "child-1",
        goal: "Deliver the child work",
        mode: "limited-correction",
        expectedVersion: parent.version,
      })
      expect(repeat.ok).toBe(true)
      expect(repeat.created).toBe(false)
      expect(repeat.task).toMatchObject({ taskID: child.taskID, taskState: "completed", watchState: "ended" })
    } finally {
      h.close()
    }
  })

  test("the parent cannot report or receipt as the child", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      const report = h.app.report({
        callerSessionID: PARENT,
        taskID: child.taskID,
        expectedVersion: child.version,
        reportID: "parent-as-child",
        kind: "begin",
        evidence: {},
      })
      expect(report.ok).toBe(false)
      expect(report.failure?.code).toBe("E_WATCH_CALLER_MISMATCH")
    } finally {
      h.close()
    }
  })

  test("control on a delegated child does not return its content", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      await h.app.revokeDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        expectedVersion: parent.version,
      })
      const controlled = h.app.control({
        callerSessionID: PARENT,
        taskID: child.taskID,
        expectedVersion: child.version,
        operation: "pause",
      })
      expect(controlled.ok).toBe(true)
      expect(controlled.task).toBeNull()
      expect(JSON.stringify(controlled)).not.toContain("Deliver the child work")
      expect(JSON.stringify(controlled)).not.toContain("Ship the parent task")
    } finally {
      h.close()
    }
  })

  test("a receipt after revoke is recorded as seen with no permit", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      const began = h.ledger.report({
        taskId: child.taskID,
        callerSessionId: CHILD,
        expectedVersion: child.version,
        reportId: "child-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) throw new Error(began.code)
      const reserved = h.ledger.reserveCorrection({
        taskId: child.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        generation: began.value.task.generation,
        reservationId: "receipt-reservation",
        at: 2_000,
      })
      if (!reserved.ok) throw new Error(reserved.code)
      const claimed = h.ledger.claimCorrection({
        taskId: child.taskID,
        reservationId: "receipt-reservation",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: child.generation,
        at: 2_001,
      })
      if (!claimed.ok) throw new Error(claimed.code)

      const revoked = await h.app.revokeDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID: parent.taskID,
        targetSessionID: CHILD,
        expectedVersion: parent.version,
      })
      expect(revoked.ok).toBe(true)
      h.clock.value = 2_100

      const receipt = await h.app.receipt({
        callerSessionID: CHILD,
        taskID: child.taskID,
        attemptID: "receipt-reservation",
        correlation: claimed.value.correlation,
      })
      expect(receipt.ok).toBe(true)
      expect(receipt).toMatchObject({ continuePermit: false, seen: true })
      expect(receipt.refusalReason).toStartWith("delegation-")
    } finally {
      h.close()
    }
  })

  test("a completed child remains readable as completed while the grant is active", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      let version = child.version
      for (const [kind, reportId, evidence] of [
        ["begin", "completed-begin", {}],
        ["progress", "completed-progress", { summary: "done the step", reference: "result-1" }],
        ["completed", "completed-final", { summary: "finished", reference: "result-2" }],
      ] as const) {
        const report = h.app.report({
          callerSessionID: CHILD,
          taskID: child.taskID,
          expectedVersion: version,
          reportID: reportId,
          kind,
          evidence,
        })
        expect(report.ok).toBe(true)
        if (!report.ok || report.task === null) throw new Error("report failed")
        version = report.task.version
      }
      const view = await h.app.delegationView({ sessionID: PARENT, parentTaskID: parent.taskID })
      expect(view.children[0]).toMatchObject({
        authorized: true,
        task: { taskState: "completed", watchState: "ended" },
      })
    } finally {
      h.close()
    }
  })

  test("a scope change with no panel read hides the child and refuses a receipt", async () => {
    const h = harness({ withAuthority: true })
    try {
      const parent = enrollParent(h.app)
      await prepareAndConfirm(h.app, parent.taskID, parent.version)
      const child = await enrollChild(h.app, parent.taskID, parent.version)
      const began = h.ledger.report({
        taskId: child.taskID,
        callerSessionId: CHILD,
        expectedVersion: child.version,
        reportId: "scope-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) throw new Error(began.code)
      const reserved = h.ledger.reserveCorrection({
        taskId: child.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        generation: child.generation,
        reservationId: "scope-reservation",
        at: 2_000,
      })
      if (!reserved.ok) throw new Error(reserved.code)
      const claimed = h.ledger.claimCorrection({
        taskId: child.taskID,
        reservationId: "scope-reservation",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: child.generation,
        at: 2_001,
      })
      if (!claimed.ok) throw new Error(claimed.code)

      h.scopes.set(CHILD, { scope: "project-b", source: "recorded" })
      h.clock.value = 2_100
      const view = await h.app.delegationView({ sessionID: PARENT, parentTaskID: parent.taskID })
      expect(view.children[0]).toMatchObject({ authorized: false, task: null, alerts: null })
      expect(JSON.stringify(view.children[0])).not.toContain("Deliver the child work")

      const receipt = await h.app.receipt({
        callerSessionID: CHILD,
        taskID: child.taskID,
        attemptID: "scope-reservation",
        correlation: claimed.value.correlation,
      })
      expect(receipt.ok).toBe(true)
      expect(receipt.continuePermit).toBe(false)
      expect(receipt.refusalReason).toContain("delegation-")
    } finally {
      h.close()
    }
  })

  test("a delegated task without a wired authority guard records seen but no permit", async () => {
    const h = harness({ withAuthority: false })
    try {
      const parent = enrollParent(h.app)
      // Seed the controlled facts directly; the application has no authority.
      const prepared = h.ledger.prepareDelegationGrant({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        targetSessionId: CHILD,
        mode: "limited-correction",
        scopeDirectory: DIRECTORY,
        scopePeerScope: SCOPE,
        deployment: "single-host-same-location",
        at: 2_000,
      })
      if (!prepared.ok) throw new Error(prepared.code)
      const confirmed = h.ledger.confirmDelegationGrant({
        challenge: prepared.value.challenge,
        taskId: parent.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: prepared.value.expectedVersion,
        generation: prepared.value.generation,
        targetSessionId: CHILD,
        mode: prepared.value.mode,
        scopeDirectory: prepared.value.scopeDirectory,
        scopePeerScope: prepared.value.scopePeerScope,
        termsDigest: prepared.value.termsDigest,
        deployment: "single-host-same-location",
        at: 2_001,
      })
      if (!confirmed.ok) throw new Error(confirmed.code)
      const child = h.ledger.delegatedEnroll({
        requestId: "child-no-guard",
        initiatorSessionId: PARENT,
        targetSessionId: CHILD,
        parentTaskId: parent.taskID,
        goal: "Deliver without a guard",
        mode: "limited-correction",
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        grantId: confirmed.value.grant.grantID,
        grantVersion: confirmed.value.grant.version,
        verifiedParentId: PARENT,
        verifiedDirectory: DIRECTORY,
        verifiedScope: SCOPE,
        verifiedScopeSource: "recorded",
      })
      if (!child.ok) throw new Error(child.code)
      const began = h.ledger.report({
        taskId: child.value.task.taskID,
        callerSessionId: CHILD,
        expectedVersion: child.value.task.version,
        reportId: "no-guard-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) throw new Error(began.code)
      const reserved = h.ledger.reserveCorrection({
        taskId: child.value.task.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        generation: began.value.task.generation,
        reservationId: "no-guard-reservation",
        at: 2_010,
      })
      if (!reserved.ok) throw new Error(reserved.code)
      const claimed = h.ledger.claimCorrection({
        taskId: child.value.task.taskID,
        reservationId: "no-guard-reservation",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: child.value.task.generation,
        at: 2_011,
      })
      if (!claimed.ok) throw new Error(claimed.code)
      h.clock.value = 2_100

      const receipt = await h.app.receipt({
        callerSessionID: CHILD,
        taskID: child.value.task.taskID,
        attemptID: "no-guard-reservation",
        correlation: claimed.value.correlation,
      })
      expect(receipt.ok).toBe(true)
      expect(receipt).toMatchObject({ continuePermit: false, seen: true })
      expect(receipt.refusalReason).toContain("delegation-")
    } finally {
      h.close()
    }
  })

  test("a self task receipt still issues a permit without any delegation authority", async () => {
    const h = harness({ withAuthority: false })
    try {
      const parent = enrollParent(h.app)
      const began = h.ledger.report({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        expectedVersion: parent.version,
        reportId: "self-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) throw new Error(began.code)
      const prepared = h.ledger.prepareCorrectionGrant({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        reviewSummary: WATCH_CORRECTION_TERMS,
        deployment: "single-host-same-location",
        at: 2_000,
      })
      if (!prepared.ok) throw new Error(prepared.code)
      const confirmed = h.ledger.confirmCorrectionGrant({
        challenge: prepared.value.challenge,
        taskId: parent.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: prepared.value.expectedVersion,
        generation: prepared.value.generation,
        termsDigest: prepared.value.termsDigest,
        deployment: "single-host-same-location",
        at: 2_001,
      })
      if (!confirmed.ok) throw new Error(confirmed.code)
      const reserved = h.ledger.reserveCorrection({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: confirmed.value.task.version,
        generation: confirmed.value.task.generation,
        reservationId: "self-reservation",
        at: 2_002,
      })
      if (!reserved.ok) throw new Error(reserved.code)
      const claimed = h.ledger.claimCorrection({
        taskId: parent.taskID,
        reservationId: "self-reservation",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: confirmed.value.task.generation,
        at: 2_003,
      })
      if (!claimed.ok) throw new Error(claimed.code)
      h.clock.value = 2_100
      const receipt = await h.app.receipt({
        callerSessionID: PARENT,
        taskID: parent.taskID,
        attemptID: "self-reservation",
        correlation: claimed.value.correlation,
      })
      expect(receipt.ok).toBe(true)
      expect(receipt.continuePermit).toBe(true)
    } finally {
      h.close()
    }
  })
})
