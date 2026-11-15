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
  type WatchControl,
  type WatchControls,
  type WatchReportRecord,
  type WatchReportView,
  type WatchTaskRecord,
  type WatchTaskView,
} from "../domain/watch.ts"

export function watchTaskView(task: WatchTaskRecord, activationID: string): WatchTaskView {
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

export function watchCapability(): WatchCapability {
  return {
    mode: "alert",
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
