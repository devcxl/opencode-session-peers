/** @jsxImportSource @opentui/solid */

/**
 * The watch panel: one task, its facts, and the two controls a person may use.
 *
 * The panel keeps the same shape as the roster dialog: a title, context lines,
 * one host table, a confirmation line and the notes. Measured in the host, an
 * element whose content changes is redrawn while inserting or removing an
 * element was not reliable, so the confirmation line is always present and
 * empty when there is nothing to confirm.
 *
 * Opening the panel is read-only. Pause and end each take two keys because
 * neither stops the business session: `p` or `x` asks, `y` confirms, `n`
 * cancels. A state refresh clears a pending question rather than acting on a
 * version the user no longer sees.
 */

import { createEffect, createMemo, createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"

import type { TuiPalette } from "../host/tui.ts"
import { watchContent, type WatchState } from "./watch-view.ts"
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
}

type Pending = "pause" | "end"

export function WatchDialog(props: WatchDialogProps) {
  const [pending, setPending] = createSignal<Pending | undefined>()
  const [busy, setBusy] = createSignal(false)

  // A newer snapshot invalidates a question asked about an older version.
  createEffect(() => {
    props.state()
    setPending(undefined)
  })

  const content = createMemo(() =>
    watchContent({ state: props.state(), sessionID: props.sessionID }),
  )

  const canPause = createMemo(() => controlEnabled(props.state(), "pause"))
  const canEnd = createMemo(() => controlEnabled(props.state(), "end"))

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
    if (key.name === "p" && canPause()) {
      setPending("pause")
      return
    }
    if (key.name === "x" && canEnd()) {
      setPending("end")
    }
  })

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
      case "end":
        return "End supervision? y: yes · n: cancel — this is not a business success and does not stop the session."
      case undefined:
        return ""
    }
  })

  const colour = (tone: "base" | "muted" | "error") => colourFor(tone, props.palette())

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
