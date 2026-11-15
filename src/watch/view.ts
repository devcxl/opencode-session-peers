/**
 * Turning a ledger record into what a person and a panel may see.
 *
 * The view deliberately separates four things that read alike in prose: the
 * business task state, the supervision state, the selected authorization mode
 * and the capability this build actually has. It never exposes the owner
 * activation value; it says only whether the current instance is that owner.
 */

import { correctionGate } from "./correction.ts"
import {
  CORRECTION_UNAVAILABLE_REASON,
  DELEGATION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  SAFETY_PAUSE_UNAVAILABLE_REASON,
  TRANSFER_UNAVAILABLE_REASON,
  WATCH_CORRECTION_LIMIT,
  type WatchAlertRecord,
  type WatchAlertView,
  type WatchCapability,
  type WatchCorrectionAttemptRecord,
  type WatchCorrectionAttemptView,
  type WatchCorrectionSnapshot,
  type WatchCorrectionView,
  type WatchMode,
  type WatchObservationView,
  type WatchControl,
  type WatchControls,
  type WatchReportRecord,
  type WatchReportView,
  type WatchTaskRecord,
  type WatchTaskView,
} from "../domain/watch.ts"

export interface WatchRuntimeFactsView {
  readonly appVersion: string | null
  readonly platform: string | null
  readonly arch: string | null
  readonly sqliteVersion: string | null
  readonly journalMode: string | null
  readonly synchronous: number | null
  readonly busyTimeoutMs: number | null
  readonly filesystem: string | null
}

export function watchTaskView(
  task: WatchTaskRecord,
  activationID: string,
  correction: WatchCorrectionSnapshot,
  runtime?: WatchRuntimeFactsView,
  observation?: WatchObservationView | null,
  closing?: boolean,
): WatchTaskView {
  return {
    taskID: task.taskID,
    initiatorSessionID: task.initiatorSessionID,
    targetSessionID: task.targetSessionID,
    goal: task.goal,
    mode: task.mode,
    watchState: task.watchState,
    taskState: task.taskState,
    version: task.version,
    generation: task.generation,
    ownership: task.ownerActivation === activationID ? "this-instance" : "another-activation",
    participation: task.lastReport === undefined ? "not-seen" : "seen",
    attempts: { used: task.attemptsUsed, limit: WATCH_CORRECTION_LIMIT },
    correction: watchCorrectionView(task, correction, activationID, runtime, observation, closing),
    pause:
      task.watchState === "paused"
        ? { kind: "manual", reason: "paused by the user; business execution is untouched" }
        : null,
    lastReport: task.lastReport === undefined ? null : reportView(task.lastReport),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    endedAt: task.endedAt ?? null,
  }
}

/**
 * The pass-1 correction pane contract: the grant is separate from what this
 * build can actually do. No controlled grant surface or executor exists here,
 * so even a granted task stays `actual: "unavailable"` until pass 2.
 */
export function watchCorrectionView(
  task: WatchTaskRecord,
  snapshot: WatchCorrectionSnapshot,
  activationID: string,
  runtime?: WatchRuntimeFactsView,
  observation?: WatchObservationView | null,
  closing = false,
): WatchCorrectionView {
  const grant = snapshot.grant
  const attempts = snapshot.attempts
  const open = attempts.find(
    (attempt) =>
      attempt.phase === "reserved" ||
      attempt.phase === "sending" ||
      attempt.phase === "accepted" ||
      attempt.phase === "unknown",
  )
  const last = attempts.length === 0 ? null : (attempts[attempts.length - 1] ?? null)
  const used = attempts.length
  const gate = correctionGate({
    task,
    snapshot,
    observation: observation ?? null,
    runtime: {
      appVersion: runtime?.appVersion ?? null,
      platform: runtime?.platform ?? null,
      arch: runtime?.arch ?? null,
      sqliteVersion: runtime?.sqliteVersion ?? null,
      journalMode: runtime?.journalMode ?? null,
      synchronous: runtime?.synchronous ?? null,
      busyTimeoutMs: runtime?.busyTimeoutMs ?? null,
      filesystem: runtime?.filesystem ?? null,
    },
    ownerActivation: activationID,
    sameLocation: observation !== null && observation !== undefined,
    singleHostDeclared: grant?.deployment === "single-host-same-location",
    closing,
    executorReady: true,
  })
  const history = attempts.map(correctionAttemptView)
  const pending = open === undefined ? null : correctionAttemptView(open)
  return {
    authorization: {
      mode: task.mode,
      state: grant === null ? "not-granted" : grant.state,
      deployment: grant?.deployment ?? "unknown",
      version: grant?.version ?? 1,
      reviewSummary: grant?.reviewSummary ?? null,
      grantedAt: grant?.grantedAt ?? null,
    },
    actual: gate.eligible ? "ready" : "unavailable",
    actualReason: gate.eligible
      ? "The correction executor gates are satisfied for this attempt."
      : (gate.missingEvidence ?? CORRECTION_UNAVAILABLE_REASON),
    attempts: { used, limit: WATCH_CORRECTION_LIMIT },
    executionPolicy: "first-attempt-only",
    phase: pending?.phase ?? (last === null ? "idle" : last.phase),
    pending,
    last: last === null ? null : correctionAttemptView(last),
    history,
    stop:
      gate.stopReason === null
        ? null
        : { reason: gate.stopReason, missingEvidence: gate.missingEvidence },
    gates: gate.gates,
    businessCompleted: task.taskState === "completed",
    controls: {
      grant: correctionGrantControl(task, activationID, grant?.state === "granted"),
      downgrade: correctionDowngradeControl(task, activationID, grant?.state === "granted"),
    },
  }
}

