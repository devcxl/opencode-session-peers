/** @jsxImportSource @opentui/solid */

/**
 * The watch panel: one task, its bounded alerts, and the controls a person may
 * use. Task and alerts are two panes of the same dialog (`v` switches), so a
 * long alert list does not push the task evidence off the screen.
 *
 * Opening either pane is read-only. Pause and end still take two keys; alert
 * acknowledgement is a single read-only `a` and changes only the unread flag.
 * A state refresh clears a pending pause/end question and re-clamps the alert
 * selection by ID, never by row position.
 */

import { createEffect, createMemo, createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"

import type { TuiPalette } from "../host/tui.ts"
import {
  alertIndex,
  alertItems,
  alertPageSizeFor,
  selectedAlert,
} from "./watch-alerts.ts"
import { watchContent, type WatchPane, type WatchState } from "./watch-view.ts"
import type { Tone } from "./view.ts"
import { colourFor, tableStyle } from "./table.ts"

export interface WatchDialogProps {
  /** The state as it stands now; re-read whenever the feed changes it. */
  readonly state: () => WatchState
  /** The session this panel was opened for. */
  readonly sessionID: string
  /** The palette as it stands now, so a theme switch shows. */
  readonly palette: () => TuiPalette
  /** Pause the task at the version the panel is showing. */
  readonly onPause: (taskID: string, version: number) => Promise<void>
  /** End supervision at the version the panel is showing. */
  readonly onEnd: (taskID: string, version: number) => Promise<void>
  /** Mark one alert read; this must not touch task controls or quota. */
  readonly onAck: (alertID: string) => Promise<void>
}

type Pending = "pause" | "end"

export function WatchDialog(props: WatchDialogProps) {
  const [pending, setPending] = createSignal<Pending | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [pane, setPane] = createSignal<WatchPane>("task")
  const [selectedAlertID, setSelectedAlertID] = createSignal<string | undefined>()
  const [alertPage, setAlertPage] = createSignal(0)
  const dimensions = useTerminalDimensions()
  const alertPageSize = createMemo(() => alertPageSizeFor(dimensions().height))

  const payload = createMemo(() => {
    const state = props.state()
    return state.kind === "payload" ? state.payload : undefined
  })
  const alerts = createMemo(() => payload()?.alerts)
  const items = createMemo(() => {
    const view = alerts()
    return view === undefined ? [] : alertItems(view)
  })
  const canViewAlerts = createMemo(() => {
    const current = payload()
    return (
      current !== undefined &&
      current.task !== null &&
      current.alerts.available &&
      current.alerts.total > 0
    )
  })

  // A newer snapshot invalidates a question asked about an older version.
  createEffect(() => {
    props.state()
    setPending(undefined)
  })

  // Keep selection and page on a real alert id as the bounded list changes.
  createEffect(() => {
    const list = items()
    const current = selectedAlertID()
    if (list.length === 0) {
      if (current !== undefined) setSelectedAlertID(undefined)
      if (alertPage() !== 0) setAlertPage(0)
      return
    }
    const selected = selectedAlert(list, current)
    if (selected === undefined) return
    if (selected.alertID !== current) setSelectedAlertID(selected.alertID)
    const index = alertIndex(list, selected.alertID)
    if (index < 0) return
    const page = Math.floor(index / alertPageSize())
    if (page !== alertPage()) setAlertPage(page)
  })

  createEffect(() => {
    if (pane() === "alerts" && !canViewAlerts()) setPane("task")
  })

  const content = createMemo(() =>
    watchContent({
      state: props.state(),
      sessionID: props.sessionID,
      pane: pane(),
      selectedAlertID: selectedAlertID(),
      alertPage: alertPage(),
      alertPageSize: alertPageSize(),
    }),
  )

  const canPause = createMemo(
    () => pane() === "task" && controlEnabled(props.state(), "pause"),
  )
  const canEnd = createMemo(() => pane() === "task" && controlEnabled(props.state(), "end"))
  const canAck = createMemo(() => {
    if (pane() !== "alerts") return false
    const current = payload()
    const alert = selectedAlert(items(), selectedAlertID())
    return (
      current !== undefined &&
      current.alerts.available &&
      alert !== undefined &&
      alert.state === "unread" &&
      current.controls.acknowledge.enabled
    )
  })

  useKeyboard((key) => {
    if (busy()) return
    const asked = pending()
    if (asked !== undefined) {
      if (key.name === "y") {
        void act(asked)
        return
      }
      // `n`, escape, or any other key drops the question; nothing is sent.
      setPending(undefined)
      return
    }
    if (key.name === "v" && canViewAlerts()) {
      setPane((current) => (current === "task" ? "alerts" : "task"))
      setPending(undefined)
      return
    }
    if (pane() === "task") {
      if (key.name === "p" && canPause()) {
        setPending("pause")
        return
      }
      if (key.name === "x" && canEnd()) {
        setPending("end")
      }
      return
    }

    if (key.name === "up" || key.name === "k") {
      moveSelection(-1)
      return
    }
    if (key.name === "down" || key.name === "j") {
      moveSelection(1)
      return
    }
    if (key.name === "left" || key.name === "pageup") {
      movePage(-1)
      return
    }
    if (key.name === "right" || key.name === "pagedown") {
      movePage(1)
      return
    }
    if (key.name === "a" && canAck()) {
      const alert = selectedAlert(items(), selectedAlertID())
      if (alert === undefined) return
      setBusy(true)
      void props.onAck(alert.alertID).finally(() => setBusy(false))
    }
  })

  function moveSelection(delta: number): void {
    const list = items()
    if (list.length === 0) return
    const current = alertIndex(list, selectedAlertID())
    const index = Math.max(0, Math.min(list.length - 1, current + delta))
    const alert = list[index]
    if (alert === undefined) return
    setSelectedAlertID(alert.alertID)
    setAlertPage(Math.floor(index / alertPageSize()))
  }

  function movePage(delta: number): void {
    const list = items()
    if (list.length === 0) return
    const size = alertPageSize()
    const pages = Math.max(1, Math.ceil(list.length / size))
    const page = Math.max(0, Math.min(pages - 1, alertPage() + delta))
    const start = page * size
    const pageItems = list.slice(start, start + size)
    const next = pageItems.find((alert) => alert.state === "unread") ?? pageItems[0]
    if (next !== undefined) setSelectedAlertID(next.alertID)
    setAlertPage(page)
  }

  async function act(operation: Pending): Promise<void> {
    const state = props.state()
    if (state.kind !== "payload" || state.payload.task === null) return
    const task = state.payload.task
    const control = state.payload.controls[operation]
    if (!control.enabled) {
      setPending(undefined)
      return
    }
    setPending(undefined)
    setBusy(true)
    try {
      if (operation === "pause") await props.onPause(task.taskID, task.version)
      else await props.onEnd(task.taskID, task.version)
    } finally {
      setBusy(false)
    }
  }

  const confirmation = createMemo(() => {
    if (busy()) return "Working…"
    switch (pending()) {
      case "pause":
        return "Pause supervision? y: yes · n: cancel — the business session keeps running."
      case "end": {
        const state = props.state()
        const completed =
          state.kind === "payload" && state.payload.task?.taskState === "completed"
        return completed
          ? "End supervision? y: yes · n: cancel — the task remains recorded as completed."
          : "End supervision? y: yes · n: cancel — this is not a business success and does not stop the session."
      }
      case undefined:
        return ""
    }
  })

  const colour = (tone: Tone) => colourFor(tone, props.palette())

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <text fg={colour("base")}>
        <b>{content().title}</b>
      </text>
      <text fg={colour("muted")}>{content().contextLines.join("\n")}</text>
      <text_table
        style={tableStyle(content().columns, content().rows, props.palette())}
      />
      <text fg={colour("base")}>{confirmation()}</text>
      <text fg={colour(content().noteTone)}>{content().notes.join("\n")}</text>
    </box>
  )
}

function controlEnabled(state: WatchState, operation: Pending): boolean {
  if (state.kind !== "payload" || state.payload.task === null) return false
  return state.payload.controls[operation].enabled
}
