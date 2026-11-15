/**
 * What the watch panel shows, as a table and a few notes.
 *
 * Everything that decides a cell lives here so it can be read and tested
 * without a terminal. The task pane keeps task state, supervision,
 * authorization, actual capability, owner, attempts and protocol participation
 * in separate rows; the alert pane is a second bounded table in the same
 * dialog and identifies every row by its server alert id.
 *
 * The view renders the answer's own observation, thresholds, wait states,
 * alerts and capability reasons. It does not compute a candidate, judge goal
 * progress or infer that a previous owner stopped.
 */

import type { WatchPayload } from "../rpc.ts"
import {
  ALERT_COLUMNS,
  alertItems,
  alertNotes,
  alertsSummary,
  alertRows,
  selectedAlert,
} from "./watch-alerts.ts"
import { observationRows } from "./watch-observation.ts"
import { cell, ensurePeriod, fact, formatWatchTime, join } from "./watch-format.ts"
import { foldSessionID, type TableCell, type Tone } from "./view.ts"

export type WatchPane = "task" | "alerts"

export type WatchState =
  | { readonly kind: "loading" }
  | { readonly kind: "payload"; readonly payload: WatchPayload }
  /** The plugin answered, but not with a watch payload this build understands. */
  | { readonly kind: "unreadable" }
  /** The call itself failed: no plugin here, no answer, a timeout. */
  | { readonly kind: "failed"; readonly reason: string }

export interface WatchViewInput {
  readonly state: WatchState
  /** The session this panel was opened for. */
  readonly sessionID: string
  readonly pane?: WatchPane
  readonly selectedAlertID?: string
  readonly alertPage?: number
  readonly alertPageSize?: number
}

export interface WatchContent {
  readonly pane: WatchPane
  readonly title: string
  /** Under the title: the target, and the task identity when there is one. */
  readonly contextLines: readonly string[]
  /** The header row; empty when there is no table to show. */
  readonly columns: readonly TableCell[]
  /** One fact per row, in the same order as the columns. */
  readonly rows: readonly (readonly TableCell[])[]
  /** What is left to say: enrollment, pauses, completion, disabled paths. */
  readonly notes: readonly string[]
  readonly noteTone: Tone
}

/** The task table's two columns: a label the reader scans, and its value. */
export const WATCH_COLUMNS: readonly TableCell[] = [
  cell("Field", "muted"),
  cell("Value", "muted"),
]

const TITLE = "Session watch"
const ALERTS_TITLE = "Session watch — alerts"
const UNAVAILABLE = "Session watch is unavailable"

export function watchContent(input: WatchViewInput): WatchContent {
  const pane = input.pane ?? "task"
  switch (input.state.kind) {
    case "loading":
      return {
        pane,
        title: TITLE,
        contextLines: ["reading the watch…"],
        columns: WATCH_COLUMNS,
        rows: [],
        notes: [],
        noteTone: "muted",
      }
    case "failed":
      return unavailable(input.state.reason, pane)
    case "unreadable":
      return unavailable("the answer was not a watch state this view understands", pane)
    case "payload": {
      const payload = input.state.payload
      if (!payload.enabled) {
        return {
          pane,
          title: TITLE,
          contextLines: [],
          columns: [],
          rows: [],
          notes: ["off here: enabled is false, so no watch is shown"],
          noteTone: "muted",
        }
      }
      if (!payload.ledger.available) {
        const reason = payload.ledger.reason ?? "no reason was given"
        return unavailable(
          `Watch ledger unavailable: ${reason}. The current task state could not be read; re-read to verify. No rollback is assumed.`,
          pane,
        )
      }
      if (payload.failure !== null) {
        const failure = payload.failure
        const notes = [`${failure.code}: ${failure.reason}`]
        if (failure.detail !== null) notes.push(`detail: ${failure.detail}`)
        return {
          pane,
          title: UNAVAILABLE,
          contextLines: [],
          columns: [],
          rows: [],
          notes,
          noteTone: "error",
        }
      }
      return pane === "alerts"
        ? alertsContent(payload, input.sessionID, input)
        : taskContent(payload, input.sessionID)
    }
  }
}

