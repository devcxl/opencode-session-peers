/**
 * The one serial correction executor.
 *
 * It never holds a database transaction across a prompt. The order is fixed:
 * gate, durable reservation, separated recheck (ignoring its own reservation),
 * one claim, closing check, one queue call, monotonic outcome. A failed or
 * unknown result is never replayed; the ledger remains the authority.
 */

import { randomUUID } from "node:crypto"

import type {
  WatchCorrectionAttemptRecord,
  WatchCorrectionSnapshot,
  WatchObservationView,
  WatchTaskRecord,
} from "../domain/watch.ts"
import {
  correctionGate,
  type CorrectionGateInput,
  type CorrectionGateResult,
  type CorrectionRuntimeFacts,
} from "./correction.ts"
import type {
  AbortCorrectionInput,
  ClaimCorrectionInput,
  LedgerResult,
  RecordCorrectionOutcomeInput,
  ReserveCorrectionInput,
} from "./ledger.ts"

export type {
  CorrectionDeliveryOutcome,
  CorrectionDeliveryPort,
  CorrectionDeliveryRequest,
} from "../host/correction-delivery.ts"
import type { CorrectionDeliveryOutcome as DeliveryOutcome, CorrectionDeliveryPort } from "../host/correction-delivery.ts"

export interface CorrectionExecutorAuthority {
  liveTasks(): readonly WatchTaskRecord[]
  snapshot(taskID: string): WatchCorrectionSnapshot | undefined
  reserve(input: ReserveCorrectionInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly attempt: WatchCorrectionAttemptRecord
    readonly created: boolean
  }>
  claim(input: ClaimCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly claimed: boolean
    readonly correlation: string
  }>
  outcome(input: RecordCorrectionOutcomeInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly changed: boolean
  }>
  abort(input: AbortCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly aborted: boolean
  }>
  onChanged(): void
}

export interface CorrectionExecutorOptions {
  readonly authority: CorrectionExecutorAuthority
  readonly observationFor: (taskID: string) => WatchObservationView | null
  readonly sameLocation: (sessionID: string) => Promise<boolean>
  readonly runtime: () => CorrectionRuntimeFacts
  /** Production passes `correctionGate`; tests may pass a controlled fact gate. */
  readonly gate?: (input: CorrectionGateInput) => CorrectionGateResult
  readonly delivery: CorrectionDeliveryPort
  readonly activationID: string
  readonly now: () => number
  readonly warn: (message: string) => void
}

export interface CorrectionExecutor {
  /** Schedule at most one serial run per task. */
  kick(taskID: string): void
  /** Stop accepting new runs and let tracked promises settle. */
  close(): Promise<void>
  /** Wait for current runs without closing (use in tests/verification). */
  settle(): Promise<void>
  inFlight(): number
}

