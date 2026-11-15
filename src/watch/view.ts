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
  RECOVERY_UNAVAILABLE_REASON,
  TRANSFER_UNAVAILABLE_REASON,
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
    lastReport: task.lastReport === undefined ? null : reportView(task.lastReport),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    endedAt: task.endedAt ?? null,
  }
}

export function watchCapability(): WatchCapability {
  return {
    mode: "alert",
    monitoring: "participant-reports-only",
    automaticDetection: "unavailable",
    correction: "unavailable",
    correctionReason: CORRECTION_UNAVAILABLE_REASON,
    delegation: "unavailable",
    transfer: "unavailable",
    recovery: "unavailable",
  }
}

export function watchControls(task: WatchTaskView | null): WatchControls {
  if (task === null) {
    return {
      pause: disabled("no watched task is enrolled for this session"),
      end: disabled("no watched task is enrolled for this session"),
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
