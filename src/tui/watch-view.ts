/**
 * What the watch panel shows, as a table and a few notes.
 *
 * Everything that decides a cell lives here so it can be read and tested
 * without a terminal. The panel draws two columns of facts rather than a wall
 * of prose: task state, supervision, authorization, actual capability, owner,
 * attempts and protocol participation each keep their own row, because this
 * feature must not let one read as another.
 *
 * The view renders the answer's own attempts, pause cause and capability
 * reasons. It does not compute a counter, infer a safety pause or decide that
 * a completed task is over; those are the plugin's facts.
 */

import type { WatchPayload } from "../rpc.ts"
import { foldSessionID, type TableCell, type Tone } from "./view.ts"

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
}

export interface WatchContent {
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

/** The table's two columns: a label the reader scans, and its value. */
export const WATCH_COLUMNS: readonly TableCell[] = [
  cell("Field", "muted"),
  cell("Value", "muted"),
]

const TITLE = "Session watch"
const UNAVAILABLE = "Session watch is unavailable"

export function watchContent(input: WatchViewInput): WatchContent {
  switch (input.state.kind) {
    case "loading":
      return {
        title: TITLE,
        contextLines: ["reading the watch…"],
        columns: WATCH_COLUMNS,
        rows: [],
        notes: [],
        noteTone: "muted",
      }
    case "failed":
      return unavailable(input.state.reason)
    case "unreadable":
      return unavailable("the answer was not a watch state this view understands")
    case "payload": {
      const payload = input.state.payload
      if (!payload.enabled) {
        return {
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
        )
      }
      if (payload.failure !== null) {
        const failure = payload.failure
        const notes = [`${failure.code}: ${failure.reason}`]
        if (failure.detail !== null) notes.push(`detail: ${failure.detail}`)
        return {
          title: UNAVAILABLE,
          contextLines: [],
          columns: [],
          rows: [],
          notes,
          noteTone: "error",
        }
      }
      return taskContent(payload, input.sessionID)
    }
  }
}

function taskContent(payload: WatchPayload, sessionID: string): WatchContent {
  const task = payload.task
  if (task === null) {
    return {
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
  notes.push(...capabilityNotes(payload))
  const footer = footerFor(payload, task.watchState === "ended")
  if (footer !== undefined) notes.push(footer)

  const contextLines = [targetLine(task.targetSessionID, sessionID)]
  if (task.initiatorSessionID !== sessionID) {
    contextLines.push(`initiator: ${foldSessionID(task.initiatorSessionID)}`)
  }
  contextLines.push(`task: ${task.taskID} · version ${task.version}`)

  return {
    title: TITLE,
    contextLines,
    columns: WATCH_COLUMNS,
    rows: [
      fact("Goal", goalText(task.goal)),
      fact("Task state", taskStateText(task.taskState)),
      fact("Supervision", supervisionText(task)),
      fact("Authorization", authorizationText(task.mode)),
      fact("Actual capability", capabilityText(payload.capability)),
      fact("Owner", ownerText(task.ownership, task.generation)),
      fact("Attempts", attemptsText(task.attempts)),
      fact("Protocol", protocolText(task.participation)),
      fact("Last report", lastReportText(task.lastReport)),
      fact("Result", resultText(task)),
    ],
    notes,
    noteTone: "muted",
  }
}

function unavailable(reason: string): WatchContent {
  return {
    title: UNAVAILABLE,
    contextLines: [],
    columns: [],
    rows: [],
    notes: [reason],
    noteTone: "error",
  }
}

function cell(text: string, tone: Tone): TableCell {
  return { text, tone }
}

function fact(label: string, value: string): readonly TableCell[] {
  return [cell(label, "muted"), cell(value, "base")]
}

function targetLine(targetSessionID: string, sessionID: string): string {
  if (targetSessionID === sessionID) {
    return `target: this session (${foldSessionID(sessionID)})`
  }
  return `target: ${foldSessionID(targetSessionID)}`
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

function join(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ")
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
  const monitoring =
    capability.monitoring === "participant-reports-only"
      ? "participant reports only"
      : capability.monitoring
  const automatic =
    capability.automaticDetection === "unavailable"
      ? "no automatic stall detection"
      : `automatic detection ${capability.automaticDetection}`
  return `${monitoring}; ${automatic}`
}

function capabilityNotes(payload: WatchPayload): string[] {
  const notes: string[] = []
  const capability = payload.capability
  if (capability.automaticDetection === "unavailable") {
    notes.push(
      `Automatic detection: unavailable — ${ensurePeriod(capability.automaticDetectionReason)}`,
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

function ensurePeriod(text: string): string {
  const trimmed = text.trim()
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`
}

function footerFor(payload: WatchPayload, ended: boolean): string | undefined {
  if (ended) return "this watch has ended · esc: close"
  if (payload.task === null) return "enroll: /peers-watch enroll <goal> · esc: close"
  const pause = payload.controls.pause.enabled
  const end = payload.controls.end.enabled
  if (payload.task.watchState === "paused") {
    return end
      ? "x: end watch · resume unavailable in this build · esc: close"
      : `read-only: ${payload.controls.pause.reason ?? "no control is available"} · esc: close`
  }
  if (pause && end) return "p: pause watch · x: end watch · esc: close"
  if (pause) return "p: pause watch · esc: close"
  if (end) return "x: end watch · esc: close"
  const reason =
    payload.controls.pause.reason ?? payload.controls.end.reason ?? "no control is available"
  return `read-only: ${reason} · esc: close`
}

/** Timestamps are UTC and stable in tests: the same value in every timezone. */
export function formatWatchTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return "unknown time"
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`
}
