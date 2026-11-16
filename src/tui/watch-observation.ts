/**
 * The observation half of the watch panel.
 *
 * It renders the observer's own coarse state and evidence. It does not compute
 * a candidate, compare timestamps to a threshold or turn activity into goal
 * progress: the server's `state` is a fact, the thresholds are only displayed,
 * and the progress row always says that progress is not judged.
 */

import type { WatchPayload } from "../rpc.ts"
import { fact, formatDuration, formatWatchTime, join } from "./watch-format.ts"
import { pageOf, type PageWindow, type TableCell } from "./view.ts"

type Observation = NonNullable<WatchPayload["observation"]>
type Activity = NonNullable<WatchPayload["activity"]>
type Wait = Observation["waits"][number]

export interface ObservationOptions {
  readonly compact?: boolean
  readonly waitPage?: number
  readonly waitPageSize?: number
}

export interface ObservationContent {
  readonly rows: readonly (readonly TableCell[])[]
  readonly notes: readonly string[]
  readonly waitPage: PageWindow
}

export function observationRows(
  payload: WatchPayload,
  options: ObservationOptions = {},
): ObservationContent {
  const compact = options.compact ?? false
  const waitPageSize = options.waitPageSize ?? 4
  const waitPage = waitPageOf(payload, options.waitPage ?? 0, waitPageSize)
  const observation = payload.observation
  const activity = payload.activity

  if (observation === null) {
    return {
      rows: [
        fact("Observation", "unknown — no observation sample"),
        fact("Activity", activityText(activity)),
        fact("Progress", "not judged — activity is not goal progress"),
        fact("Snapshot", "not observed"),
        fact("Wait state", "unknown — no observation sample"),
      ],
      notes: ["No observation sample is available; this is not evidence of idle or of no wait."],
      waitPage,
    }
  }

  const rows: (readonly TableCell[])[] = [
    fact("Observation", observationText(observation, compact)),
    fact("Activity", activityText(activity)),
    fact("Progress", "not judged — activity is not goal progress"),
  ]
  if (!compact || !observation.trusted) rows.push(fact("Snapshot", snapshotText(observation)))
  const emptyWaits =
    observation.waits.length === 0 &&
    !observation.waitsPartial &&
    observation.state !== "normal-waiting" &&
    observation.state !== "blocked" &&
    observation.state !== "unknown" &&
    observation.state !== "unavailable"
  if (!compact || observation.waits.length === 0) {
    if (!compact || !emptyWaits) rows.push(fact("Wait state", waitsSummary(observation)))
  }
  observation.waits
    .slice(waitPage.start, waitPage.start + waitPage.size)
    .forEach((wait, index) => {
      rows.push(fact(`Wait ${waitPage.start + index + 1}`, waitText(wait)))
    })

  const notes: string[] = []
  switch (observation.state) {
    case "idle-candidate":
      notes.push("Sustained idle is a candidate only; this build does not correct or wake the task.")
      break
    case "running-silence":
      notes.push("The task is still running; this is a reminder-only observation, not a progress judgement.")
      break
    case "normal-waiting":
      notes.push("A normal wait is respected; only an overdue wait may remind the initiator.")
      break
    case "blocked":
      notes.push("The task is blocked; no correction or automatic continuation is attempted.")
      break
    case "unknown":
      notes.push("Observation is unknown; no idle or no-wait conclusion is drawn from partial evidence.")
      break
    case "unavailable":
      notes.push("Observation is unavailable here; no idle or no-wait conclusion is drawn.")
      break
    case "active":
      break
  }
  if (observation.waits.some((wait) => wait.status === "overdue")) {
    notes.push("A wait is overdue: only the initiator may be reminded; the task itself is not prompted.")
  }
  if (observation.waitsPartial) {
    notes.push("Wait evidence is partial; the absence of a wait is not proof that none exists.")
  }
  if (observation.waitsTruncated) {
    notes.push("The wait list is truncated; more recorded waits are not shown.")
  }
  const pageNote = waitPageNote(
    waitPage,
    compact && observation.waits.length > 0 ? waitsSummary(observation) : undefined,
  )
  if (pageNote !== undefined) notes.push(pageNote)
  return { rows, notes, waitPage }
}

