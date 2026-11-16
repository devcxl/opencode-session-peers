/**
 * One correction executor run that is SIGKILLed after claiming and after the
 * queue adapter recorded a send, but before the ledger result is written.
 *
 * The parent test reopens the ledger: the attempt must remain sending, must not
 * replay and must not refund. This is a test-only controlled fact gate; the
 * production whitelist is not changed by this fixture.
 */

import { appendFileSync } from "node:fs"

import { openWatchLedger, type ClaimCorrectionInput, type RecordCorrectionOutcomeInput, type ReserveCorrectionInput } from "../../src/watch/ledger.ts"
import { correctionGateWithVerifiedTuples } from "../../src/watch/correction.ts"
import { createCorrectionExecutor, type CorrectionExecutorAuthority } from "../../src/watch/executor.ts"
import type { WatchObservationView } from "../../src/domain/watch.ts"

const [path, taskID, sendLog] = process.argv.slice(2)
if (path === undefined || taskID === undefined || sendLog === undefined) {
  console.error("usage: watch-executor-worker.ts <ledger-path> <task-id> <send-log>")
  process.exit(2)
}

const opened = openWatchLedger({ path, busyTimeoutMs: 2_000, openAttempts: 20 })
if (!opened.ok) process.exit(3)
const ledger = opened.ledger
const authority: CorrectionExecutorAuthority = {
  liveTasks() {
    const listed = ledger.listActive()
    return listed.ok ? listed.value : []
  },
  snapshot(id) {
    const snapshot = ledger.correction(id)
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

const observation: WatchObservationView = {
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

const executor = createCorrectionExecutor({
  authority,
  observationFor: () => observation,
  sameLocation: async () => true,
  runtime: () => ({
    appVersion: "2.3.0",
    platform: "linux",
    arch: "x64",
    sqliteVersion: "3.53.4",
    journalMode: "wal",
    synchronous: 2,
    busyTimeoutMs: 500,
    filesystem: "tmpfs",
  }),
  gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
  delivery: {
    async send(request) {
      appendFileSync(sendLog, `${JSON.stringify({ attemptID: request.attemptID, correlation: request.correlation })}\n`)
      process.kill(process.pid, "SIGKILL")
      return { kind: "unknown", reason: "killed" }
    },
  },
  activationID: "activation-a",
  now: () => 1_000,
  warn: () => {},
})
executor.kick(taskID)
await executor.settle()
ledger.close()
