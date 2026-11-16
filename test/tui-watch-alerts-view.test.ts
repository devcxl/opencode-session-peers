/**
 * Alert-pane content: stable identities, read/unread/resolved state, real
 * bounded counts, page markers and honest unavailable/empty states. The
 * controller and dialog tests cover acknowledgement and keyboard interaction.
 */

import { describe, expect, test } from "bun:test"

import { readWatchPayload, type WatchPayload } from "../src/rpc.ts"
import { ALERT_COLUMNS } from "../src/tui/watch-alerts.ts"
import { watchContent, type WatchContent } from "../src/tui/watch-view.ts"
import { SELF, alert, alertsView, payload, task } from "./tui-watch-fake.ts"

function state(overrides: Partial<WatchPayload> = {}): { readonly kind: "payload"; readonly payload: WatchPayload } {
  return { kind: "payload", payload: payload(overrides) }
}

function content(current: ReturnType<typeof state>, sessionID = SELF): WatchContent {
  return watchContent({ state: current, sessionID })
}

function valueOf(blocks: WatchContent, field: string): string | undefined {
  return blocks.rows.find((row) => row[0]?.text === field)?.[1]?.text
}

describe("alerts in the task pane", () => {
  test("summarises real counts and offers the alert pane without inventing rows", () => {
    const blocks = content(
      state({
        task: task(),
        alerts: alertsView([
          alert({ alertID: "alert_0001", state: "unread" }),
          alert({
            alertID: "alert_0002",
            state: "read",
            resolvedAt: Date.UTC(2026, 10, 16, 4, 40, 0),
          }),
        ]),
      }),
    )
    expect(valueOf(blocks, "Alerts")).toBe("1 unread · 1 active · 2 recorded · 1 resolved")
    expect(blocks.notes.join("\n")).toContain("v: alerts")
  })

  test("says alerts are unavailable instead of claiming none", () => {
    const blocks = content(
      state({
        task: task(),
        alerts: alertsView([], {
          available: false,
          reason: "the alert store is locked",
          unread: 0,
          total: 0,
          active: 0,
        }),
      }),
    )
    expect(valueOf(blocks, "Alerts")).toBe("unavailable — the alert store is locked")
    expect(blocks.notes.join("\n")).not.toContain("v: alerts")
  })
})

describe("the alert pane", () => {
  const alerts = alertsView([
    alert({ alertID: "alert_0001", summary: "Idle problem" }),
    alert({
      alertID: "alert_0002",
      state: "read",
      readAt: Date.UTC(2026, 10, 16, 4, 35, 0),
      resolvedAt: Date.UTC(2026, 10, 16, 4, 36, 0),
      summary: "Resolved problem",
    }),
  ])

  test("shows stable identities, read/resolved state and a plain next step", () => {
    const blocks = watchContent({
      state: state({ task: task(), alerts }),
      sessionID: SELF,
      pane: "alerts",
      selectedAlertID: "alert_0002",
      alertPageSize: 5,
    })
    expect(blocks.pane).toBe("alerts")
    expect(blocks.title).toBe("Session watch — alerts")
    expect(blocks.columns).toEqual(ALERT_COLUMNS)
    expect(blocks.rows).toHaveLength(2)
    const row = blocks.rows[1]!
    expect(row[0]?.text).toContain("> …0002")
    expect(row[1]?.text).toBe("sustained idle")
    expect(row[2]?.text).toBe("read · resolved")
    expect(blocks.notes.join("\n")).toContain("Summary: Resolved problem")
    expect(blocks.notes.join("\n")).toContain("Next:")
    expect(blocks.notes.join("\n")).toContain("does not resume, retry or reset")
  })

  test("de-duplicates rows by alert id while keeping the server counts", () => {
    const duplicates = alertsView([
      alert({ alertID: "alert_0001", summary: "first text" }),
      alert({ alertID: "alert_0001", summary: "updated text" }),
    ])
    const blocks = watchContent({
      state: state({ task: task(), alerts: duplicates }),
      sessionID: SELF,
      pane: "alerts",
      alertPageSize: 5,
    })
    expect(blocks.rows).toHaveLength(1)
    expect(blocks.notes.join("\n")).toContain(
      "The bounded alert list shows 1 of 2 recorded alerts",
    )
  })

  test("distinguishes a known blocked task from unknown observation", () => {
    const current = state({
      alerts: alertsView([
        alert({ alertID: "alert_blocked", kind: "blocked", summary: "The task is blocked." }),
        alert({ alertID: "alert_unknown", kind: "observation-unknown" }),
      ]),
    })
    expect(readWatchPayload(current.payload)).toBeDefined()
    const blocks = watchContent({ state: current, sessionID: SELF, pane: "alerts" })
    expect(blocks.rows[0]?.[1]?.text).toBe("task blocked")
    expect(blocks.rows[1]?.[1]?.text).toBe("observation unknown")
  })

  test("pages with the server's bounded counts and marks the selected row", () => {
    const many = alertsView(
      Array.from({ length: 6 }, (_, index) =>
        alert({ alertID: `alert_${String(index + 1).padStart(4, "0")}` }),
      ),
    )
    const blocks = watchContent({
      state: state({ task: task(), alerts: many }),
      sessionID: SELF,
      pane: "alerts",
      selectedAlertID: "alert_0003",
      alertPage: 0,
      alertPageSize: 3,
    })
    expect(blocks.rows.map((row) => row[0]?.text)).toEqual(["  …0001", "  …0002", "> …0003"])
    expect(blocks.notes.join("\n")).toContain("page 1 of 2 · alerts 1–3 of 6")
  })

  test("shows an empty or unavailable alert list honestly", () => {
    const empty = watchContent({
      state: state({ task: task(), alerts: alertsView([]) }),
      sessionID: SELF,
      pane: "alerts",
    })
    expect(empty.rows).toEqual([])
    expect(empty.notes.join("\n")).toContain("No alerts are recorded for this task.")

    const unavailable = watchContent({
      state: state({
        task: task(),
        alerts: alertsView([], {
          available: false,
          reason: "the alert store is locked",
          unread: 0,
          total: 0,
          active: 0,
        }),
      }),
      sessionID: SELF,
      pane: "alerts",
    })
    expect(unavailable.noteTone).toBe("error")
    expect(unavailable.notes.join("\n")).toContain(
      "Alerts unavailable — the alert store is locked.",
    )
    expect(unavailable.notes.join("\n")).not.toContain("No alerts are recorded")
  })
})

describe("alert summaries", () => {
  test("alerts with no rows and no truncation do not offer the alert pane", () => {
    const blocks = content(state({ task: task(), alerts: alertsView([]) }))
    expect(valueOf(blocks, "Alerts")).toBe("none recorded")
    expect(blocks.notes.join("\n")).not.toContain("v: alerts")
  })

  test("a truncated alert count is not hidden", () => {
    const blocks = content(
      state({
        task: task(),
        alerts: alertsView([alert({ alertID: "alert_0001" })], {
          truncated: true,
          total: 9,
          active: 9,
          unread: 9,
        }),
      }),
    )
    expect(valueOf(blocks, "Alerts")).toBe("9 unread · 9 active · 9 recorded · list truncated")
    expect(blocks.notes.join("\n")).toContain("v: alerts")
  })
})