export function waitPageOf(
  payload: WatchPayload,
  requestedPage: number,
  pageSize: number,
): PageWindow {
  return pageOf(payload.observation?.waits.length ?? 0, pageSize, requestedPage)
}


function waitPageNote(page: PageWindow, summary: string | undefined): string | undefined {
  if (page.count <= 1) return undefined
  const from = page.start + 1
  const to = Math.min(page.total, page.start + page.size)
  const span = from === to ? `wait ${from} of ${page.total}` : `waits ${from}–${to} of ${page.total}`
  const prefix = summary === undefined ? "" : `${summary} · `
  return `${prefix}showing ${span} · ←/→ to page waits`
}

/** Rows a short task pane can spend on waits while keeping trust/controls visible. */
export function waitPageSizeFor(terminalHeight: number): number {
  const rows = Math.floor((terminalHeight - 36) / 2)
  return Math.max(2, Math.min(6, rows))
}

function observationText(observation: Observation, compact: boolean): string {
  const reason = observation.reason ?? "no reason given"
  const trust = compact && observation.trusted ? " · trusted" : ""
  switch (observation.state) {
    case "active":
      return `active${trust}`
    case "idle-candidate":
      return `sustained idle — candidate · idle threshold ${formatDuration(observation.effective.idleMs)}${trust}`
    case "running-silence":
      return `running, no new activity — reminder only · silence threshold ${formatDuration(observation.effective.runningSilentMs)}${trust}`
    case "normal-waiting":
      return `normal waiting · overdue threshold ${formatDuration(observation.effective.waitOverdueMs)}${trust}`
    case "blocked":
      return `blocked${trust}`
    case "unknown":
      return `unknown — ${reason}`
    case "unavailable":
      return `unavailable — ${reason}`
  }
}

function activityText(activity: Activity | null): string {
  if (activity === null) return "unknown — no activity snapshot"
  if (activity.lastAt === null) return "none recorded"
  return join(formatWatchTime(activity.lastAt), activity.kind ?? "activity")
}

function snapshotText(observation: Observation): string {
  const parts: string[] = []
  if (observation.observedAt !== null) parts.push(`observed ${formatWatchTime(observation.observedAt)}`)
  if (observation.baselineAt !== null) parts.push(`baseline ${formatWatchTime(observation.baselineAt)}`)
  if (observation.idleSince !== null) parts.push(`idle since ${formatWatchTime(observation.idleSince)}`)
  parts.push(observation.trusted ? "trusted" : `not trusted — ${observation.reason ?? "no reason given"}`)
  return join(...parts)
}

function waitsSummary(observation: Observation): string {
  if (observation.waits.length === 0) {
    if (observation.waitsPartial) return "incomplete — absence is not proof"
    if (observation.state === "unknown" || observation.state === "unavailable") {
      return "unknown — no reliable wait evidence"
    }
    return "none observed"
  }
  const counts = new Map<string, number>()
  for (const wait of observation.waits) {
    counts.set(wait.status, (counts.get(wait.status) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const status of ["active", "overdue", "cleared", "denied", "unknown"] as const) {
    const count = counts.get(status) ?? 0
    if (count > 0) parts.push(`${count} ${status}`)
  }
  if (observation.waitsPartial) parts.push("partial")
  if (observation.waitsTruncated) parts.push("truncated")
  return parts.join(" · ")
}

function waitText(wait: Wait): string {
  const parts = [
    `${wait.source}: ${wait.object}`,
    wait.reason,
    wait.deadline === null ? "no deadline" : `due ${formatWatchTime(wait.deadline)}`,
    waitStatusText(wait),
  ]
  if (wait.reference !== null) parts.push(`ref ${wait.reference}`)
  return join(...parts)
}

function waitStatusText(wait: Wait): string {
  switch (wait.status) {
    case "active":
      return "active"
    case "overdue":
      return "overdue"
    case "cleared":
      return wait.clearEvidence === null ? "cleared" : `cleared — ${wait.clearEvidence}`
    case "denied":
      return wait.denyEvidence === null ? "denied" : `denied — ${wait.denyEvidence}`
    case "unknown":
      return "unknown"
  }
}
