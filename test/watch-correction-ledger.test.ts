/**
 * The correction ledger as the authority for permanent attempts.
 *
 * These tests use the real SQLite ledger, not a mock: ordinal uniqueness,
 * one pending attempt, single claim, receipts and recovery are constraints and
 * conditional writes. Controlled `now` makes the windows deterministic.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import {
  openWatchLedger,
  WATCH_LEDGER_SCHEMA_VERSION,
  type WatchLedger,
} from "../src/watch/ledger.ts"
import {
  WATCH_CORRECTION_TERMS,
  type WatchCorrectionAttemptRecord,
  type WatchCorrectionGrantRecord,
} from "../src/domain/watch.ts"

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
const describeCorrection = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Clock {
  value: number
}

function open(clock: Clock, directory = mkdtempSync(join(tmpdir(), "session-peers-correction-"))): WatchLedger {
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

function enroll(ledger: WatchLedger, session = "ses_a", requestId = "req-a", owner = "activation-a") {
  const result = ledger.enroll({
    requestId,
    initiatorSessionId: session,
    targetSessionId: session,
    goal: "ship the correction contract",
    mode: "alert",
    ownerActivation: owner,
  })
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  return result.value.task
}

function grant(
  ledger: WatchLedger,
  taskID: string,
  version: number,
  clock: Clock,
  caller = "ses_a",
  owner = "activation-a",
): { readonly grant: WatchCorrectionGrantRecord; readonly task: ReturnType<typeof enroll> } {
  const shown = ledger.show({ taskID, sessionID: caller })
  if (!shown.ok || shown.value === null) throw new Error(shown.ok ? "task missing" : shown.code)
  let currentVersion = version
  if (shown.value.lastReport === undefined) {
    const reported = ledger.report({
      taskId: taskID,
      callerSessionId: caller,
      expectedVersion: shown.value.version,
      reportId: "participation",
      kind: "begin",
      evidence: {},
    })
    if (!reported.ok) throw new Error(`${reported.code}: ${reported.detail}`)
    currentVersion = reported.value.task.version
  }
  const prepared = ledger.prepareCorrectionGrant({
    taskId: taskID,
    callerSessionId: caller,
    ownerActivation: owner,
    expectedVersion: currentVersion,
    reviewSummary: WATCH_CORRECTION_TERMS,
    deployment: "single-host-same-location",
    at: clock.value,
  })
  if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.detail}`)
  const confirmed = ledger.confirmCorrectionGrant({
    challenge: prepared.value.challenge,
    taskId: taskID,
    callerSessionId: caller,
    ownerActivation: owner,
    expectedVersion: prepared.value.expectedVersion,
    generation: prepared.value.generation,
    termsDigest: prepared.value.termsDigest,
    deployment: "single-host-same-location",
    at: clock.value,
  })
  if (!confirmed.ok) throw new Error(`${confirmed.code}: ${confirmed.detail}`)
  return { grant: confirmed.value.grant, task: confirmed.value.task }
}

function reserve(
  ledger: WatchLedger,
  taskID: string,
  version: number,
  generation: number,
  reservationID: string,
  clock: Clock,
  caller = "ses_a",
  owner = "activation-a",
) {
  return ledger.reserveCorrection({
    taskId: taskID,
    callerSessionId: caller,
    ownerActivation: owner,
    expectedVersion: version,
    generation,
    reservationId: reservationID,
    at: clock.value,
  })
}

interface WorkerResult {
  readonly ok: boolean
  readonly code?: string
  readonly detail?: string
  readonly value?: {
    readonly task?: { readonly version: number }
    readonly attempt?: { readonly reservationID: string; readonly phase: string }
  }
}

async function worker(
  mode: "reserve" | "claim",
  path: string,
  taskId: string,
  caller: string,
  owner: string,
  version: number,
  generation: number,
  reservationId: string,
  at: number,
  killAfter?: "reserve" | "claim",
): Promise<WorkerResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "fixtures", "watch-correction-worker.ts"),
      mode,
      path,
      taskId,
      caller,
      owner,
      String(version),
      String(generation),
      reservationId,
      String(at),
      ...(killAfter === undefined ? [] : [killAfter]),
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await child.exited
  const output = (await new Response(child.stdout).text()).trim()
  const error = (await new Response(child.stderr).text()).trim()
  if (output.length === 0) {
    return { ok: false, code: "worker_exit", detail: `exit ${exitCode}: ${error}` }
  }
  return JSON.parse(output) as WorkerResult
}

function claimCorrelation(
  ledger: WatchLedger,
  taskID: string,
  reservationID: string,
  version: number,
  generation: number,
  clock: Clock,
  owner = "activation-a",
): string {
  const claimed = ledger.claimCorrection({
    taskId: taskID,
    reservationId: reservationID,
    ownerActivation: owner,
    expectedVersion: version,
    generation,
    at: clock.value,
  })
  if (!claimed.ok) throw new Error(`${claimed.code}: ${claimed.detail}`)
  return claimed.value.correlation
}

function attemptOf(result: ReturnType<WatchLedger["correction"]>): readonly WatchCorrectionAttemptRecord[] {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
  return result.value.attempts
}

describeCorrection("correction ledger", () => {
  test("schema 9 carries permanent attempts and the grant tables", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      expect(WATCH_LEDGER_SCHEMA_VERSION).toBe(9)
      expect(ledger.sqliteVersion).toMatch(/^3\./)
      let task = enroll(ledger)
      const granted = grant(ledger, task.taskID, task.version, clock)
      task = granted.task
      expect(granted.grant).toMatchObject({ mode: "limited-correction", state: "granted", version: 1 })
      expect(WATCH_CORRECTION_TERMS).toContain("three permanent attempts")
      expect(WATCH_CORRECTION_TERMS).toContain("first automatic")
      expect(WATCH_CORRECTION_TERMS).toContain("same OS user")
      expect(WATCH_CORRECTION_TERMS).toContain("not human authentication")
      expect(WATCH_CORRECTION_TERMS).toContain("never resets")
      expect(WATCH_CORRECTION_TERMS.length).toBeLessThanOrEqual(500)
    } finally {
      ledger.close()
    }
  })

  test("reserves ordinals 1..3 permanently and refuses the fourth", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        clock.value += 1_000
        const reserved = reserve(ledger, task.taskID, task.version, task.generation, `res-${ordinal}`, clock)
        expect(reserved.ok).toBe(true)
        if (!reserved.ok) return
        expect(reserved.value.attempt).toMatchObject({ ordinal, phase: "reserved" })
        expect(reserved.value.task.attemptsUsed).toBe(ordinal)
        const claimed = ledger.claimCorrection({
          taskId: task.taskID,
          reservationId: `res-${ordinal}`,
          ownerActivation: "activation-a",
          expectedVersion: reserved.value.task.version,
          generation: task.generation,
          at: clock.value,
        })
        expect(claimed.ok).toBe(true)
        const rejected = ledger.recordCorrectionOutcome({
          taskId: task.taskID,
          reservationId: `res-${ordinal}`,
          ownerActivation: "activation-a",
          outcome: "rejected",
          at: clock.value,
        })
        expect(rejected.ok).toBe(true)
        task = ledger.show({ taskID: task.taskID, sessionID: "ses_a" }).ok
          ? (ledger.show({ taskID: task.taskID, sessionID: "ses_a" }) as { value: typeof task }).value
          : task
      }
      const fourth = reserve(ledger, task.taskID, task.version, task.generation, "res-4", clock)
      expect(fourth).toMatchObject({ ok: false, code: "attempt_limit" })
      ledger.close()

      const reopened = open(clock, scratch[scratch.length - 1])
      clock.value += 1_000
      const shown = reopened.show({ taskID: task.taskID, sessionID: "ses_a" })
      expect(shown.ok).toBe(true)
      if (shown.ok && shown.value !== null) expect(shown.value.attemptsUsed).toBe(3)
      expect(attemptOf(reopened.correction(task.taskID))).toHaveLength(3)
      reopened.close()
    } finally {
      ledger.close()
    }
  })

  test("keeps one pending attempt and claims the send slot exactly once", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const first = reserve(ledger, task.taskID, task.version, task.generation, "res-once", clock)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = reserve(ledger, task.taskID, first.value.task.version, task.generation, "res-second", clock)
      expect(second).toMatchObject({ ok: false, code: "pending_attempt" })

      const claimed = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-once",
        ownerActivation: "activation-a",
        expectedVersion: first.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(claimed).toMatchObject({ ok: true, value: { claimed: true } })
      const again = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-once",
        ownerActivation: "activation-a",
        expectedVersion: first.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(again).toMatchObject({ ok: false, code: "claim_taken" })

      ledger.close()
      const reopened = open(clock, scratch[scratch.length - 1])
      const replay = reopened.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-once",
        ownerActivation: "activation-a",
        expectedVersion: first.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(replay).toMatchObject({ ok: false, code: "claim_taken" })
      expect(attemptOf(reopened.correction(task.taskID))[0]).toMatchObject({ phase: "sending" })
      reopened.close()
    } finally {
      ledger.close()
    }
  })

  test("a grant challenge expires and is consumed without granting", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      const began = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: task.version,
        reportId: "ttl-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) return
      task = began.value.task
      const prepared = ledger.prepareCorrectionGrant({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: task.version,
        reviewSummary: WATCH_CORRECTION_TERMS,
        deployment: "single-host-same-location",
        ttlMs: 30_000,
        at: clock.value,
      })
      if (!prepared.ok) return
      clock.value += 31_000
      const expired = ledger.confirmCorrectionGrant({
        challenge: prepared.value.challenge,
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: prepared.value.expectedVersion,
        generation: prepared.value.generation,
        termsDigest: prepared.value.termsDigest,
        deployment: "single-host-same-location",
        at: clock.value,
      })
      expect(expired).toMatchObject({ ok: false, code: "grant_expired" })
      expect(attemptOf(ledger.correction(task.taskID))).toHaveLength(0)
    } finally {
      ledger.close()
    }
  })

  test("only the canonical terms summary is accepted and the current digest is required", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      const began = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: task.version,
        reportId: "terms-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok) return
      task = began.value.task
      const wrongSummary = ledger.prepareCorrectionGrant({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: task.version,
        reviewSummary: "different terms",
        deployment: "single-host-same-location",
        at: clock.value,
      })
      expect(wrongSummary).toMatchObject({ ok: false, code: "invalid_input" })
      const prepared = ledger.prepareCorrectionGrant({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: task.version,
        reviewSummary: WATCH_CORRECTION_TERMS,
        deployment: "single-host-same-location",
        at: clock.value,
      })
      if (!prepared.ok) return
      const wrongDigest = ledger.confirmCorrectionGrant({
        challenge: prepared.value.challenge,
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: prepared.value.expectedVersion,
        generation: prepared.value.generation,
        termsDigest: "wrong-digest",
        deployment: "single-host-same-location",
        at: clock.value,
      })
      expect(wrongDigest).toMatchObject({ ok: false, code: "grant_expired" })
      const confirmed = ledger.confirmCorrectionGrant({
        challenge: prepared.value.challenge,
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: prepared.value.expectedVersion,
        generation: prepared.value.generation,
        termsDigest: prepared.value.termsDigest,
        deployment: "single-host-same-location",
        at: clock.value,
      })
      expect(confirmed).toMatchObject({ ok: true, value: { grant: { reviewSummary: WATCH_CORRECTION_TERMS } } })
    } finally {
      ledger.close()
    }
  })

  test("an old reservation cannot be revived by downgrade, regrant or a newer task version", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-old-grant", clock)
      if (!reserved.ok) return
      const current = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!current.ok || current.value === null) throw new Error("task missing")
      const downgraded = ledger.downgradeCorrection({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: current.value.version,
        at: clock.value,
      })
      expect(downgraded.ok).toBe(true)
      const latest = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!latest.ok || latest.value === null) throw new Error("task missing")
      const afterDowngrade = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-old-grant",
        ownerActivation: "activation-a",
        expectedVersion: latest.value.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(afterDowngrade).toMatchObject({ ok: false, code: "not_active" })

      clock.value += 10
      const regranted = grant(ledger, task.taskID, latest.value.version, clock)
      task = regranted.task
      const afterRegrant = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-old-grant",
        ownerActivation: "activation-a",
        expectedVersion: task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(afterRegrant).toMatchObject({ ok: false })
      expect(attemptOf(ledger.correction(task.taskID))).toHaveLength(1)
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "reserved" })
    } finally {
      ledger.close()
    }
  })

  test("busy timeout and WAL are read back from the embedded connection", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-pragmas-"))
    scratch.push(directory)
    const opened = openWatchLedger({
      path: join(directory, "watch-ledger.sqlite3"),
      busyTimeoutMs: 123,
    })
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      expect(opened.ledger.busyTimeoutMs).toBe(123)
      expect(opened.ledger.journalMode).toBe("wal")
      expect(opened.ledger.synchronous).toBe(2)
      expect(opened.ledger.filesystem).not.toBe("unknown")
      opened.ledger.close()
    }
  })

  test("the runtime version seam can only tighten the embedded SQLite gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-sqlite-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const higher = openWatchLedger({ path, sqliteVersion: "9.9.9" })
    expect(higher.ok).toBe(true)
    if (higher.ok) {
      expect(higher.ledger.sqliteVersion).not.toBe("9.9.9")
      higher.ledger.close()
    }
    const stricter = openWatchLedger({ path, sqliteVersion: "3.50.0" })
    expect(stricter).toMatchObject({ ok: false, code: "unsafe_sqlite" })
  })

  test("a first receipt issues one permit before acceptance and duplicates never issue another", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-receipt", clock)
      if (!reserved.ok) throw new Error(reserved.code)
      const correlation = claimCorrelation(ledger, task.taskID, "res-receipt", reserved.value.task.version, task.generation, clock)
      clock.value += 10
      const receipt = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-receipt",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(receipt).toMatchObject({
        ok: true,
        value: { continuePermit: true, duplicate: false, attempt: { phase: "receipted" } },
      })
      const duplicate = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-receipt",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(duplicate).toMatchObject({ ok: true, value: { continuePermit: false, duplicate: true } })
      const different = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-receipt",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation: "caller-chosen-token",
        at: clock.value,
      })
      expect(different).toMatchObject({ ok: false, code: "receipt_conflict" })
      const wrongCaller = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-receipt",
        callerSessionId: "ses_elsewhere",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      expect(wrongCaller).toMatchObject({ ok: false, code: "caller_mismatch" })
      const acceptedLate = ledger.recordCorrectionOutcome({
        taskId: task.taskID,
        reservationId: "res-receipt",
        ownerActivation: "activation-a",
        outcome: "accepted",
        at: clock.value + 1,
      })
      expect(acceptedLate).toMatchObject({ ok: true, value: { attempt: { phase: "receipted" } } })
      if (acceptedLate.ok) expect(acceptedLate.value.attempt.acceptedAt).toBe(clock.value + 1)
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "receipted" })
    } finally {
      ledger.close()
    }
  })

  test("a downgraded grant records the seen receipt without a permit", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-downgraded", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-downgraded",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      const current = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!current.ok || current.value === null) throw new Error("task missing")
      const downgraded = ledger.downgradeCorrection({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        ownerActivation: "activation-a",
        expectedVersion: current.value.version,
        at: clock.value,
      })
      expect(downgraded.ok).toBe(true)
      const receipt = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-downgraded",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(receipt).toMatchObject({
        ok: true,
        value: { continuePermit: false, duplicate: false, seen: true, refusalReason: "grant-changed" },
      })
      if (receipt.ok) {
        expect(receipt.value.attempt.phase).toBe("receipted")
        expect(receipt.value.attempt.receiptPermitAt).toBeUndefined()
        expect(receipt.value.attempt.lastSeenReason).toBe("grant-changed")
      }
    } finally {
      ledger.close()
    }
  })

  test("a caller-chosen receipt token cannot unlock the reservation", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-token", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-token",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      const forged = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-token",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation: "forged-token",
        at: clock.value,
      })
      expect(forged).toMatchObject({ ok: false, code: "receipt_conflict" })
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "sending" })
      const correct = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-token",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(correct).toMatchObject({ ok: true, value: { continuePermit: true, duplicate: false } })
    } finally {
      ledger.close()
    }
  })

  test("merges late outcomes monotonically without reopening the claim", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-late", clock)
      if (!reserved.ok) return
      ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-late",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      const unknown = ledger.recordCorrectionOutcome({
        taskId: task.taskID,
        reservationId: "res-late",
        ownerActivation: "activation-a",
        outcome: "unknown",
        at: clock.value,
      })
      expect(unknown).toMatchObject({ ok: true, value: { attempt: { phase: "unknown" } } })
      const lateAccepted = ledger.recordCorrectionOutcome({
        taskId: task.taskID,
        reservationId: "res-late",
        ownerActivation: "activation-a",
        outcome: "accepted",
        at: clock.value + 1,
      })
      expect(lateAccepted).toMatchObject({ ok: true, value: { attempt: { phase: "accepted" } } })
      const lateUnknown = ledger.recordCorrectionOutcome({
        taskId: task.taskID,
        reservationId: "res-late",
        ownerActivation: "activation-a",
        outcome: "unknown",
        at: clock.value + 2,
      })
      expect(lateUnknown).toMatchObject({ ok: true, value: { attempt: { phase: "accepted" }, changed: false } })
      const replay = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-late",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(replay).toMatchObject({ ok: false, code: "claim_taken" })
    } finally {
      ledger.close()
    }
  })

  test("recovery needs a receipt and a new progress report with the matching result", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-recover", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-recover",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      const noReceipt = ledger.recordCorrectionRecovery({
        taskId: task.taskID,
        reservationId: "res-recover",
        callerSessionId: "ses_a",
        progressReportId: "report-1",
        resultReference: "result-1",
        generation: task.generation,
        at: clock.value,
      })
      expect(noReceipt).toMatchObject({ ok: false, code: "recovery_evidence_missing" })

      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-recover",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      clock.value += 10
      const report = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: ledger.show({ taskID: task.taskID, sessionID: "ses_a" }).ok
          ? (ledger.show({ taskID: task.taskID, sessionID: "ses_a" }) as { value: { version: number } }).value.version
          : 1,
        reportId: "report-recovery",
        kind: "progress",
        evidence: { summary: "new result exists", reference: "result-recovery" },
      })
      expect(report.ok).toBe(true)
      const recovered = ledger.recordCorrectionRecovery({
        taskId: task.taskID,
        reservationId: "res-recover",
        callerSessionId: "ses_a",
        progressReportId: "report-recovery",
        resultReference: "result-recovery",
        generation: task.generation,
        at: clock.value + 5,
      })
      expect(recovered).toMatchObject({ ok: true, value: { recovered: true, attempt: { phase: "recovered" } } })
    } finally {
      ledger.close()
    }
  })

  test("recovery rejects a result reference that was already reported", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-old-result", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-old-result",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      const versionNow = () => {
        const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
        if (!shown.ok || shown.value === null) throw new Error("task missing")
        return shown.value.version
      }
      clock.value += 1
      const old = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: versionNow(),
        reportId: "old-result-report",
        kind: "progress",
        evidence: { summary: "old checkpoint", reference: "old-result" },
      })
      expect(old.ok).toBe(true)
      clock.value += 1
      const receipt = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-old-result",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(receipt).toMatchObject({ ok: true, value: { continuePermit: true } })
      clock.value += 1
      const repeated = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: versionNow(),
        reportId: "repeated-old-result",
        kind: "progress",
        evidence: { summary: "same checkpoint again", reference: "old-result" },
      })
      expect(repeated.ok).toBe(true)
      const rejected = ledger.recordCorrectionRecovery({
        taskId: task.taskID,
        reservationId: "res-old-result",
        callerSessionId: "ses_a",
        progressReportId: "repeated-old-result",
        resultReference: "old-result",
        generation: task.generation,
        at: clock.value,
      })
      expect(rejected).toMatchObject({ ok: false, code: "recovery_evidence_missing" })
      clock.value += 1
      const fresh = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: versionNow(),
        reportId: "fresh-result-report",
        kind: "progress",
        evidence: { summary: "new checkpoint", reference: "new-result" },
      })
      expect(fresh.ok).toBe(true)
      const recovered = ledger.recordCorrectionRecovery({
        taskId: task.taskID,
        reservationId: "res-old-result",
        callerSessionId: "ses_a",
        progressReportId: "fresh-result-report",
        resultReference: "new-result",
        generation: task.generation,
        at: clock.value,
      })
      expect(recovered).toMatchObject({ ok: true, value: { recovered: true } })
    } finally {
      ledger.close()
    }
  })

  test("a permit without recovery stays pending and blocks another reserve or replacement task", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-permit", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-permit",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      clock.value += 10
      const receipt = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-permit",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      expect(receipt).toMatchObject({ ok: true, value: { continuePermit: true } })
      const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      const second = reserve(
        ledger,
        task.taskID,
        shown.value.version,
        task.generation,
        "res-after-permit",
        clock,
      )
      expect(second).toMatchObject({ ok: false, code: "pending_attempt" })

      clock.value += 10
      const progress = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: shown.value.version,
        reportId: "permit-recovery-report",
        kind: "progress",
        evidence: { summary: "new result", reference: "permit-new-result" },
      })
      expect(progress.ok).toBe(true)
      const recovered = ledger.recordCorrectionRecovery({
        taskId: task.taskID,
        reservationId: "res-permit",
        callerSessionId: "ses_a",
        progressReportId: "permit-recovery-report",
        resultReference: "permit-new-result",
        generation: task.generation,
        at: clock.value + 1,
      })
      expect(recovered).toMatchObject({ ok: true, value: { recovered: true } })
      const afterRecovery = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!afterRecovery.ok || afterRecovery.value === null) throw new Error("task missing")
      const third = reserve(
        ledger,
        task.taskID,
        afterRecovery.value.version,
        task.generation,
        "res-after-recovery",
        clock,
      )
      expect(third.ok).toBe(true)
    } finally {
      ledger.close()
    }
  })

  test("a permit closes on completed with a new reference but not on a reused one", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-complete-permit", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-complete-permit",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      const beforeReceipt = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!beforeReceipt.ok || beforeReceipt.value === null) throw new Error("task missing")
      clock.value += 1
      const oldProgress = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: beforeReceipt.value.version,
        reportId: "old-ref-before",
        kind: "progress",
        evidence: { summary: "old result", reference: "reused-reference" },
      })
      expect(oldProgress.ok).toBe(true)
      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-complete-permit",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      clock.value += 10
      const oldRef = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: shown.value.version,
        reportId: "complete-old-ref",
        kind: "completed",
        evidence: { summary: "old result", reference: "reused-reference" },
      })
      expect(oldRef.ok).toBe(true)
      let attempt = attemptOf(ledger.correction(task.taskID))[0]
      expect(attempt).toMatchObject({ phase: "receipted" })
      expect(attempt?.closedAt).toBeUndefined()

      // A completed task with a reused reference was still a valid business
      // report, but it did not close the correction permit.
      const after = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!after.ok || after.value === null) throw new Error("task missing")
      expect(after.value.taskState).toBe("completed")
    } finally {
      ledger.close()
    }
  })

  test("a permit closes on a new completed result reference without faking recovery", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-complete-new", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-complete-new",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-complete-new",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      clock.value += 10
      const completed = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: shown.value.version,
        reportId: "complete-new",
        kind: "completed",
        evidence: { summary: "new result", reference: "new-completed-result" },
      })
      expect(completed.ok).toBe(true)
      const attempt = attemptOf(ledger.correction(task.taskID))[0]
      expect(attempt).toMatchObject({ phase: "receipted", closedReason: "task-completed" })
      expect(attempt?.recoveredAt).toBeUndefined()
      const next = enroll(ledger, "ses_a", "req-after-complete", "activation-a")
      const granted = grant(ledger, next.taskID, next.version, clock).task
      const allowed = reserve(ledger, next.taskID, granted.version, granted.generation, "res-after-complete", clock)
      expect(allowed.ok).toBe(true)
    } finally {
      ledger.close()
    }
  })

  test("a permit closes on an active new waiting report but is not recovery", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-wait-permit", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-wait-permit",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-wait-permit",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      clock.value += 10
      const waiting = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: shown.value.version,
        reportId: "waiting-new",
        kind: "waiting",
        evidence: {
          waitKind: "human",
          waitFor: "reviewer",
          reason: "needs an answer",
          reference: "waiting-reference",
          waitID: "waiting-new",
          waitUntil: clock.value + 60_000,
        },
      })
      expect(waiting.ok).toBe(true)
      const attempt = attemptOf(ledger.correction(task.taskID))[0]
      expect(attempt).toMatchObject({ phase: "receipted", closedReason: "normal-wait" })
      expect(attempt?.recoveredAt).toBeUndefined()
      expect(waiting.ok && waiting.value.task.taskState).toBe("waiting")
    } finally {
      ledger.close()
    }
  })

  test("a permit-only old task blocks a replacement task until recovery", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let first = enroll(ledger, "ses_a", "req-permit-old", "activation-a")
      first = grant(ledger, first.taskID, first.version, clock).task
      const reserved = reserve(ledger, first.taskID, first.version, first.generation, "res-permit-old", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        first.taskID,
        "res-permit-old",
        reserved.value.task.version,
        first.generation,
        clock,
      )
      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: first.taskID,
        reservationId: "res-permit-old",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      const current = ledger.show({ taskID: first.taskID, sessionID: "ses_a" })
      if (!current.ok || current.value === null) throw new Error("task missing")
      const ended = ledger.control({
        taskId: first.taskID,
        callerSessionId: "ses_a",
        expectedVersion: current.value.version,
        operation: "end",
      })
      expect(ended.ok).toBe(true)
      expect(attemptOf(ledger.correction(first.taskID))[0]?.closedAt).toBeUndefined()
      let second = enroll(ledger, "ses_a", "req-permit-new", "activation-a")
      second = grant(ledger, second.taskID, second.version, clock).task
      const blocked = reserve(ledger, second.taskID, second.version, second.generation, "res-permit-new", clock)
      expect(blocked).toMatchObject({ ok: false, code: "session_unresolved" })
    } finally {
      ledger.close()
    }
  })

  test("an overdue waiting report does not close a receipted permit", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-overdue-wait", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        task.taskID,
        "res-overdue-wait",
        reserved.value.task.version,
        task.generation,
        clock,
      )
      clock.value += 10
      ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: "res-overdue-wait",
        callerSessionId: "ses_a",
        currentActivationId: "activation-a",
        correlation,
        at: clock.value,
      })
      const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      clock.value += 10
      const waiting = ledger.report({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: shown.value.version,
        reportId: "overdue-wait-report",
        kind: "waiting",
        evidence: {
          waitKind: "human",
          waitFor: "reviewer",
          reason: "already late",
          reference: "late",
          waitID: "overdue-wait",
          waitUntil: clock.value - 1,
        },
      })
      expect(waiting.ok).toBe(true)
      const attempt = attemptOf(ledger.correction(task.taskID))[0]
      expect(attempt?.closedAt).toBeUndefined()
    } finally {
      ledger.close()
    }
  })

  test("an unresolved old attempt blocks a replacement task for the same session", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let first = enroll(ledger, "ses_a", "req-old", "activation-a")
      first = grant(ledger, first.taskID, first.version, clock).task
      const reserved = reserve(ledger, first.taskID, first.version, first.generation, "res-old", clock)
      if (!reserved.ok) return
      const correlation = claimCorrelation(
        ledger,
        first.taskID,
        "res-old",
        reserved.value.task.version,
        first.generation,
        clock,
      )
      ledger.recordCorrectionOutcome({
        taskId: first.taskID,
        reservationId: "res-old",
        ownerActivation: "activation-a",
        outcome: "accepted",
        at: clock.value,
      })
      const current = ledger.show({ taskID: first.taskID, sessionID: "ses_a" })
      if (!current.ok || current.value === null) throw new Error("task missing")
      const ended = ledger.control({
        taskId: first.taskID,
        callerSessionId: "ses_a",
        expectedVersion: current.value.version,
        operation: "end",
      })
      expect(ended.ok).toBe(true)
      let second = enroll(ledger, "ses_a", "req-new", "activation-a")
      second = grant(ledger, second.taskID, second.version, clock).task
      const blocked = reserve(ledger, second.taskID, second.version, second.generation, "res-new", clock)
      expect(blocked).toMatchObject({ ok: false, code: "session_unresolved" })

      ledger.recordCorrectionReceipt({
        taskId: first.taskID,
        reservationId: "res-old",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      const allowed = reserve(ledger, second.taskID, second.version, second.generation, "res-new", clock)
      expect(allowed.ok).toBe(true)
    } finally {
      ledger.close()
    }
  })

  test("independent processes reserve only one pending attempt", async () => {
    const clock = { value: 1_000 }
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-race-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const ledger = open(clock, directory)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          worker(
            "reserve",
            path,
            task.taskID,
            "ses_a",
            "activation-a",
            task.version,
            task.generation,
            `race-${index}`,
            clock.value,
          ),
        ),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      const attempts = attemptOf(ledger.correction(task.taskID))
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.phase).toBe("reserved")
    } finally {
      ledger.close()
    }
  })

  test("three multiprocess rounds spend the hard limit and the fourth is refused", async () => {
    const clock = { value: 1_000 }
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-limit-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const ledger = open(clock, directory)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        clock.value += 1_000
        const prefix = `limit-${ordinal}`
        const results = await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            worker(
              "reserve",
              path,
              task.taskID,
              "ses_a",
              "activation-a",
              task.version,
              task.generation,
              `${prefix}-${index}`,
              clock.value,
            ),
          ),
        )
        const winners = results.filter((result) => result.ok)
        expect(winners).toHaveLength(1)
        const winner = winners[0]
        if (winner?.value?.task === undefined || winner.value.attempt === undefined) {
          throw new Error(`winner did not report its reservation: ${JSON.stringify(winner)}`)
        }
        const claimed = ledger.claimCorrection({
          taskId: task.taskID,
          reservationId: winner.value.attempt.reservationID,
          ownerActivation: "activation-a",
          expectedVersion: winner.value.task.version,
          generation: task.generation,
          at: clock.value,
        })
        expect(claimed.ok).toBe(true)
        const rejected = ledger.recordCorrectionOutcome({
          taskId: task.taskID,
          reservationId: winner.value.attempt.reservationID,
          ownerActivation: "activation-a",
          outcome: "rejected",
          at: clock.value,
        })
        expect(rejected.ok).toBe(true)
        const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
        if (!shown.ok || shown.value === null) throw new Error("task missing")
        task = shown.value
      }
      const fourth = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          worker(
            "reserve",
            path,
            task.taskID,
            "ses_a",
            "activation-a",
            task.version,
            task.generation,
            `limit-4-${index}`,
            clock.value,
          ),
        ),
      )
      expect(fourth.every((result) => !result.ok)).toBe(true)
      expect(fourth.every((result) => result.code === "attempt_limit")).toBe(true)
      expect(attemptOf(ledger.correction(task.taskID))).toHaveLength(3)
    } finally {
      ledger.close()
    }
  })

  test("independent processes claim one reservation only once", async () => {
    const clock = { value: 1_000 }
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-claim-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const ledger = open(clock, directory)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-claim-once", clock)
      if (!reserved.ok) return
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          worker(
            "claim",
            path,
            task.taskID,
            "ses_a",
            "activation-a",
            reserved.value.task.version,
            task.generation,
            "res-claim-once",
            clock.value,
          ),
        ),
      )
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok).every((result) => result.code === "claim_taken")).toBe(true)
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "sending" })
    } finally {
      ledger.close()
    }
  })

  test("a claimed send survives a process kill and is never claimed again", async () => {
    const clock = { value: 1_000 }
    const directory = mkdtempSync(join(tmpdir(), "session-peers-correction-kill-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const ledger = open(clock, directory)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-kill", clock)
      if (!reserved.ok) return
      const killed = await worker(
        "claim",
        path,
        task.taskID,
        "ses_a",
        "activation-a",
        reserved.value.task.version,
        task.generation,
        "res-kill",
        clock.value,
        "claim",
      )
      expect(killed.ok).toBe(true)
      ledger.close()
      const reopened = open(clock, directory)
      const replayed = reopened.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-kill",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(replayed).toMatchObject({ ok: false, code: "claim_taken" })
      expect(attemptOf(reopened.correction(task.taskID))[0]).toMatchObject({ phase: "sending" })
      reopened.close()
    } finally {
      ledger.close()
    }
  })

  test("an unclaimed reservation can be aborted before send and still spends its ordinal", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-abort", clock)
      if (!reserved.ok) return
      const aborted = ledger.abortCorrection({
        taskId: task.taskID,
        reservationId: "res-abort",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value + 5,
      })
      expect(aborted).toMatchObject({ ok: true, value: { aborted: true, attempt: { phase: "aborted" } } })
      if (aborted.ok) expect(aborted.value.attempt.abortedAt).toBe(clock.value + 5)
      const current = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!current.ok || current.value === null) throw new Error("task missing")
      const next = reserve(ledger, task.taskID, current.value.version, task.generation, "res-after-abort", clock)
      expect(next.ok).toBe(true)
      if (next.ok) expect(next.value.attempt.ordinal).toBe(2)
      expect(attemptOf(ledger.correction(task.taskID))).toHaveLength(2)
    } finally {
      ledger.close()
    }
  })

  test("a claimed send cannot be aborted as if it never left", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-abort-sent", clock)
      if (!reserved.ok) return
      ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-abort-sent",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      const aborted = ledger.abortCorrection({
        taskId: task.taskID,
        reservationId: "res-abort-sent",
        ownerActivation: "activation-a",
        expectedVersion: reserved.value.task.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(aborted).toMatchObject({ ok: false, code: "not_claimable" })
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "sending" })
    } finally {
      ledger.close()
    }
  })

  test("pause or end blocks a new claim but keeps the reserved attempt history", () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      let task = enroll(ledger)
      task = grant(ledger, task.taskID, task.version, clock).task
      const reserved = reserve(ledger, task.taskID, task.version, task.generation, "res-paused", clock)
      if (!reserved.ok) return
      const paused = ledger.control({
        taskId: task.taskID,
        callerSessionId: "ses_a",
        expectedVersion: reserved.value.task.version,
        operation: "pause",
      })
      expect(paused.ok).toBe(true)
      const afterPause = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
      if (!afterPause.ok || afterPause.value === null) throw new Error("task missing")
      const claim = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: "res-paused",
        ownerActivation: "activation-a",
        expectedVersion: afterPause.value.version,
        generation: task.generation,
        at: clock.value,
      })
      expect(claim).toMatchObject({ ok: false, code: "not_active" })
      expect(attemptOf(ledger.correction(task.taskID))[0]).toMatchObject({ phase: "reserved" })
    } finally {
      ledger.close()
    }
  })
})