export function createCorrectionExecutor(options: CorrectionExecutorOptions): CorrectionExecutor {
  const gate = options.gate ?? correctionGate
  const queued = new Set<string>()
  const runs = new Map<string, Promise<void>>()
  let closing = false

  const kick = (taskID: string): void => {
    if (closing) return
    queued.add(taskID)
    if (runs.has(taskID)) return
    const run = runTask(taskID)
      .catch(() => options.warn("correction executor run failed; the ledger remains authoritative"))
      .finally(() => {
        runs.delete(taskID)
        if (!closing && queued.has(taskID)) {
          queued.delete(taskID)
          kick(taskID)
        }
      })
    runs.set(taskID, run)
  }

  const runTask = async (taskID: string): Promise<void> => {
    do {
      queued.delete(taskID)
      await once(taskID)
    } while (!closing && queued.has(taskID))
  }

  const once = async (taskID: string): Promise<void> => {
    if (closing) return
    const task = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    if (task === undefined || task.watchState !== "active" || task.taskState === "completed") return
    const snapshot = options.authority.snapshot(taskID)
    if (snapshot === undefined) return
    const sameLocation = await options.sameLocation(task.targetSessionID)
    if (closing) return
    const first = gate(gateInput(task, snapshot, sameLocation))
    if (!first.eligible) return

    const reservationID = randomUUID()
    const reserved = options.authority.reserve({
      taskId: taskID,
      callerSessionId: task.initiatorSessionID,
      ownerActivation: options.activationID,
      expectedVersion: task.version,
      generation: task.generation,
      reservationId: reservationID,
      at: options.now(),
    })
    if (!reserved.ok) return

    // Separated recheck: a new input, wait, pause, completion, grant change,
    // location change or closing abandons the permanent reservation without
    // sending. The executor's own reservation is not a blocking pending gate.
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (closing) return
    const current = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    const currentSnapshot = options.authority.snapshot(taskID)
    if (current === undefined || currentSnapshot === undefined) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    const sameAgain = await options.sameLocation(current.targetSessionID)
    if (closing) return
    const second = gate(
      gateInput(current, currentSnapshot, sameAgain, {
        ignoreAttemptID: reservationID,
      }),
    )
    if (!second.eligible) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }

    const claimed = options.authority.claim({
      taskId: taskID,
      reservationId: reservationID,
      ownerActivation: options.activationID,
      expectedVersion: reserved.value.task.version,
      generation: task.generation,
      at: options.now(),
    })
    if (!claimed.ok) return

    if (closing) {
      record(taskID, reservationID, { kind: "unknown", reason: "the executor closed before queue" })
      return
    }

    let outcome: DeliveryOutcome
    try {
      outcome = await options.delivery.send({
        targetSessionID: current.targetSessionID,
        text: correctionPrompt(current, claimed.value.attempt, claimed.value.correlation),
        attemptID: reservationID,
        correlation: claimed.value.correlation,
      })
    } catch {
      outcome = { kind: "unknown", reason: "the queue call threw without a definite rejection" }
    }
    record(taskID, reservationID, outcome)
  }

  const gateInput = (
    task: WatchTaskRecord,
    snapshot: WatchCorrectionSnapshot,
    sameLocation: boolean,
    additional: { readonly ignoreAttemptID?: string } = {},
  ): CorrectionGateInput => ({
    task,
    snapshot,
    observation: options.observationFor(task.taskID),
    runtime: options.runtime(),
    ownerActivation: options.activationID,
    sameLocation,
    singleHostDeclared: snapshot.grant?.deployment === "single-host-same-location",
    closing,
    executorReady: true,
    ...(additional.ignoreAttemptID === undefined ? {} : { ignoreAttemptID: additional.ignoreAttemptID }),
  })

  const abort = (taskID: string, reservationID: string, version: number, generation: number): void => {
    const aborted = options.authority.abort({
      taskId: taskID,
      reservationId: reservationID,
      ownerActivation: options.activationID,
      expectedVersion: version,
      generation,
      at: options.now(),
    })
    if (!aborted.ok) {
      options.warn("a reservation changed eligibility and could not be aborted; it remains unresolved")
    }
  }

  const record = (
    taskID: string,
    reservationID: string,
    outcome: DeliveryOutcome,
  ): void => {
    const recorded = options.authority.outcome({
      taskId: taskID,
      reservationId: reservationID,
      ownerActivation: options.activationID,
      outcome: outcome.kind,
      ...(outcome.kind === "accepted" ? { admissionID: outcome.admissionID } : {}),
      at: options.now(),
    })
    if (!recorded.ok) {
      options.warn("a correction outcome could not be recorded; it stays unknown and is not replayed")
      return
    }
    options.authority.onChanged()
  }

  return {
    kick,
    async close() {
      closing = true
      queued.clear()
      await Promise.allSettled([...runs.values()])
    },
    async settle() {
      await Promise.allSettled([...runs.values()])
    },
    inFlight() {
      return runs.size
    },
  }
}

/** The one correction prompt; it binds task, attempt and correlation without replaying work. */
export function correctionPrompt(
  task: WatchTaskRecord,
  attempt: WatchCorrectionAttemptRecord,
  correlation: string,
): string {
  return [
    "[session-peers correction]",
    `Watched task ${task.taskID}; permanent attempt ${attempt.ordinal}; correlation ${correlation}.`,
    "Before continuing business work, call peers({ action: \"watch\", watch: { operation: \"receipt\", taskID, attemptID, correlation } }).",
    "Only a continuePermit=true response for this attempt allows the smallest next step in the original authorization.",
    "Do not repeat completed or unknown side effects, do not expand permissions and do not rerun tools whose result is unknown.",
    "A receipt is not recovery. Report a real state change or completion with new progress and its result reference when it exists.",
  ].join("\n")
}