function taskContent(payload: WatchPayload, sessionID: string): WatchContent {
  const task = payload.task
  if (task === null) {
    return {
      pane: "task",
      title: TITLE,
      contextLines: [targetLine(sessionID, sessionID)],
      columns: WATCH_COLUMNS,
      rows: [
        fact("Task state", "none enrolled"),
        fact("Authorization", authorizationText(payload.capability.mode)),
        fact("Actual capability", capabilityText(payload.capability)),
        fact("Attempts", "—"),
      ],
      notes: [
        "No watched task is enrolled for this session.",
        `The target is this session; the mode is ${modeName(payload.capability.mode)}.`,
        ...capabilityNotes(payload),
        "enroll: /peers-watch enroll <goal> · esc: close",
      ],
      noteTone: "muted",
    }
  }

  const observation = observationRows(payload)
  const notes: string[] = []
  if (task.participation === "not-seen") {
    notes.push("The executing session has not reported yet; enrollment is not readiness.")
  }
  if (task.watchState === "paused") {
    notes.push(pauseNote(task))
    notes.push(`Resume is unavailable: ${payload.controls.resume.reason ?? "this build cannot resume a watch."}`)
  }
  if (task.ownership === "another-activation") {
    notes.push(
      "This activation is observation-only for automatic supervision; no takeover. It does not infer that the previous owner stopped.",
    )
  }
  if (task.watchState === "ended") {
    if (task.taskState === "completed") {
      notes.push("Completion is recorded; supervision ended.")
    } else {
      notes.push(
        "Supervision ended; this is not a business success. The business task was not reported complete.",
      )
    }
  }
  notes.push(...observation.notes)
  notes.push(...capabilityNotes(payload))
  const canViewAlerts = viewableAlerts(payload)
  const footer = footerFor(payload, task.watchState === "ended", canViewAlerts)
  if (footer !== undefined) notes.push(footer)

  return {
    pane: "task",
    title: TITLE,
    contextLines: taskContextLines(task, sessionID),
    columns: WATCH_COLUMNS,
    rows: [
      fact("Goal", goalText(task.goal)),
      fact("Task state", taskStateText(task.taskState)),
      fact("Supervision", supervisionText(task)),
      ...observation.rows,
      fact("Authorization", authorizationText(task.mode)),
      fact("Actual capability", capabilityText(payload.capability)),
      fact("Owner", ownerText(task.ownership, task.generation)),
      fact("Attempts", attemptsText(task.attempts)),
      fact("Protocol", protocolText(task.participation)),
      fact("Last report", lastReportText(task.lastReport)),
      fact("Result", resultText(task)),
      fact("Alerts", alertsSummary(payload.alerts)),
    ],
    notes,
    noteTone: "muted",
  }
}

function alertsContent(
  payload: WatchPayload,
  sessionID: string,
  input: WatchViewInput,
): WatchContent {
  const task = payload.task
  const contextLines =
    task === null ? [targetLine(sessionID, sessionID)] : taskContextLines(task, sessionID)
  const pageSize = input.alertPageSize ?? 5
  const showAlerts = payload.alerts.available && payload.alerts.total > 0
  const { rows, page } = showAlerts
    ? alertRows(payload.alerts, input.selectedAlertID, input.alertPage ?? 0, pageSize)
    : { rows: [], page: { index: 0, count: 1, size: pageSize, start: 0, total: 0 } }
  const selected = showAlerts
    ? selectedAlert(alertItems(payload.alerts), input.selectedAlertID)
    : undefined
  const notes = alertNotes(payload.alerts, selected, payload.controls, page)
  return {
    pane: "alerts",
    title: ALERTS_TITLE,
    contextLines,
    columns: payload.alerts.available ? ALERT_COLUMNS : [],
    rows,
    notes,
    noteTone: payload.alerts.available ? "muted" : "error",
  }
}

function unavailable(reason: string, pane: WatchPane): WatchContent {
  return {
    pane,
    title: UNAVAILABLE,
    contextLines: [],
    columns: [],
    rows: [],
    notes: [reason],
    noteTone: "error",
  }
}

function targetLine(targetSessionID: string, sessionID: string): string {
  if (targetSessionID === sessionID) {
    return `target: this session (${foldSessionID(sessionID)})`
  }
  return `target: ${foldSessionID(targetSessionID)}`
}

function taskContextLines(
  task: NonNullable<WatchPayload["task"]>,
  sessionID: string,
): readonly string[] {
  const lines = [targetLine(task.targetSessionID, sessionID)]
  if (task.initiatorSessionID !== sessionID) {
    lines.push(`initiator: ${foldSessionID(task.initiatorSessionID)}`)
  }
  lines.push(`task: ${task.taskID} · version ${task.version}`)
  return lines
}

function taskStateText(state: NonNullable<WatchPayload["task"]>["taskState"]): string {
  switch (state) {
    case "not-started":
      return "not started"
    case "in-progress":
      return "in progress"
    case "waiting":
      return "waiting"
    case "blocked":
      return "blocked"
    case "completed":
      return "completed"
  }
}

function supervisionText(task: NonNullable<WatchPayload["task"]>): string {
  switch (task.watchState) {
    case "active":
      return "active"
    case "paused":
      if (task.pause?.kind === "manual") return "paused (manual)"
      if (task.pause?.kind === "safety") return "paused (safety pause)"
      return "paused"
    case "ended":
      return task.taskState === "completed" ? "ended (task completed)" : "ended"
  }
}

function pauseNote(task: NonNullable<WatchPayload["task"]>): string {
  if (task.pause === null) {
    return "Supervision is paused; the business session is not paused, and pausing stops new reminders."
  }
  const kind = task.pause.kind === "safety" ? "safety pause" : "manual"
  return `Supervision is paused (${kind}): ${ensurePeriod(task.pause.reason)} The business session is not paused; pausing stops new reminders.`
}

