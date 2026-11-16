import { describe, expect, test } from "bun:test"

import { correctionGate, type CorrectionGateInput, type CorrectionRuntimeFacts } from "../src/watch/correction.ts"
import type {
  WatchCorrectionAttemptRecord,
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
    deployment: "single-host-same-location",
    termsDigest: "digest",
    confirmationID: "confirmation",
    grantedAt: 1_000,
  },
  attempts: [],
  episode: null,
  lastAttemptPolicy: null,
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
  filesystem: "tmpfs",
}

describe("correction gate", () => {
  test("keeps stock 2.3.0 closed because its lifecycle provenance protocol failed", () => {
    const result = correctionGate({
      task,
      snapshot,
      observation,
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
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

  test("accepts only the version-distinct repaired host after its real protocol passed", () => {
    const input = {
      task,
      snapshot,
      observation,
      runtime: { ...runtime, appVersion: "2.3.0-watchdog-location.1" },
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    }
    expect(correctionGate(input).eligible).toBe(true)
    for (const appVersion of ["2.3.0", "2.3.0-watchdog-location.2", "2.3.1"]) {
      expect(correctionGate({ ...input, runtime: { ...input.runtime, appVersion } }).eligible).toBe(false)
    }
    expect(correctionGate({ ...input, runtime: { ...input.runtime, filesystem: "nfs" } }).eligible).toBe(false)
    expect(correctionGate({ ...input, runtime: { ...input.runtime, synchronous: 1 } }).eligible).toBe(false)
    expect(correctionGate({ ...input, sameLocation: false }).eligible).toBe(false)
    expect(correctionGate({ ...input, singleHostDeclared: false }).eligible).toBe(false)
    expect(correctionGate({ ...input, observation: { ...observation, trusted: false } }).eligible).toBe(false)
  })

  test("rejects paused tasks, unresolved session history and a mismatched grant", () => {
    const paused = correctionGate({
      task: { ...task, watchState: "paused" },
      snapshot,
      observation,
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    })
    expect(paused.eligible).toBe(false)
    expect(paused.stopReason).toBe("task-paused")
    expect(paused.gates.find((gate) => gate.gate === "task-active")).toMatchObject({ ok: false })

    const unresolved = correctionGate({
      task,
      snapshot: { ...snapshot, sessionUnresolved: true },
      observation,
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    })
    expect(unresolved.eligible).toBe(false)
    expect(unresolved.gates.find((gate) => gate.gate === "session-unresolved")).toMatchObject({ ok: false })

    const wrongMode = correctionGate({
      task: { ...task, mode: "alert" },
      snapshot,
      observation,
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    })
    expect(wrongMode.eligible).toBe(false)
    expect(wrongMode.gates.find((gate) => gate.gate === "grant")).toMatchObject({ ok: false })
  })

  test("cleared wait history does not keep the waits gate closed", () => {
    const result = correctionGate({
      task,
      snapshot,
      observation: {
        ...observation,
        waits: [
          {
            waitID: "form:old",
            source: "form",
            object: "form",
            reason: "answered",
            reference: "old",
            startedAt: 1_000,
            deadline: null,
            status: "cleared",
            clearEvidence: "answered",
            denyEvidence: null,
          },
        ],
      },
      runtime,
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    })
    expect(result.gates.find((gate) => gate.gate === "waits")).toMatchObject({ ok: true })
    expect(result.gates.find((gate) => gate.gate === "observation")).toMatchObject({ ok: true })
  })

  test("a non-local or unknown filesystem keeps the runtime gate closed", () => {
    const result = correctionGate({
      task,
      snapshot,
      observation,
      runtime: { ...runtime, filesystem: "nfs" },
      ownerActivation: "activation-a",
      sameLocation: true,
      singleHostDeclared: true,
      closing: false,
      now: 2_000,
      executorReady: true,
    })
    expect(result.gates.find((gate) => gate.gate === "runtime")).toMatchObject({ ok: false })
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
      now: 2_000,
      executorReady: true,
    })
    expect(result.eligible).toBe(false)
    expect(result.gates.find((gate) => gate.gate === "observation")).toMatchObject({ ok: false })
    expect(result.gates.find((gate) => gate.gate === "waits")).toMatchObject({ ok: false })
    expect(result.gates.find((gate) => gate.gate === "grant")).toMatchObject({ ok: true })
  })
})

const repairedRuntime: CorrectionRuntimeFacts = { ...runtime, appVersion: "2.3.0-watchdog-location.1" }
const episode = {
  startedAt: 1_000,
  deadlineAt: 1_201_000,
  observationMs: 300_000,
  windowMs: 1_200_000,
} as const

function attempt(
  overrides: Partial<WatchCorrectionAttemptRecord> & Pick<WatchCorrectionAttemptRecord, "reservationID" | "ordinal">,
): WatchCorrectionAttemptRecord {
  return {
    taskID: "task-a",
    phase: "aborted",
    reservedAt: 1_000,
    abortedAt: 1_000,
    ...overrides,
  }
}

function eligibleInput(overrides: Partial<CorrectionGateInput> = {}): CorrectionGateInput {
  return {
    task: { ...task, attemptsUsed: 0 },
    snapshot,
    observation,
    runtime: repairedRuntime,
    ownerActivation: "activation-a",
    sameLocation: true,
    singleHostDeclared: true,
    closing: false,
    executorReady: true,
    now: 2_000,
    ...overrides,
  }
}

describe("bounded automatic-attempt policy", () => {
  test("allows another attempt only at the end of the fixed post-attempt observation", () => {
    const first = attempt({ reservationID: "attempt-1", ordinal: 1 })
    const bounded = {
      ...snapshot,
      attempts: [first],
      episode,
    }
    const before = correctionGate(eligibleInput({ snapshot: bounded, now: episode.startedAt + 300_000 - 1 }))
    expect(before.eligible).toBe(false)
    expect(before.stopReason).toBe("post-attempt-observation")
    expect(before.policy).toMatchObject({
      used: 1,
      limit: 3,
      observationMs: 300_000,
      windowMs: 1_200_000,
      windowStartedAt: 1_000,
      windowEndsAt: 1_201_000,
      observationEndsAt: 301_000,
    })

    const atBoundary = correctionGate(eligibleInput({ snapshot: bounded, now: episode.startedAt + 300_000 }))
    expect(atBoundary.eligible).toBe(true)
    expect(atBoundary.stopReason).toBeNull()
  })

  test("stops at the fixed problem deadline and never extends it from a changed config", () => {
    const first = attempt({ reservationID: "attempt-1", ordinal: 1 })
    const bounded = { ...snapshot, attempts: [first], episode }
    const before = correctionGate(eligibleInput({ snapshot: bounded, now: episode.deadlineAt - 1 }))
    expect(before.eligible).toBe(true)
    expect(before.stopReason).toBeNull()

    const atDeadline = correctionGate(eligibleInput({ snapshot: bounded, now: episode.deadlineAt }))
    expect(atDeadline.eligible).toBe(false)
    expect(atDeadline.stopReason).toBe("correction-window")

    const laterWithLongerConfig = correctionGate(
      eligibleInput({
        snapshot: bounded,
        now: episode.deadlineAt + 1,
        policy: { observationMs: 1_000, windowMs: 10_000_000 },
      }),
    )
    expect(laterWithLongerConfig.eligible).toBe(false)
    expect(laterWithLongerConfig.stopReason).toBe("correction-window")
  })

  test("a first reservation still carries the fixed episode deadline into the final recheck", () => {
    const own = attempt({
      reservationID: "own",
      ordinal: 1,
      reservedAt: 1_000,
      abortedAt: undefined,
      phase: "reserved",
    })
    const snapshotWithOwn = {
      ...snapshot,
      attempts: [own],
      episode,
    }
    const fresh = correctionGate(
      eligibleInput({
        snapshot: snapshotWithOwn,
        now: episode.startedAt + 1_000,
        ignoreAttemptID: "own",
      }),
    )
    expect(fresh.eligible).toBe(true)
    expect(fresh.policy.used).toBe(0)

    const expired = correctionGate(
      eligibleInput({
        snapshot: snapshotWithOwn,
        now: episode.deadlineAt,
        ignoreAttemptID: "own",
      }),
    )
    expect(expired.eligible).toBe(false)
    expect(expired.stopReason).toBe("correction-window")
  })

  test("a window shorter than the observation expires once instead of being silently extended", () => {
    const first = attempt({ reservationID: "attempt-1", ordinal: 1 })
    const short = {
      ...snapshot,
      attempts: [first],
      episode: {
        startedAt: 1_000,
        deadlineAt: 301_000,
        observationMs: 600_000,
        windowMs: 300_000,
      },
    }
    const expired = correctionGate(eligibleInput({ snapshot: short, now: 301_000 }))
    expect(expired.eligible).toBe(false)
    expect(expired.stopReason).toBe("correction-window")
    expect(expired.policy.observationEndsAt).toBe(601_000)
    expect(expired.policy.windowEndsAt).toBe(301_000)
  })

  test("a backward clock cannot extend or bypass the fixed episode", () => {
    const first = attempt({ reservationID: "attempt-1", ordinal: 1 })
    const bounded = { ...snapshot, attempts: [first], episode }
    const backward = correctionGate(eligibleInput({ snapshot: bounded, now: episode.startedAt - 1 }))
    expect(backward.eligible).toBe(false)
    expect(backward.stopReason).toBe("correction-window")

    const invalid = correctionGate(eligibleInput({ snapshot: bounded, now: Number.NaN }))
    expect(invalid.eligible).toBe(false)
    expect(invalid.stopReason).toBe("post-attempt-observation")
  })

  test("a closed episode keeps the last attempt's persisted observation even after a config downchange", () => {
    for (const closedReason of ["recovered", "normal-wait"] as const) {
      const closed = attempt({
        reservationID: "attempt-1",
        ordinal: 1,
        phase: closedReason === "recovered" ? "recovered" : "receipted",
        receiptAt: 1_010,
        receiptPermitAt: 1_010,
        ...(closedReason === "recovered"
          ? {
              recoveredAt: 1_020,
              recoveryReportID: "report-1",
              recoveryReference: "result-1",
            }
          : {}),
        closedAt: 1_020,
        closedReason,
      })
      const closedAt = closed.closedAt ?? 1_020
      const snapshotAfterClose = {
        ...snapshot,
        attempts: [closed],
        episode: null,
        lastAttemptPolicy: { observationMs: 600_000, windowMs: 1_200_000 },
      }
      const tooSoon = correctionGate(
        eligibleInput({
          snapshot: snapshotAfterClose,
          now: closedAt + 300_000 + 1,
          policy: { observationMs: 300_000, windowMs: 2_400_000 },
        }),
      )
      expect(tooSoon.eligible).toBe(false)
      expect(tooSoon.stopReason).toBe("post-attempt-observation")
      expect(tooSoon.policy).toMatchObject({
        observationMs: 600_000,
        windowMs: 2_400_000,
        observationEndsAt: 601_020,
        windowStartedAt: null,
        windowEndsAt: null,
      })

      const atPersistedBoundary = correctionGate(
        eligibleInput({
          snapshot: snapshotAfterClose,
          now: closedAt + 600_000,
          policy: { observationMs: 300_000, windowMs: 2_400_000 },
        }),
      )
      expect(atPersistedBoundary.eligible).toBe(true)
      expect(atPersistedBoundary.policy.observationEndsAt).toBe(601_020)
    }
  })

  test("a normal-wait closure ends the episode; a cleared wait may start a new one with remaining quota", () => {
    const closed = attempt({
      reservationID: "attempt-1",
      ordinal: 1,
      phase: "receipted",
      receiptAt: 1_010,
      receiptPermitAt: 1_010,
      closedAt: 1_020,
      closedReason: "normal-wait",
    })
    const withoutEpisode = { ...snapshot, attempts: [closed], episode: null }
    const waiting = {
      ...observation,
      state: "normal-waiting" as const,
      waits: [
        {
          waitID: "wait-1",
          source: "reported" as const,
          object: "human",
          reason: "review",
          reference: "wait-ref",
          startedAt: 1_020,
          deadline: 61_020,
          status: "active" as const,
          clearEvidence: null,
          denyEvidence: null,
        },
      ],
    }
    const blocked = correctionGate(eligibleInput({ snapshot: withoutEpisode, observation: waiting, now: 400_000 }))
    expect(blocked.eligible).toBe(false)
    expect(blocked.stopReason).toBe("normal-wait")
    expect(blocked.policy.used).toBe(1)
    expect(blocked.policy.windowStartedAt).toBeNull()

    const cleared = correctionGate(eligibleInput({ snapshot: withoutEpisode, observation, now: 400_000 }))
    expect(cleared.eligible).toBe(true)
    expect(cleared.policy.used).toBe(1)
    expect(cleared.policy.windowStartedAt).toBeNull()
  })

  test("an overdue still-uncleared wait keeps the round closed and sends nothing", () => {
    const closed = attempt({
      reservationID: "attempt-1",
      ordinal: 1,
      phase: "receipted",
      receiptAt: 1_010,
      receiptPermitAt: 1_010,
      closedAt: 1_020,
      closedReason: "normal-wait",
    })
    const overdue = {
      ...observation,
      state: "normal-waiting" as const,
      waits: [
        {
          waitID: "wait-overdue",
          source: "reported" as const,
          object: "human",
          reason: "review",
          reference: "wait-ref",
          startedAt: 1_020,
          deadline: 2_000,
          status: "overdue" as const,
          clearEvidence: null,
          denyEvidence: null,
        },
      ],
    }
    const result = correctionGate(
      eligibleInput({
        snapshot: { ...snapshot, attempts: [closed], episode: null },
        observation: overdue,
        now: 2_001,
      }),
    )
    expect(result.eligible).toBe(false)
    expect(result.stopReason).toBe("normal-wait")
    expect(result.policy.used).toBe(1)
  })

  test("a recovered third attempt stops for quota, never as a policy failure", () => {
    const attempts = [1, 2, 3].map((ordinal) =>
      attempt({
        reservationID: `attempt-${ordinal}`,
        ordinal,
        phase: ordinal === 3 ? "recovered" : "aborted",
        ...(ordinal === 3
          ? {
              receiptAt: 2_000 + ordinal,
              receiptPermitAt: 2_000 + ordinal,
              recoveredAt: 3_000 + ordinal,
              recoveryReportID: `report-${ordinal}`,
              recoveryReference: `result-${ordinal}`,
              closedAt: 3_000 + ordinal,
              closedReason: "recovered",
            }
          : { abortedAt: 1_000 + ordinal }),
      }),
    )
    const result = correctionGate(
      eligibleInput({
        snapshot: { ...snapshot, attempts, episode: null },
        now: 3_000 + 300_000,
      }),
    )
    expect(result.eligible).toBe(false)
    expect(result.stopReason).toBe("attempt-limit")
    expect(result.policy.used).toBe(3)
    expect(result.policy.windowStartedAt).toBeNull()
  })

  test("an accepted but unreceipted attempt stops before any policy retry", () => {
    const accepted = attempt({
      reservationID: "attempt-1",
      ordinal: 1,
      phase: "accepted",
      claimedAt: 1_000,
      acceptedAt: 1_001,
      abortedAt: undefined,
    })
    const result = correctionGate(
      eligibleInput({
        snapshot: { ...snapshot, attempts: [accepted], episode },
        now: episode.deadlineAt + 1,
      }),
    )
    expect(result.eligible).toBe(false)
    expect(result.stopReason).toBe("accepted-without-receipt")
  })
})
