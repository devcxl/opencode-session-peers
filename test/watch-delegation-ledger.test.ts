/**
 * Delegation against the real SQLite ledger.
 *
 * The ledger is the authority for the controlled grant, the child link and the
 * derived correction grant. These tests use one real database file per case and
 * assert through the ledger's public methods plus the correction snapshot; they
 * do not seed tables or call internal helpers.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { WATCH_CORRECTION_TERMS, type WatchTaskRecord } from "../src/domain/watch.ts"
import { openWatchLedger, type WatchLedger } from "../src/watch/ledger.ts"

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
const describeLedger = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const CHILD_A = "ses_child-a"
const CHILD_B = "ses_child-b"
const DIRECTORY = "/tmp/opencode/delegation-project"
const SCOPE = "project-a"
const OWNER = "act-parent"

function open(clock: { value: number }): WatchLedger {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-delegation-ledger-"))
  scratch.push(directory)
  const opened = openWatchLedger({
    path: join(directory, "watch-ledger.sqlite3"),
    busyTimeoutMs: 2_000,
    openAttempts: 20,
    now: () => clock.value,
  })
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.detail}`)
  return opened.ledger
}

function enrollParent(ledger: WatchLedger, requestId = "parent-task"): WatchTaskRecord {
  const enrolled = ledger.enroll({
    requestId,
    initiatorSessionId: PARENT,
    targetSessionId: PARENT,
    goal: "Ship the parent task",
    mode: "alert",
    ownerActivation: OWNER,
  })
  if (!enrolled.ok) throw new Error(`${enrolled.code}: ${enrolled.detail}`)
  return enrolled.value.task
}

function grant(
  ledger: WatchLedger,
  parent: WatchTaskRecord,
  target: string,
  mode: "alert" | "limited-correction" = "limited-correction",
  clock = { value: 1_000 },
) {
  const prepared = ledger.prepareDelegationGrant({
    taskId: parent.taskID,
    callerSessionId: PARENT,
    ownerActivation: OWNER,
    expectedVersion: parent.version,
    targetSessionId: target,
    mode,
    scopeDirectory: DIRECTORY,
    scopePeerScope: SCOPE,
    ...(mode === "limited-correction" ? { deployment: "single-host-same-location" as const } : {}),
    at: clock.value,
  })
  if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.detail}`)
  const confirmed = ledger.confirmDelegationGrant({
    challenge: prepared.value.challenge,
    taskId: parent.taskID,
    callerSessionId: PARENT,
    ownerActivation: OWNER,
    expectedVersion: prepared.value.expectedVersion,
    generation: prepared.value.generation,
    targetSessionId: prepared.value.targetSessionID,
    mode: prepared.value.mode,
    scopeDirectory: prepared.value.scopeDirectory,
    scopePeerScope: prepared.value.scopePeerScope,
    termsDigest: prepared.value.termsDigest,
    ...(prepared.value.deployment === undefined ? {} : { deployment: prepared.value.deployment }),
    at: clock.value + 1,
  })
  if (!confirmed.ok) throw new Error(`${confirmed.code}: ${confirmed.detail}`)
  return confirmed.value
}

function enrollChild(
  ledger: WatchLedger,
  parent: WatchTaskRecord,
  confirmedGrant: { grantID: string; version: number },
  target: string,
  mode: "alert" | "limited-correction" = "limited-correction",
  requestId = `child-${target}`,
) {
  return ledger.delegatedEnroll({
    requestId,
    initiatorSessionId: PARENT,
    targetSessionId: target,
    parentTaskId: parent.taskID,
    goal: `Deliver ${target}`,
    mode,
    ownerActivation: OWNER,
    expectedVersion: parent.version,
    grantId: confirmedGrant.grantID,
    grantVersion: confirmedGrant.version,
    verifiedParentId: PARENT,
    verifiedDirectory: DIRECTORY,
    verifiedScope: SCOPE,
    verifiedScopeSource: "recorded",
  })
}

describeLedger("delegation ledger", () => {
  test("a limited delegation derives the child correction grant; an alert one does not", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const limited = grant(ledger, parent, CHILD_A).grant
      const childA = enrollChild(ledger, parent, limited, CHILD_A)
      expect(childA.ok).toBe(true)
      if (!childA.ok) return
      expect(childA.value.created).toBe(true)
      expect(childA.value.task).toMatchObject({
        initiatorSessionID: PARENT,
        targetSessionID: CHILD_A,
        mode: "limited-correction",
        watchState: "active",
        taskState: "not-started",
      })
      const correction = ledger.correction(childA.value.task.taskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.grant).toMatchObject({
        state: "granted",
        mode: "limited-correction",
        scopeTargetSessionID: CHILD_A,
        deployment: "single-host-same-location",
      })

      const alert = grant(ledger, parent, CHILD_B, "alert").grant
      const childB = enrollChild(ledger, parent, alert, CHILD_B, "alert")
      expect(childB.ok).toBe(true)
      if (!childB.ok) return
      expect(childB.value.task.mode).toBe("alert")
      const alertCorrection = ledger.correction(childB.value.task.taskID)
      expect(alertCorrection.ok).toBe(true)
      if (!alertCorrection.ok) return
      expect(alertCorrection.value.grant).toBeNull()
    } finally {
      ledger.close()
    }
  })

  test("two direct children have independent grants; revoking one leaves the other active", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const first = grant(ledger, parent, CHILD_A).grant
      const second = grant(ledger, parent, CHILD_B).grant
      expect(first.grantID).not.toBe(second.grantID)
      expect(enrollChild(ledger, parent, first, CHILD_A).ok).toBe(true)
      expect(enrollChild(ledger, parent, second, CHILD_B).ok).toBe(true)

      const revoked = ledger.revokeDelegationGrant({
        parentTaskId: parent.taskID,
        targetSessionId: CHILD_A,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        at: clock.value + 10,
      })
      expect(revoked.ok).toBe(true)
      if (!revoked.ok) return
      expect(revoked.value.changed).toBe(true)

      const stillActive = ledger.delegationGrantFor({ parentTaskID: parent.taskID, targetSessionID: CHILD_B })
      expect(stillActive.ok).toBe(true)
      if (!stillActive.ok) return
      expect(stillActive.value).toMatchObject({ grantID: second.grantID, state: "granted" })

      const revokedAgain = ledger.delegationGrantFor({ parentTaskID: parent.taskID, targetSessionID: CHILD_A })
      expect(revokedAgain.ok).toBe(true)
      if (!revokedAgain.ok) return
      expect(revokedAgain.value?.state).toBe("revoked")
    } finally {
      ledger.close()
    }
  })

  test("repeat delegation enrollment is idempotent; a changed request conflicts", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const first = enrollChild(ledger, parent, confirmed, CHILD_A, "limited-correction", "request-a")
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const repeat = enrollChild(ledger, parent, confirmed, CHILD_A, "limited-correction", "request-a")
      expect(repeat.ok).toBe(true)
      if (!repeat.ok) return
      expect(repeat.value.created).toBe(false)
      expect(repeat.value.task.taskID).toBe(first.value.task.taskID)

      const conflict = enrollChild(ledger, parent, confirmed, CHILD_A, "alert", "request-a")
      expect(conflict.ok).toBe(false)
      if (conflict.ok) return
      expect(conflict.code).toBe("request_conflict")
    } finally {
      ledger.close()
    }
  })

  test("a scope-provenance change is audit-only for the same enrollment request", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const first = ledger.delegatedEnroll({
        requestId: "provenance-request",
        initiatorSessionId: PARENT,
        targetSessionId: CHILD_A,
        parentTaskId: parent.taskID,
        goal: "Deliver the child",
        mode: "limited-correction",
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        grantId: confirmed.grantID,
        grantVersion: confirmed.version,
        verifiedParentId: PARENT,
        verifiedDirectory: DIRECTORY,
        verifiedScope: SCOPE,
        verifiedScopeSource: "configured",
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const repeat = ledger.delegatedEnroll({
        requestId: "provenance-request",
        initiatorSessionId: PARENT,
        targetSessionId: CHILD_A,
        parentTaskId: parent.taskID,
        goal: "Deliver the child",
        mode: "limited-correction",
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        grantId: confirmed.grantID,
        grantVersion: confirmed.version,
        verifiedParentId: PARENT,
        verifiedDirectory: DIRECTORY,
        verifiedScope: SCOPE,
        verifiedScopeSource: "recorded",
      })
      expect(repeat.ok).toBe(true)
      if (!repeat.ok) return
      expect(repeat.value.created).toBe(false)
      expect(repeat.value.task.taskID).toBe(first.value.task.taskID)
      expect(ledger.delegatedTaskLink(first.value.task.taskID)).toMatchObject({
        ok: true,
        value: { verifiedScopeSource: "configured" },
      })

      const conflict = ledger.delegatedEnroll({
        requestId: "provenance-request",
        initiatorSessionId: PARENT,
        targetSessionId: CHILD_A,
        parentTaskId: parent.taskID,
        goal: "A different goal",
        mode: "limited-correction",
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        grantId: confirmed.grantID,
        grantVersion: confirmed.version,
        verifiedParentId: PARENT,
        verifiedDirectory: DIRECTORY,
        verifiedScope: SCOPE,
        verifiedScopeSource: "recorded",
      })
      expect(conflict.ok).toBe(false)
      if (conflict.ok) return
      expect(conflict.code).toBe("request_conflict")
    } finally {
      ledger.close()
    }
  })

  test("a revoked source blocks a new enrollment and revokes the derived correction grant", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const child = enrollChild(ledger, parent, confirmed, CHILD_A)
      expect(child.ok).toBe(true)
      if (!child.ok) return

      const revoked = ledger.revokeDelegationGrant({
        parentTaskId: parent.taskID,
        targetSessionId: CHILD_A,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        at: clock.value + 10,
      })
      expect(revoked.ok).toBe(true)

      const next = enrollChild(ledger, parent, confirmed, CHILD_A, "limited-correction", "request-after-revoke")
      expect(next.ok).toBe(false)
      if (next.ok) return
      expect(next.code).toBe("not_granted")

      const correction = ledger.correction(child.value.task.taskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.grant?.state).toBe("revoked")
    } finally {
      ledger.close()
    }
  })

  test("a revoked source blocks reserve and claim, but keeps a prior attempt's unknown facts", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const child = enrollChild(ledger, parent, confirmed, CHILD_A)
      expect(child.ok).toBe(true)
      if (!child.ok) return
      const childTask = child.value.task
      const began = ledger.report({
        taskId: childTask.taskID,
        callerSessionId: CHILD_A,
        expectedVersion: childTask.version,
        reportId: "child-begin",
        kind: "begin",
        evidence: {},
      })
      expect(began.ok).toBe(true)
      if (!began.ok) return
      const reserved = ledger.reserveCorrection({
        taskId: childTask.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        generation: began.value.task.generation,
        reservationId: "reservation-a",
        at: clock.value + 5,
      })
      expect(reserved.ok).toBe(true)
      if (!reserved.ok) return

      const revoked = ledger.revokeDelegationGrant({
        parentTaskId: parent.taskID,
        targetSessionId: CHILD_A,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        at: clock.value + 10,
      })
      expect(revoked.ok).toBe(true)

      const claim = ledger.claimCorrection({
        taskId: childTask.taskID,
        reservationId: "reservation-a",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: childTask.generation,
        at: clock.value + 11,
      })
      expect(claim.ok).toBe(false)
      if (claim.ok) return
      expect(claim.code).toBe("not_granted")

      const correction = ledger.correction(childTask.taskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts).toHaveLength(1)
      expect(correction.value.attempts[0]).toMatchObject({ phase: "reserved" })
    } finally {
      ledger.close()
    }
  })

  test("a revoke preserves accepted and unknown delivery facts", () => {
    for (const outcome of ["accepted", "unknown"] as const) {
      const clock = { value: 1_000 }
      const ledger = open(clock)
      try {
        const parent = enrollParent(ledger)
        const confirmed = grant(ledger, parent, CHILD_A).grant
        const child = enrollChild(ledger, parent, confirmed, CHILD_A)
        if (!child.ok) throw new Error(child.code)
        const began = ledger.report({
          taskId: child.value.task.taskID,
          callerSessionId: CHILD_A,
          expectedVersion: child.value.task.version,
          reportId: `outcome-begin-${outcome}`,
          kind: "begin",
          evidence: {},
        })
        if (!began.ok) throw new Error(began.code)
        const reservationID = `outcome-reservation-${outcome}`
        const reserved = ledger.reserveCorrection({
          taskId: child.value.task.taskID,
          callerSessionId: PARENT,
          ownerActivation: OWNER,
          expectedVersion: began.value.task.version,
          generation: child.value.task.generation,
          reservationId: reservationID,
          at: clock.value + 5,
        })
        if (!reserved.ok) throw new Error(reserved.code)
        const claimed = ledger.claimCorrection({
          taskId: child.value.task.taskID,
          reservationId: reservationID,
          ownerActivation: OWNER,
          expectedVersion: reserved.value.task.version,
          generation: child.value.task.generation,
          at: clock.value + 6,
        })
        if (!claimed.ok) throw new Error(claimed.code)
        const recorded = ledger.recordCorrectionOutcome({
          taskId: child.value.task.taskID,
          reservationId: reservationID,
          ownerActivation: OWNER,
          outcome,
          ...(outcome === "accepted" ? { admissionID: `admission-${outcome}` } : {}),
          at: clock.value + 7,
        })
        if (!recorded.ok) throw new Error(recorded.code)

        const revoked = ledger.revokeDelegationGrant({
          parentTaskId: parent.taskID,
          targetSessionId: CHILD_A,
          callerSessionId: PARENT,
          ownerActivation: OWNER,
          expectedVersion: parent.version,
          at: clock.value + 8,
        })
        expect(revoked.ok).toBe(true)
        const correction = ledger.correction(child.value.task.taskID)
        expect(correction.ok).toBe(true)
        if (!correction.ok) return
        expect(correction.value.attempts[0]).toMatchObject(
          outcome === "accepted"
            ? { phase: "accepted", admissionID: "admission-accepted" }
            : { phase: "unknown" },
        )
      } finally {
        ledger.close()
      }
    }
  })

  test("a parent pause between claim and receipt records seen but no permit", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const child = enrollChild(ledger, parent, confirmed, CHILD_A)
      expect(child.ok).toBe(true)
      if (!child.ok) return
      const childTask = child.value.task
      const began = ledger.report({
        taskId: childTask.taskID,
        callerSessionId: CHILD_A,
        expectedVersion: childTask.version,
        reportId: "child-begin",
        kind: "begin",
        evidence: {},
      })
      expect(began.ok).toBe(true)
      if (!began.ok) return
      const reserved = ledger.reserveCorrection({
        taskId: childTask.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        generation: began.value.task.generation,
        reservationId: "reservation-b",
        at: clock.value + 5,
      })
      expect(reserved.ok).toBe(true)
      if (!reserved.ok) return
      const claimed = ledger.claimCorrection({
        taskId: childTask.taskID,
        reservationId: "reservation-b",
        ownerActivation: OWNER,
        expectedVersion: reserved.value.task.version,
        generation: childTask.generation,
        at: clock.value + 6,
      })
      expect(claimed.ok).toBe(true)
      if (!claimed.ok) return

      const paused = ledger.control({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        expectedVersion: parent.version,
        operation: "pause",
      })
      expect(paused.ok).toBe(true)

      const receipt = ledger.recordCorrectionReceipt({
        taskId: childTask.taskID,
        reservationId: "reservation-b",
        callerSessionId: CHILD_A,
        currentActivationId: OWNER,
        correlation: claimed.value.correlation,
        at: clock.value + 7,
      })
      expect(receipt.ok).toBe(true)
      if (!receipt.ok) return
      expect(receipt.value).toMatchObject({
        continuePermit: false,
        seen: true,
        refusalReason: "delegation-changed",
      })
    } finally {
      ledger.close()
    }
  })

  test("only a self-enrolled parent may delegate; a delegated task cannot delegate again", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const child = enrollChild(ledger, parent, confirmed, CHILD_A)
      expect(child.ok).toBe(true)
      if (!child.ok) return

      const recursive = ledger.prepareDelegationGrant({
        taskId: child.value.task.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: child.value.task.version,
        targetSessionId: "ses_grandchild",
        mode: "alert",
        scopeDirectory: DIRECTORY,
        scopePeerScope: SCOPE,
        at: clock.value + 10,
      })
      expect(recursive.ok).toBe(false)
      if (recursive.ok) return
      expect(recursive.code).toBe("invalid_transition")
    } finally {
      ledger.close()
    }
  })

  test("a delegated task cannot replace its derived grant through the correction grant path", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = enrollParent(ledger)
      const confirmed = grant(ledger, parent, CHILD_A).grant
      const child = enrollChild(ledger, parent, confirmed, CHILD_A)
      expect(child.ok).toBe(true)
      if (!child.ok) return
      const began = ledger.report({
        taskId: child.value.task.taskID,
        callerSessionId: CHILD_A,
        expectedVersion: child.value.task.version,
        reportId: "child-begin",
        kind: "begin",
        evidence: {},
      })
      expect(began.ok).toBe(true)
      if (!began.ok) return
      const prepared = ledger.prepareCorrectionGrant({
        taskId: child.value.task.taskID,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: began.value.task.version,
        reviewSummary: WATCH_CORRECTION_TERMS,
        deployment: "single-host-same-location",
        at: clock.value + 10,
      })
      expect(prepared.ok).toBe(false)
      if (prepared.ok) return
      expect(prepared.code).toBe("not_granted")
    } finally {
      ledger.close()
    }
  })
})
