import { describe, expect, test } from "bun:test"

import { correctionGate, type CorrectionRuntimeFacts } from "../src/watch/correction.ts"
import type {
  WatchCorrectionSnapshot,
  WatchObservationView,
  WatchTaskRecord,
} from "../src/domain/watch.ts"

const task: WatchTaskRecord = {
  taskID: "task-a",
  initiatorSessionID: "ses_a",
  targetSessionID: "ses_a",
  goal: "goal",
  mode: "limited-correction",
  watchState: "active",
  taskState: "in-progress",
  version: 4,
  generation: 1,
  attemptsUsed: 0,
  ownerActivation: "activation-a",
  reportedWaits: [],
  lastReport: {
    reportID: "report-begin",
    kind: "begin",
    evidence: {},
    at: 1_000,
    version: 2,
  },
  createdAt: 1_000,
  updatedAt: 2_000,
}

const snapshot: WatchCorrectionSnapshot = {
  grant: {
    grantID: "grant-a",
    taskID: "task-a",
    mode: "limited-correction",
    state: "granted",
    version: 1,
    generation: 1,
    scopeTargetSessionID: "ses_a",
    reviewSummary: "reviewed",
    termsDigest: "digest",
    confirmationID: "confirmation",
    grantedAt: 1_000,
  },
  attempts: [],
  sessionUnresolved: false,
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

const runtime: CorrectionRuntimeFacts = {
  platform: "linux",
  arch: "x64",
  appVersion: "2.3.0",
  sqliteVersion: "3.53.4",
  journalMode: "wal",
  synchronous: 2,
  busyTimeoutMs: 500,
  filesystem: "local",
}

describe("correction gate", () => {
  test("keeps automatic sending closed until a runtime tuple is actually verified", () => {
    const result = correctionGate({
      task,
      snapshot,
      observation,
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      executorReady: true,
    })
    expect(result.eligible).toBe(false)
    expect(result.stopReason).toBe("runtime-unsupported")
    expect(result.gates.find((gate) => gate.gate === "runtime")).toMatchObject({
      ok: false,
      observed: expect.stringContaining("2.3.0/linux/x64"),
      required: expect.stringContaining("verified app tuple"),
    })
    expect(result.gates.filter((gate) => gate.gate !== "runtime" && gate.gate !== "executor").every((gate) => gate.ok)).toBe(true)
  })

  test("reports observation and wait gaps without turning them into a grant decision", () => {
    const result = correctionGate({
      task,
      snapshot,
      observation: { ...observation, state: "normal-waiting", trusted: false, waitsPartial: true },
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      executorReady: true,
    })
    expect(result.eligible).toBe(false)
    expect(result.gates.find((gate) => gate.gate === "observation")).toMatchObject({ ok: false })
    expect(result.gates.find((gate) => gate.gate === "waits")).toMatchObject({ ok: false })
    expect(result.gates.find((gate) => gate.gate === "grant")).toMatchObject({ ok: true })
  })
})
