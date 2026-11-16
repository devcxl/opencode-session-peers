/**
 * The correction executor state machine against the real ledger.
 *
 * This is a controlled-fact test seam: production uses the empty verified-tuple
 * whitelist, while this test builds the executor with a test-only gate factory
 * and a fake queue port. It does not prove real host support.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { Database } from "bun:sqlite"

import {
  openWatchLedger,
  type ClaimCorrectionInput,
  type RecordCorrectionOutcomeInput,
  type ReserveCorrectionInput,
  type WatchLedger,
} from "../src/watch/ledger.ts"
import { correctionGate, correctionGateWithVerifiedTuples } from "../src/watch/correction.ts"
import {
  createCorrectionExecutor,
  type CorrectionDeliveryOutcome,
  type CorrectionDeliveryRequest,
  type CorrectionExecutorAuthority,
} from "../src/watch/executor.ts"
import type {
  WatchCorrectionAttemptRecord,
  WatchObservationView,
  WatchTaskRecord,
} from "../src/domain/watch.ts"
import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"

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
const describeExecutor = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Clock {
  value: number
}

function open(clock: Clock): WatchLedger {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-executor-"))
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

function seed(ledger: WatchLedger, clock: Clock): WatchTaskRecord {
  const enrolled = ledger.enroll({
    requestId: "executor-task",
    initiatorSessionId: "ses_a",
    targetSessionId: "ses_a",
    goal: "ship the correction executor",
    mode: "alert",
    ownerActivation: "activation-a",
  })
  if (!enrolled.ok) throw new Error(enrolled.code)
  let task = enrolled.value.task
  const began = ledger.report({
    taskId: task.taskID,
    callerSessionId: "ses_a",
    expectedVersion: task.version,
    reportId: "executor-begin",
    kind: "begin",
    evidence: {},
  })
  if (!began.ok) throw new Error(began.code)
  task = began.value.task
  const prepared = ledger.prepareCorrectionGrant({
    taskId: task.taskID,
    callerSessionId: "ses_a",
    ownerActivation: "activation-a",
    expectedVersion: task.version,
    reviewSummary: WATCH_CORRECTION_TERMS,
    deployment: "single-host-same-location",
    at: clock.value,
  })
  if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.detail}`)
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
  if (!confirmed.ok) throw new Error(`${confirmed.code}: ${confirmed.detail}`)
  return confirmed.value.task
}

function authority(ledger: WatchLedger): CorrectionExecutorAuthority {
  return {
    liveTasks() {
      const listed = ledger.listActive()
      return listed.ok ? listed.value : []
    },
    snapshot(taskID) {
      const snapshot = ledger.correction(taskID)
      return snapshot.ok ? snapshot.value : undefined
    },
    reserve(input: ReserveCorrectionInput) {
      return ledger.reserveCorrection(input)
    },
    claim(input: ClaimCorrectionInput) {
      return ledger.claimCorrection(input)
    },
    outcome(input: RecordCorrectionOutcomeInput) {
      return ledger.recordCorrectionOutcome(input)
    },
    abort(input) {
      return ledger.abortCorrection(input)
    },
    onChanged() {},
  }
}

function observation(): WatchObservationView {
  return {
    state: "idle-candidate",
    reason: null,
    observedAt: 2_000,
    baselineAt: 1_000,
    idleSince: 1_000,
    trusted: true,
    waits: [],
    waitsPartial: false,
    waitsTruncated: false,
    effective: { idleMs: 120_000, runningSilentMs: 600_000, waitOverdueMs: 1_800_000 },
  }
}

const runtime = {
  appVersion: "2.3.0",
  platform: "linux",
  arch: "x64",
  sqliteVersion: "3.53.4",
  journalMode: "wal",
  synchronous: 2,
  busyTimeoutMs: 500,
  filesystem: "tmpfs",
} as const

function attempts(ledger: WatchLedger, taskID: string): readonly WatchCorrectionAttemptRecord[] {
  const snapshot = ledger.correction(taskID)
  if (!snapshot.ok) throw new Error(snapshot.code)
  return snapshot.value.attempts
}

describeExecutor("correction executor", () => {
  test("a fully eligible task is queued exactly once with the bound correlation", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      const sent: CorrectionDeliveryRequest[] = []
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send(request) {
            sent.push(request)
            return { kind: "accepted", admissionID: "admission-1" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(1)
      const parsed = JSON.parse(/peers\((\{.*\})\)/.exec(sent[0]?.text ?? "")?.[1] ?? "{}") as {
        watch?: { taskID?: string; attemptID?: string; correlation?: string }
      }
      expect(parsed.watch).toMatchObject({
        taskID: task.taskID,
        attemptID: sent[0]?.attemptID,
        correlation: sent[0]?.correlation,
      })
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({
        phase: "accepted",
        admissionID: "admission-1",
      })

      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(1)
      expect(attempts(ledger, task.taskID)).toHaveLength(1)
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("the empty production gate sends nothing", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      const sent: CorrectionDeliveryRequest[] = []
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGate,
        delivery: {
          async send(request) {
            sent.push(request)
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(0)
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("a fresh recheck that sees running work aborts the reservation instead of queueing", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let reads = 0
      const sent: CorrectionDeliveryRequest[] = []
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        refreshObservation: async () => {
          reads += 1
          return reads === 1 ? observation() : { ...observation(), state: "active" }
        },
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send(request) {
            sent.push(request)
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "aborted" })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("a change between reserve and claim spends the ordinal without sending", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let calls = 0
      const sent: CorrectionDeliveryRequest[] = []
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: (input) => {
          calls += 1
          return calls === 1
            ? correctionGateWithVerifiedTuples(["2.3.0/linux/x64"])(input)
            : correctionGate(input)
        },
        delivery: {
          async send(request) {
            sent.push(request)
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "aborted" })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("a report between reserve and recheck still aborts the unclaimed reservation", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let calls = 0
      const sent: CorrectionDeliveryRequest[] = []
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: (input) => {
          calls += 1
          if (calls === 1) return correctionGateWithVerifiedTuples(["2.3.0/linux/x64"])(input)
          const shown = ledger.show({ taskID: task.taskID, sessionID: "ses_a" })
          if (shown.ok && shown.value !== null) {
            ledger.report({
              taskId: task.taskID,
              callerSessionId: "ses_a",
              expectedVersion: shown.value.version,
              reportId: "recheck-report",
              kind: "progress",
              evidence: { summary: "new input", reference: "recheck-reference" },
            })
          }
          return correctionGate(input)
        },
        delivery: {
          async send(request) {
            sent.push(request)
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toHaveLength(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "aborted" })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("a non-claim-taken failure aborts the unclaimed reservation", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      const base = authority(ledger)
      let aborts = 0
      const executor = createCorrectionExecutor({
        authority: {
          ...base,
          claim: () => ({ ok: false, code: "stale_version", detail: "raced" }),
          abort: (input) => {
            aborts += 1
            return base.abort(input)
          },
        },
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send() {
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(aborts).toBe(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "aborted" })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("claim_taken is a no-op and leaves the other claimer's attempt alone", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      const base = authority(ledger)
      let aborts = 0
      const executor = createCorrectionExecutor({
        authority: {
          ...base,
          claim: () => ({ ok: false, code: "claim_taken", detail: "another process" }),
          abort: (input) => {
            aborts += 1
            return base.abort(input)
          },
        },
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send() {
            return { kind: "accepted", admissionID: "must-not-happen" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(aborts).toBe(0)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "reserved" })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("a receipt can arrive before the queue result and never issues a second permit", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let correlation = ""
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send(request) {
            const parsed = JSON.parse(/peers\((\{.*\})\)/.exec(request.text)?.[1] ?? "{}") as {
              watch?: { taskID?: string; attemptID?: string; correlation?: string }
            }
            if (
              parsed.watch?.taskID !== task.taskID ||
              parsed.watch.attemptID !== request.attemptID ||
              parsed.watch.correlation === undefined
            ) {
              throw new Error("the prompt did not carry a concrete receipt call")
            }
            correlation = parsed.watch.correlation
            const receipt = ledger.recordCorrectionReceipt({
              taskId: parsed.watch.taskID,
              reservationId: parsed.watch.attemptID,
              callerSessionId: "ses_a",
              currentActivationId: "activation-a",
              correlation: parsed.watch.correlation,
              at: clock.value,
            })
            expect(receipt).toMatchObject({ ok: true, value: { continuePermit: true } })
            return { kind: "accepted", admissionID: "admission-early" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "receipted", admissionID: "admission-early" })
      const duplicate = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: attempts(ledger, task.taskID)[0]?.reservationID ?? "",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(duplicate).toMatchObject({ ok: true, value: { continuePermit: false, duplicate: true } })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("closing before the queue fence prevents a new send", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let sent = 0
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send() {
            sent += 1
            return { kind: "accepted", admissionID: "must-not-send" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.close()
      expect(sent).toBe(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(0)
    } finally {
      ledger.close()
    }
  })

  test("a late accepted result after close is recorded once without a new send", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let release: (() => void) | undefined
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      let sent = 0
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send() {
            sent += 1
            await hold
            return { kind: "accepted", admissionID: "late-close" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      while (sent === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      const closing = executor.close()
      release?.()
      await closing
      expect(sent).toBe(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({
        phase: "accepted",
        admissionID: "late-close",
      })
    } finally {
      ledger.close()
    }
  })

  test("a SIGKILL after send and before accounting leaves sending without replay", async () => {
    const clock = { value: 1_000 }
    const directory = mkdtempSync(join(tmpdir(), "session-peers-executor-kill-"))
    scratch.push(directory)
    const path = join(directory, "watch-ledger.sqlite3")
    const sendLog = join(directory, "sends.jsonl")
    const opened = openWatchLedger({
      path,
      busyTimeoutMs: 2_000,
      openAttempts: 20,
      now: () => clock.value,
    })
    if (!opened.ok) throw new Error(opened.code)
    const ledger = opened.ledger
    try {
      const task = seed(ledger, clock)
      const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "watch-executor-worker.ts"), path, task.taskID, sendLog], {
        stdio: "ignore",
      })
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }))
      })
      expect(exit.signal).toBe("SIGKILL")
      expect(readFileSync(sendLog, "utf8")).toContain("correlation")
      const after = attempts(ledger, task.taskID)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ phase: "sending" })
      expect(after[0]?.admissionID).toBeUndefined()

      let sent = 0
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send() {
            sent += 1
            return { kind: "accepted", admissionID: "must-not-replay" }
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toBe(0)
      expect(attempts(ledger, task.taskID)).toHaveLength(1)
      const replay = ledger.claimCorrection({
        taskId: task.taskID,
        reservationId: after[0]?.reservationID ?? "",
        ownerActivation: "activation-a",
        expectedVersion: ledger.show({ taskID: task.taskID, sessionID: "ses_a" }).ok
          ? (ledger.show({ taskID: task.taskID, sessionID: "ses_a" }) as { value: { version: number } }).value.version
          : 1,
        generation: task.generation,
        at: clock.value,
      })
      expect(replay).toMatchObject({ ok: false })
      await executor.close()
    } finally {
      ledger.close()
    }
  })

  test("an unknown queue result never replays and a late receipt can still continue", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const task = seed(ledger, clock)
      let sent = 0
      let correlation = ""
      let outcome: CorrectionDeliveryOutcome = { kind: "unknown", reason: "lost" }
      const executor = createCorrectionExecutor({
        authority: authority(ledger),
        observationFor: () => observation(),
        sameLocation: async () => true,
        runtime: () => runtime,
        gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
        delivery: {
          async send(request) {
            sent += 1
            correlation = request.correlation
            return outcome
          },
        },
        activationID: "activation-a",
        now: () => clock.value,
        warn: () => {},
      })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toBe(1)
      expect(attempts(ledger, task.taskID)[0]).toMatchObject({ phase: "unknown" })
      executor.kick(task.taskID)
      await executor.settle()
      expect(sent).toBe(1)
      outcome = { kind: "accepted", admissionID: "late" }
      const receipt = ledger.recordCorrectionReceipt({
        taskId: task.taskID,
        reservationId: attempts(ledger, task.taskID)[0]?.reservationID ?? "",
        callerSessionId: "ses_a",
        currentActivationId: 'activation-a',
        correlation,
        at: clock.value,
      })
      expect(receipt).toMatchObject({ ok: true, value: { continuePermit: true } })
      await executor.close()
    } finally {
      ledger.close()
    }
  })
})
