/**
 * The one serial correction executor.
 *
 * It never holds a database transaction across a prompt. The order is fixed:
 * gate, durable reservation, separated recheck (ignoring its own reservation),
 * one claim, closing check, one queue call, monotonic outcome. A failed or
 * unknown result is never replayed; the ledger remains the authority.
 */

import { randomUUID } from "node:crypto"

import {
  WATCH_CORRECTION_DEFAULT_POLICY,
  type WatchCorrectionAttemptRecord,
  type WatchCorrectionPolicy,
  type WatchCorrectionSnapshot,
  type WatchObservationView,
  type WatchTaskRecord,
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
  /** A missing/ambiguous link is treated as delegated, never as a self task. */
  isDelegatedTask(taskID: string): boolean
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
  /** Production re-samples the host before the precheck and final recheck. */
  readonly refreshObservation?: (taskID: string) => Promise<WatchObservationView | null>
  /** Tell the observer that the reservation's own version bump must keep the idle baseline. */
  readonly markOwnReservation?: (taskID: string, fromVersion: number, toVersion: number) => void
  readonly sameLocation: (sessionID: string) => Promise<boolean>
  readonly runtime: () => CorrectionRuntimeFacts
  /** Production passes `correctionGate`; tests may pass a controlled fact gate. */
  readonly gate?: (input: CorrectionGateInput) => CorrectionGateResult
  readonly delivery: CorrectionDeliveryPort
  readonly activationID: string
  readonly now: () => number
  /** Configured bounded-attempt policy; production passes the parsed watch config. */
  readonly policy?: WatchCorrectionPolicy
  /**
   * Fresh delegated-child authority. A delegated task with no hook, or a
   * refused hook, never reserves or claims a correction. Self tasks are
   * unchanged and need no check.
   */
  readonly checkDelegatedAuthority?: (taskID: string) => Promise<{
    readonly required: boolean
    readonly allowed: boolean
  }>
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
    const initialTask = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    if (
      initialTask === undefined ||
      initialTask.watchState !== "active" ||
      initialTask.taskState === "completed"
    ) {
      return
    }
    const sameLocation = await options.sameLocation(initialTask.targetSessionID)
    if (closing) return
    const refreshed = await freshObservation(taskID)
    if (closing) return
    // The final authority check is the last await before the synchronous
    // reservation decision. Any observation used below is read synchronously
    // after it, so activity during this await cannot leave a trusted stale view.
    if (!(await delegatedOkay(taskID))) return
    if (closing) return
    const checked = finalObservation(refreshed, options.observationFor(taskID))
    if (checked === null) return
    const task = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    const snapshot = task === undefined ? undefined : options.authority.snapshot(taskID)
    if (task === undefined || snapshot === undefined) return
    const first = gate(gateInput(task, snapshot, checked, sameLocation))
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
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    })
    if (!reserved.ok) return
    options.markOwnReservation?.(taskID, task.version, reserved.value.task.version)

    // Separated recheck: a new input, wait, pause, completion, grant change,
    // location change or closing abandons the permanent reservation without
    // sending. The executor's own reservation is not a blocking pending gate.
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (closing) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    const sameAgain = await options.sameLocation(task.targetSessionID)
    if (closing) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    const refreshedAgain = await freshObservation(taskID)
    if (closing) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    // Last await before the synchronous claim decision.
    if (!(await delegatedOkay(taskID))) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    if (closing) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    const checkedAgain = finalObservation(refreshedAgain, options.observationFor(taskID))
    if (checkedAgain === null) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    const current = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    const currentSnapshot = current === undefined ? undefined : options.authority.snapshot(taskID)
    if (
      current === undefined ||
      currentSnapshot === undefined ||
      current.version !== reserved.value.task.version ||
      current.generation !== reserved.value.task.generation
    ) {
      abort(taskID, reservationID, reserved.value.task.version, task.generation)
      return
    }
    // No await between this gate and claim: a new event cannot be processed in
    // this turn, and the ledger repeats the version/generation checks.
    const second = gate(
      gateInput(current, currentSnapshot, checkedAgain, sameAgain, {
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
    if (!claimed.ok) {
      if (claimed.code !== "claim_taken") {
        abort(taskID, reservationID, reserved.value.task.version, task.generation)
      }
      return
    }

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

  const freshObservation = async (taskID: string): Promise<WatchObservationView | null> =>
    options.refreshObservation === undefined
      ? options.observationFor(taskID)
      : await options.refreshObservation(taskID)

  /**
   * The pre-check sample may only make the decision stricter. The stored view
   * is read synchronously after the final await; on an equal timestamp it wins.
   */
  const finalObservation = (
    beforeCheck: WatchObservationView | null,
    latest: WatchObservationView | null,
  ): WatchObservationView | null => {
    if (beforeCheck === null || latest === null) return null
    const idleCompatible = (view: WatchObservationView): boolean =>
      view.trusted &&
      view.state === "idle-candidate" &&
      !view.waitsPartial &&
      !view.waitsTruncated &&
      view.waits.every(
        (wait) => wait.status !== "active" && wait.status !== "overdue" && wait.status !== "unknown",
      )
    if (!idleCompatible(beforeCheck)) return beforeCheck
    if (!idleCompatible(latest)) return latest
    return (latest.observedAt ?? 0) >= (beforeCheck.observedAt ?? 0) ? latest : beforeCheck
  }

  const delegatedOkay = async (taskID: string): Promise<boolean> => {
    let delegated: boolean
    try {
      delegated = options.authority.isDelegatedTask(taskID)
    } catch {
      options.warn("the delegation link could not be read; no correction was sent")
      return false
    }
    if (!delegated) return true
    if (options.checkDelegatedAuthority === undefined) {
      options.warn("a delegated child has no fresh authority hook; no correction was sent")
      return false
    }
    try {
      const checked = await options.checkDelegatedAuthority(taskID)
      // A delegated task must positively report required + allowed. A false
      // `required` from a helper that cannot see the link is not a pass.
      if (!checked.required || !checked.allowed) {
        options.warn("the delegated child authority refused this correction round; no send was attempted")
        return false
      }
      return true
    } catch {
      options.warn("the delegated child authority check failed; no correction was sent")
      return false
    }
  }

  const gateInput = (
    task: WatchTaskRecord,
    snapshot: WatchCorrectionSnapshot,
    observation: WatchObservationView | null,
    sameLocation: boolean,
    additional: { readonly ignoreAttemptID?: string } = {},
  ): CorrectionGateInput => ({
    task,
    snapshot,
    observation,
    runtime: options.runtime(),
    ownerActivation: options.activationID,
    sameLocation,
    singleHostDeclared: snapshot.grant?.deployment === "single-host-same-location",
    closing,
    executorReady: true,
    now: options.now(),
    policy: options.policy ?? WATCH_CORRECTION_DEFAULT_POLICY,
    ...(additional.ignoreAttemptID === undefined ? {} : { ignoreAttemptID: additional.ignoreAttemptID }),
  })

  const abort = (taskID: string, reservationID: string, fallbackVersion: number, generation: number): void => {
    const latest = options.authority.liveTasks().find((candidate) => candidate.taskID === taskID)
    const aborted = options.authority.abort({
      taskId: taskID,
      reservationId: reservationID,
      ownerActivation: options.activationID,
      expectedVersion: latest?.version ?? fallbackVersion,
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
  const receiptInput = {
    action: "watch",
    watch: {
      operation: "receipt",
      taskID: task.taskID,
      attemptID: attempt.reservationID,
      correlation,
    },
  }
  return [
    "[session-peers correction]",
    `Watched task ${task.taskID}; ledger generation ${task.generation}; permanent attempt ${attempt.ordinal}; attemptID ${attempt.reservationID}; correlation ${correlation}.`,
    `Original authorization goal: ${JSON.stringify(task.goal)}.`,
    `Target session: ${task.targetSessionID}; task state version after reservation: ${task.version}.`,
    `Before any business step, verify this is the same task; check the existing results and current authorization, then call exactly: peers(${JSON.stringify(receiptInput)})`,
    "Use the actual taskID, attemptID and correlation above; do not guess them and do not take them from a show snapshot.",
    "Only a continuePermit=true response for this attempt allows the smallest next step in the original authorization.",
    "If the receipt is refused, do not continue business work. Do not repeat completed or unknown side effects, expand permissions, or rerun tools whose result is unknown.",
    "A receipt is not recovery. Report a real state change or completion with new progress and its result reference when it exists.",
  ].join("\n")
}
