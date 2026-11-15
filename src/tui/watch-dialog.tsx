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
import { GRANT_TERMS, gatePageOf, gatePageSizeFor } from "./watch-correction.ts"
import { waitPageOf, waitPageSizeFor } from "./watch-observation.ts"
import { formatWatchTime } from "./watch-format.ts"
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
  /** Prepare a controlled grant challenge after the explicit review. */
  readonly onGrantPrepare: () => Promise<
    { readonly reviewSummary: string; readonly expiresAt: number } | undefined
  >
  /** Confirm the prepared challenge; the challenge itself stays in the controller. */
  readonly onGrantConfirm: () => Promise<void>
  /** Discard a prepared challenge without any RPC. */
  readonly onGrantCancel: () => void
  /** Downgrade an existing grant to alert-only. */
  readonly onDowngrade: () => Promise<void>
}

type GrantStage = "review" | "confirm" | "downgrade"

type Pending = "pause" | "end"

export function WatchDialog(props: WatchDialogProps) {
  const [pending, setPending] = createSignal<Pending | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [pane, setPane] = createSignal<WatchPane>("task")
  const [selectedAlertID, setSelectedAlertID] = createSignal<string | undefined>()
  const [alertPage, setAlertPage] = createSignal(0)
  const [waitPage, setWaitPage] = createSignal(0)
  const [gatePage, setGatePage] = createSignal(0)
  const [grantStage, setGrantStage] = createSignal<GrantStage | undefined>()
  const [grantSummary, setGrantSummary] = createSignal<string | undefined>()
  const [grantExpiresAt, setGrantExpiresAt] = createSignal<number | undefined>()
  const dimensions = useTerminalDimensions()
  const alertPageSize = createMemo(() => alertPageSizeFor(dimensions().height))
  const waitPageSize = createMemo(() => waitPageSizeFor(dimensions().height))
  const gatePageSize = createMemo(() => gatePageSizeFor(dimensions().height))

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
  // It also discards a prepared grant challenge, which is version-bound.
  createEffect(() => {
    props.state()
    setPending(undefined)
    setGrantStage(undefined)
    props.onGrantCancel()
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

  createEffect(() => {
    const current = payload()
    if (current === undefined) {
      if (waitPage() !== 0) setWaitPage(0)
      return
    }
    const page = waitPageOf(current, waitPage(), waitPageSize())
    if (page.index !== waitPage()) setWaitPage(page.index)
  })

  createEffect(() => {
    const current = payload()
    if (current === undefined) {
      if (gatePage() !== 0) setGatePage(0)
      return
    }
    const page = gatePageOf(current, gatePage(), gatePageSize())
    if (page.index !== gatePage()) setGatePage(page.index)
  })

  const content = createMemo(() =>
    watchContent({
      state: props.state(),
      sessionID: props.sessionID,
      pane: pane(),
      selectedAlertID: selectedAlertID(),
      alertPage: alertPage(),
      alertPageSize: alertPageSize(),
      waitPage: waitPage(),
      waitPageSize: waitPageSize(),
      gatePage: gatePage(),
      gatePageSize: gatePageSize(),
      compact: dimensions().height < 52,
    }),
  )

  const canPause = createMemo(
    () => pane() === "task" && controlEnabled(props.state(), "pause"),
  )
  const canEnd = createMemo(() => pane() === "task" && controlEnabled(props.state(), "end"))
  const canGrant = createMemo(() => {
    const current = payload()
    return (
      pane() === "correction" &&
      current?.task !== undefined &&
      current.task !== null &&
      current.task.correction.controls.grant.enabled
    )
  })
  const canDowngrade = createMemo(() => {
    const current = payload()
    return (
      pane() === "correction" &&
      current?.task !== undefined &&
      current.task !== null &&
      current.task.correction.controls.downgrade.enabled
    )
  })
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
    const stage = grantStage()
    if (stage !== undefined) {
      if (key.name === "y") {
        void actGrant(stage)
        return
      }
      setGrantStage(undefined)
      props.onGrantCancel()
      return
    }
    if (key.name === "c" && payload()?.task != null) {
      setPane((current) => (current === "correction" ? "task" : "correction"))
      setPending(undefined)
      return
    }
    if (key.name === "v" && canViewAlerts() && pane() !== "correction") {
      setPane((current) => (current === "task" ? "alerts" : "task"))
      setPending(undefined)
      return
    }
    if (pane() === "correction") {
      if (key.name === "left" || key.name === "pageup") {
        moveGatePage(-1)
        return
      }
      if (key.name === "right" || key.name === "pagedown") {
        moveGatePage(1)
        return
      }
      if (key.name === "g" && canGrant()) {
        setGrantStage("review")
        return
      }
      if (key.name === "d" && canDowngrade()) {
        setGrantStage("downgrade")
      }
      return
    }
    if (pane() === "task") {
      if (key.name === "left" || key.name === "pageup") {
        moveWaitPage(-1)
        return
      }
      if (key.name === "right" || key.name === "pagedown") {
        moveWaitPage(1)
        return
      }
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

  function moveWaitPage(delta: number): void {
    const current = payload()
    if (current === undefined) return
    const page = waitPageOf(current, waitPage(), waitPageSize())
    const next = Math.max(0, Math.min(page.count - 1, page.index + delta))
    if (next !== waitPage()) setWaitPage(next)
  }

  function moveGatePage(delta: number): void {
    const current = payload()
    if (current === undefined) return
    const page = gatePageOf(current, gatePage(), gatePageSize())
    const next = Math.max(0, Math.min(page.count - 1, page.index + delta))
    if (next !== gatePage()) setGatePage(next)
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

  async function actGrant(stage: GrantStage): Promise<void> {
    setBusy(true)
    try {
      if (stage === "review") {
        const prepared = await props.onGrantPrepare()
        if (prepared === undefined) {
          setGrantStage(undefined)
          return
        }
        setGrantSummary(prepared.reviewSummary)
        setGrantExpiresAt(prepared.expiresAt)
        setGrantStage("confirm")
        return
      }
      if (stage === "confirm") await props.onGrantConfirm()
      else await props.onDowngrade()
      setGrantStage(undefined)
    } finally {
      setBusy(false)
    }
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
    switch (grantStage()) {
      case "review":
        return `${GRANT_TERMS}\ny: prepare challenge · n: cancel`
      case "confirm": {
        const summary = grantSummary()
        const expires = grantExpiresAt()
        const prepared = summary === undefined ? "Challenge prepared." : `Challenge prepared · ${summary}`
        return `${prepared}${expires === undefined ? "" : ` · expires ${formatWatchTime(expires)}`}\ny: confirm · n: cancel`
      }
      case "downgrade":
        return "Downgrade to alert-only? y: downgrade · n: cancel — business work continues; used attempts are not reset."
      case undefined:
        break
    }
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
