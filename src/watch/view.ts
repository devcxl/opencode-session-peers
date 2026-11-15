/**
 * Turning a ledger record into what a person and a panel may see.
 *
 * The view deliberately separates four things that read alike in prose: the
 * business task state, the supervision state, the selected authorization mode
 * and the capability this build actually has. It never exposes the owner
 * activation value; it says only whether the current instance is that owner.
 */

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
  type WatchCorrectionStopReason,
  type WatchCorrectionView,
  type WatchMode,
  type WatchControl,
  type WatchControls,
  type WatchReportRecord,
  type WatchReportView,
  type WatchTaskRecord,
  type WatchTaskView,
} from "../domain/watch.ts"

export function watchTaskView(
  task: WatchTaskRecord,
  activationID: string,
  correction: WatchCorrectionSnapshot,
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
    correction: watchCorrectionView(task, correction, activationID),
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
  const businessCompleted = task.taskState === "completed"
  const stop = correctionStop(task, grant, open, used, snapshot.sessionUnresolved)
  const history = attempts.map(correctionAttemptView)
  const pending = open === undefined ? null : correctionAttemptView(open)
  return {
    authorization: {
      mode: task.mode,
      state: grant === null ? "not-granted" : grant.state,
      version: grant?.version ?? 1,
      reviewSummary: grant?.reviewSummary ?? null,
      grantedAt: grant?.grantedAt ?? null,
    },
    actual: "unavailable",
    actualReason: CORRECTION_UNAVAILABLE_REASON,
    attempts: { used, limit: WATCH_CORRECTION_LIMIT },
    executionPolicy: "first-attempt-only",
    phase: pending?.phase ?? (last === null ? "idle" : last.phase),
    pending,
    last: last === null ? null : correctionAttemptView(last),
    history,
    stop,
    gates: [
      {
        gate: "grant",
        ok: grant?.state === "granted",
        reason: grant?.state === "granted" ? null : "no active correction grant",
        observed: grant === null ? "not-granted" : `${grant.state} version ${grant.version}`,
        required: "an active limited-correction grant",
      },
      {
        gate: "attempts",
        ok: used < WATCH_CORRECTION_LIMIT,
        reason: used < WATCH_CORRECTION_LIMIT ? null : "the three permanent attempts are spent",
        observed: `${used}/3 permanent attempts`,
        required: "fewer than three permanent attempts",
      },
      {
        gate: "pending-attempt",
        ok: open === undefined,
        reason: open === undefined ? null : `attempt ${open.ordinal} is still ${open.phase}`,
        observed: open === undefined ? "none" : `attempt ${open.ordinal} ${open.phase}`,
        required: "no unresolved attempt",
      },
      {
        gate: "business-unfinished",
        ok: !businessCompleted,
        reason: businessCompleted ? "the business task is completed" : null,
        observed: task.taskState,
        required: "not completed",
      },
      {
        gate: "runtime",
        ok: false,
        reason: "the real embedded runtime capability is not collected in this checkpoint",
        observed: "not collected",
        required: "Linux x64, a verified app tuple, embedded SQLite >= 3.51.3 with WAL, FULL, bounded busy_timeout and local filesystem",
      },
      {
        gate: "single-host",
        ok: false,
        reason: "no explicit single-host deployment statement is recorded",
        observed: "not declared",
        required: "an explicit single-host, same-location deployment statement (a declaration, not proof of uniqueness)",
      },
      {
        gate: "location",
        ok: false,
        reason: "same-host, same-location observation is not established",
        observed: "not established",
        required: "the same host and location continuously serve the target",
      },
      {
        gate: "owner-generation",
        ok: task.ownerActivation === activationID,
        reason: task.ownerActivation === activationID ? null : "this activation is not the recorded executor",
        observed: task.ownerActivation === activationID ? "this activation" : "another activation",
        required: "the current recorded owner activation and generation",
      },
      {
        gate: "protocol",
        ok: task.lastReport !== undefined,
        reason: task.lastReport === undefined ? "the target has not reported protocol participation" : null,
        observed: task.lastReport === undefined ? "no report" : "a report was recorded",
        required: "the target has participated in the protocol",
      },
      {
        gate: "observation",
        ok: false,
        reason: "trusted continuous idle is required and is not established here",
        observed: "no trusted idle sample",
        required: "continuous trusted idle-candidate evidence",
      },
      {
        gate: "waits",
        ok: false,
        reason: "no trusted wait snapshot is established here",
        observed: "not snapshotted",
        required: "no active, overdue or unknown wait and a complete wait snapshot",
      },
      {
        gate: "closing",
        ok: true,
        reason: null,
        observed: "open",
        required: "the activation is not closing",
      },
      {
        gate: "executor",
        ok: false,
        reason: "the controlled executor path is not open in this build",
        observed: "closed",
        required: "a controlled first-attempt executor that rechecks immediately before queue",
      },
    ],
    businessCompleted,
    controls: {
      grant: disabled(CORRECTION_UNAVAILABLE_REASON),
      downgrade: disabled(
        grant?.state === "granted"
          ? "the controlled downgrade surface is not open in this build"
          : "no correction grant exists to downgrade",
      ),
    },
  }
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

function correctionStop(
  task: WatchTaskRecord,
  grant: WatchCorrectionSnapshot["grant"],
  open: WatchCorrectionAttemptRecord | undefined,
  used: number,
  sessionUnresolved: boolean,
): { readonly reason: WatchCorrectionStopReason; readonly missingEvidence: string | null } {
  if (task.taskState === "completed") return { reason: "task-completed", missingEvidence: "the business task is completed" }
  if (task.watchState === "paused") return { reason: "task-paused", missingEvidence: "the watch is manually paused" }
  if (task.watchState === "ended") return { reason: "task-ended", missingEvidence: "the watch has ended" }
  if (grant === null || grant.state !== "granted") {
    return { reason: "grant-missing", missingEvidence: "no controlled correction grant is recorded" }
  }
  if (sessionUnresolved) {
    return { reason: "session-unresolved", missingEvidence: "an older task for this session still has an unresolved attempt" }
  }
  if (open !== undefined) {
    if (open.phase === "reserved") {
      return { reason: "reservation-pending", missingEvidence: "the permanent reservation has not claimed its one send slot" }
    }
    if (open.phase === "sending") {
      return { reason: "sending-unaccounted", missingEvidence: "the claimed send has no accepted or unknown outcome recorded" }
    }
    if (open.phase === "accepted") {
      return { reason: "accepted-without-receipt", missingEvidence: "the target has not submitted a correction receipt" }
    }
    return { reason: "unknown-result", missingEvidence: "the delivery outcome is unknown; no replay is allowed" }
  }
  if (used >= WATCH_CORRECTION_LIMIT) {
    return { reason: "attempt-limit", missingEvidence: "the three permanent attempts are spent" }
  }
  if (used >= 1) {
    return { reason: "first-attempt-policy", missingEvidence: "this build's automatic executor may use only the first attempt" }
  }
  return { reason: "executor-unavailable", missingEvidence: "the controlled executor path is not open in this build" }
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