function correctionGrantControl(
  task: WatchTaskRecord,
  activationID: string,
  granted: boolean,
): WatchControl {
  if (task.ownerActivation !== activationID) return disabled("another activation owns this task's correction authority")
  if (task.watchState === "ended") return disabled("the watch has ended; a new grant needs a new task")
  if (task.taskState === "completed") return disabled("the business task is completed")
  if (granted) return disabled("a correction grant is already active; downgrade it before preparing another")
  return enabled()
}

function correctionDowngradeControl(
  task: WatchTaskRecord,
  activationID: string,
  granted: boolean,
): WatchControl {
  if (task.ownerActivation !== activationID) return disabled("another activation owns this task's correction authority")
  if (!granted) return disabled("no active correction grant exists to downgrade")
  return enabled()
}

function correctionAttemptView(attempt: WatchCorrectionAttemptRecord): WatchCorrectionAttemptView {
  return {
    attemptID: attempt.reservationID,
    ordinal: attempt.ordinal,
    phase: attempt.phase,
    reservedAt: attempt.reservedAt,
    claimedAt: attempt.claimedAt ?? null,
    acceptedAt: attempt.acceptedAt ?? null,
    rejectedAt: attempt.rejectedAt ?? null,
    unknownAt: attempt.unknownAt ?? null,
    abortedAt: attempt.abortedAt ?? null,
    seen:
      attempt.lastSeenAt === undefined
        ? null
        : { at: attempt.lastSeenAt, reason: attempt.lastSeenReason ?? null },
    receipt:
      attempt.receiptAt === undefined
        ? null
        : {
            at: attempt.receiptAt,
            continuePermitIssuedAt: attempt.receiptPermitAt ?? null,
            refusalReason: attempt.receiptRefusalReason ?? null,
          },
    recovery:
      attempt.recoveredAt === undefined
        ? null
        : {
            progressReportID: attempt.recoveryReportID ?? "",
            resultReference: attempt.recoveryReference ?? "",
            at: attempt.recoveredAt,
          },
    stopReason: attempt.stopReason ?? null,
  }
}

export function watchAlertView(alert: WatchAlertRecord): WatchAlertView {
  const nextStep = "Inspect the task and its evidence; acknowledge the alert after reading it. This build cannot correct or resume the task for you."
  return {
    alertID: alert.alertID,
    taskID: alert.taskID,
    kind: alert.kind,
    state: alert.state,
    summary: alert.summary,
    reason: alert.reason,
    nextStep,
    plainText: `${alert.summary} ${alert.reason}`,
    firstAt: alert.firstAt,
    updatedAt: alert.updatedAt,
    readAt: alert.readAt ?? null,
    escalatedAt: alert.escalatedAt ?? null,
    resolvedAt: alert.resolvedAt ?? null,
  }
}

export function watchCapability(mode: WatchMode = "alert"): WatchCapability {
  return {
    mode,
    monitoring: "observer-alerts",
    automaticDetection: "partial",
    automaticDetectionReason:
      "Observes local execution lifecycle, target activity and same-location waits; it does not prove goal progress or single-host uniqueness.",
    correction: "unavailable",
    correctionReason: CORRECTION_UNAVAILABLE_REASON,
    delegation: "unavailable",
    delegationReason: DELEGATION_UNAVAILABLE_REASON,
    transfer: "unavailable",
    transferReason: TRANSFER_UNAVAILABLE_REASON,
    recovery: "unavailable",
    recoveryReason: RECOVERY_UNAVAILABLE_REASON,
    safetyPause: "unavailable",
    safetyPauseReason: SAFETY_PAUSE_UNAVAILABLE_REASON,
  }
}

export function watchControls(task: WatchTaskView | null): WatchControls {
  if (task === null) {
    return {
      pause: disabled("no watched task is enrolled for this session"),
      end: disabled("no watched task is enrolled for this session"),
      acknowledge: disabled("no watched task is enrolled for this session"),
      resume: disabled(RECOVERY_UNAVAILABLE_REASON),
      correction: disabled(CORRECTION_UNAVAILABLE_REASON),
      transfer: disabled(TRANSFER_UNAVAILABLE_REASON),
    }
  }
  const ended = task.watchState === "ended"
  const paused = task.watchState === "paused"
  return {
    pause: ended || paused ? disabled(ended ? "the watch has ended" : "the watch is already paused") : enabled(),
    end: ended ? disabled("the watch has ended") : enabled(),
    // Reading is always allowed for the task initiator, including paused/ended
    // histories; it changes only the unread flag.
    acknowledge: enabled(),
    resume: disabled(RECOVERY_UNAVAILABLE_REASON),
    correction: disabled(CORRECTION_UNAVAILABLE_REASON),
    transfer: disabled(TRANSFER_UNAVAILABLE_REASON),
  }
}

function reportView(report: WatchReportRecord): WatchReportView {
  return {
    reportID: report.reportID,
    kind: report.kind,
    evidence: report.evidence,
    at: report.at,
    version: report.version,
  }
}

function enabled(): WatchControl {
  return { enabled: true, reason: null }
}

function disabled(reason: string): WatchControl {
  return { enabled: false, reason }
}