function attemptsText(attempts: NonNullable<WatchPayload["task"]>["attempts"]): string {
  return `${attempts.used} of ${attempts.limit} used`
}

function ownerText(
  ownership: NonNullable<WatchPayload["task"]>["ownership"],
  generation: number,
): string {
  const who = ownership === "this-instance" ? "this plugin instance" : "another activation"
  return `${who} · generation ${generation}`
}

function protocolText(participation: NonNullable<WatchPayload["task"]>["participation"]): string {
  return participation === "seen"
    ? "seen — a report has been recorded"
    : "not seen — no report yet; enrollment is not readiness"
}

type Report = NonNullable<NonNullable<WatchPayload["task"]>["lastReport"]>

function lastReportText(report: Report | null): string {
  if (report === null) return "—"
  const time = formatWatchTime(report.at)
  const evidence = report.evidence
  switch (report.kind) {
    case "begin":
      return `begin · ${time}`
    case "progress":
      return join("progress", time, evidence.summary, evidence.reference)
    case "waiting": {
      const waited = [
        evidence.waitKind === undefined ? undefined : `for ${evidence.waitKind}:`,
        evidence.waitFor,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ")
      return join("waiting", time, waited, evidence.reason, evidence.reference)
    }
    case "blocked":
      return join("blocked", time, evidence.reason)
    case "completed":
      return `completed · ${time}`
  }
}

function resultText(task: NonNullable<WatchPayload["task"]>): string {
  if (task.taskState !== "completed") return "not reported"
  const report = task.lastReport
  if (report === null || report.kind !== "completed") return "completed · no result evidence was recorded"
  const at = task.completedAt ?? report.at
  return join(report.evidence.summary, report.evidence.reference, formatWatchTime(at))
}

/** A goal can be 2000 characters; a dialog cannot show all of them usefully. */
const GOAL_DISPLAY_LIMIT = 220
const GOAL_SHORTENED = "… (shortened in this panel; the enrolled goal is unchanged)"

function goalText(goal: string): string {
  if (goal.length <= GOAL_DISPLAY_LIMIT) return goal
  return `${goal.slice(0, GOAL_DISPLAY_LIMIT).trimEnd()}${GOAL_SHORTENED}`
}

function authorizationText(mode: WatchPayload["capability"]["mode"]): string {
  return `${modeName(mode)} (the only mode this build offers)`
}

function modeName(mode: WatchPayload["capability"]["mode"]): string {
  switch (mode) {
    case "alert":
      return "alert-only"
  }
}

function capabilityText(capability: WatchPayload["capability"]): string {
  const monitoring = capability.monitoring === "observer-alerts" ? "observer alerts" : capability.monitoring
  const automatic =
    capability.automaticDetection === "partial"
      ? "partial automatic detection"
      : `automatic detection ${capability.automaticDetection}`
  return `${monitoring}; ${automatic}`
}

function capabilityNotes(payload: WatchPayload): string[] {
  const notes: string[] = []
  const capability = payload.capability
  if (capability.automaticDetection === "partial") {
    notes.push(
      `Automatic detection: partial — ${ensurePeriod(capability.automaticDetectionReason)}`,
    )
  }
  if (capability.correction === "unavailable") {
    notes.push(`Correction: unavailable — ${ensurePeriod(capability.correctionReason)}`)
  }
  if (capability.delegation === "unavailable") {
    notes.push(`Child-task enrollment: unavailable — ${ensurePeriod(capability.delegationReason)}`)
  }
  if (capability.transfer === "unavailable" || capability.recovery === "unavailable") {
    notes.push(
      `Ownership transfer and recovery: unavailable — ${ensurePeriod(capability.transferReason)} / ${ensurePeriod(capability.recoveryReason)}`,
    )
  }
  if (capability.safetyPause === "unavailable") {
    notes.push(`Safety pause: unavailable — ${ensurePeriod(capability.safetyPauseReason)}`)
  }
  return notes
}

function footerFor(payload: WatchPayload, ended: boolean, canViewAlerts: boolean): string | undefined {
  const alerts = canViewAlerts ? " · v: alerts" : ""
  if (ended) return `this watch has ended${alerts} · esc: close`
  if (payload.task === null) return "enroll: /peers-watch enroll <goal> · esc: close"
  const pause = payload.controls.pause.enabled
  const end = payload.controls.end.enabled
  if (payload.task.watchState === "paused") {
    return end
      ? `x: end watch · resume unavailable in this build${alerts} · esc: close`
      : `read-only: ${payload.controls.pause.reason ?? "no control is available"}${alerts} · esc: close`
  }
  const parts: string[] = []
  if (pause) parts.push("p: pause watch")
  if (end) parts.push("x: end watch")
  if (canViewAlerts) parts.push("v: alerts")
  parts.push("esc: close")
  return parts.join(" · ")
}

function viewableAlerts(payload: WatchPayload): boolean {
  return payload.task !== null && payload.alerts.available && payload.alerts.total > 0
}
