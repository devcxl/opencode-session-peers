/**
 * The alert half of the watch panel.
 *
 * Alerts are identified by `alertID`, never by their wording. A bounded list
 * may be truncated; the footer and summary report the server's real counts
 * instead of inventing the missing history. Reading an alert is only a read
 * flag change: the next step is plain text and this view never fetches a
 * reference or offers a correction.
 */

import type { WatchPayload } from "../rpc.ts"
import { cell, formatWatchTime } from "./watch-format.ts"
import { foldSessionID, pageOf, type PageWindow, type TableCell, type Tone } from "./view.ts"

type AlertsView = WatchPayload["alerts"]
type Alert = AlertsView["items"][number]
type Controls = WatchPayload["controls"]

export const ALERT_COLUMNS: readonly TableCell[] = [
  cell("Alert", "muted"),
  cell("Problem", "muted"),
  cell("State", "muted"),
  cell("Updated", "muted"),
]

export function alertItems(alerts: AlertsView): readonly Alert[] {
  const byID = new Map<string, Alert>()
  for (const alert of alerts.items) byID.set(alert.alertID, alert)
  return [...byID.values()]
}

export function selectedAlert(items: readonly Alert[], selectedID: string | undefined): Alert | undefined {
  if (selectedID !== undefined) {
    const found = items.find((alert) => alert.alertID === selectedID)
    if (found !== undefined) return found
  }
  return items.find((alert) => alert.state === "unread") ?? items[0]
}

export function alertIndex(items: readonly Alert[], selectedID: string | undefined): number {
  const selected = selectedAlert(items, selectedID)
  return selected === undefined ? -1 : items.findIndex((alert) => alert.alertID === selected.alertID)
}

/** Rows for one page, with the selected row marked; selection is by stable ID. */
export function alertRows(
  alerts: AlertsView,
  selectedID: string | undefined,
  requestedPage = 0,
  pageSize = 5,
): { readonly rows: readonly (readonly TableCell[])[]; readonly page: PageWindow } {
  const items = alertItems(alerts)
  const page = pageOf(items.length, pageSize, requestedPage)
  const selected = selectedAlert(items, selectedID)
  const rows = items.slice(page.start, page.start + page.size).map((alert) => {
    const isSelected = selected !== undefined && alert.alertID === selected.alertID
    const resolved = alert.resolvedAt !== null
    const tone: Tone = alert.state === "read" || resolved ? "muted" : "base"
    return [
      cell(`${isSelected ? ">" : " "} ${foldSessionID(alert.alertID)}`, isSelected ? "base" : tone),
      cell(alertKindText(alert.kind), tone),
      cell(alertStateText(alert), tone),
      cell(formatWatchTime(alert.updatedAt), "muted"),
    ]
  })
  return { rows, page }
}

export function alertsSummary(alerts: AlertsView): string {
  if (!alerts.available) return `unavailable — ${alerts.reason ?? "no reason given"}`
  if (alerts.total === 0) return "none recorded"
  const parts = [`${alerts.unread} unread`, `${alerts.active} active`, `${alerts.total} recorded`]
  const resolved = alerts.total - alerts.active
  if (resolved > 0) parts.push(`${resolved} resolved`)
  if (alerts.truncated) parts.push("list truncated")
  return parts.join(" · ")
}

export function alertNotes(
  alerts: AlertsView,
  selected: Alert | undefined,
  controls: Controls,
  page: PageWindow,
): string[] {
  if (!alerts.available) {
    return [`Alerts unavailable — ${alerts.reason ?? "no reason given"}.`, "v: task · esc: close"]
  }
  if (alerts.total === 0) {
    return ["No alerts are recorded for this task.", "v: task · esc: close"]
  }
  const notes: string[] = []
  if (selected === undefined) {
    notes.push(`The bounded alert list contains no rows; ${alerts.total} alerts are recorded.`)
  } else {
    notes.push(`Summary: ${selected.summary}`)
    notes.push(`Reason: ${selected.reason}`)
    notes.push(`Next: ${selected.nextStep}`)
    if (selected.resolvedAt !== null) {
      notes.push("This alert is resolved; its history remains visible.")
    }
    if (selected.state === "read") {
      notes.push("This alert is already read.")
    }
  }
  notes.push("Marking read changes only the unread flag; it does not resume, retry or reset the watch.")
  const unique = alertItems(alerts).length
  if (alerts.truncated || unique < alerts.total) {
    notes.push(
      `The bounded alert list shows ${unique} of ${alerts.total} recorded alerts; the counts above still describe all of them.`,
    )
  }
  if (!controls.acknowledge.enabled) {
    notes.push(`Mark read unavailable: ${controls.acknowledge.reason ?? "no reason given"}.`)
  }
  const pageNote = alertPageNote(page)
  if (pageNote !== undefined) notes.push(pageNote)
  notes.push(alertFooter(alerts, selected, controls, page))
  return notes
}

export function alertFooter(
  alerts: AlertsView,
  selected: Alert | undefined,
  controls: Controls,
  page: PageWindow,
): string {
  const parts: string[] = []
  if (!alerts.available) return "v: task · esc: close"
  if (selected !== undefined && alerts.total > 0) {
    if (!controls.acknowledge.enabled) {
      parts.push(`read-only: ${controls.acknowledge.reason ?? "acknowledgement is unavailable"}`)
    } else if (selected.state === "unread") {
      parts.push("a: mark selected alert read")
    } else {
      parts.push("selected alert is already read")
    }
    parts.push("↑/↓ select")
    if (page.count > 1) parts.push("←/→ page")
  }
  parts.push("v: task · esc: close")
  return parts.join(" · ")
}

export function alertPageNote(page: PageWindow): string | undefined {
  if (page.count <= 1) return undefined
  const from = page.start + 1
  const to = Math.min(page.total, page.start + page.size)
  const span = from === to ? `alert ${from} of ${page.total}` : `alerts ${from}–${to} of ${page.total}`
  return `page ${page.index + 1} of ${page.count} · ${span} · ←/→ to page`
}

/** Fixed chrome plus two lines per alert; bounded so the footer stays visible. */
export function alertPageSizeFor(terminalHeight: number): number {
  const rows = Math.floor((terminalHeight - 14) / 2)
  return Math.max(3, Math.min(8, rows))
}

export function alertKindText(kind: Alert["kind"]): string {
  switch (kind) {
    case "idle":
      return "sustained idle"
    case "running-silent":
      return "running silence"
    case "wait-overdue":
      return "wait overdue"
    case "observation-unknown":
      return "observation unknown"
    case "approval-rejected":
      return "approval rejected"
  }
}

export function alertStateText(alert: Alert): string {
  return alert.resolvedAt === null ? alert.state : `${alert.state} · resolved`
}
