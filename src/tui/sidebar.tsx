/** @jsxImportSource @opentui/solid */

/**
 * The sidebar panel.
 *
 * Mounted into `sidebar.content`; every decision about what it shows lives in
 * `view.ts`, so this file only draws the four blocks the view produces and asks
 * the port for the one thing the blocks need that is not in the payload — the
 * directory the open session works in, which decides the `same dir` mark.
 *
 * The blocks are drawn as four `text` elements, each with a fixed place, and
 * only their content changes: measured, inserting or removing elements inside a
 * plugin's slot did not reach the screen on its own.
 *
 * Measured as well: a later state only reaches the screen when the host
 * repaints the sidebar (the capture that verified this view nudged the pty to
 * make it draw); the panel itself cannot ask for more than the state it keeps.
 */

import { createMemo, onCleanup, onMount } from "solid-js"

import type { TuiPort } from "../host/tui.ts"
import type { RosterFeed } from "./feed.ts"
import { viewContent, type LineTone } from "./view.ts"

/**
 * How often the view re-reads even when nothing has been announced. Events are
 * live-only and measured to arrive in milliseconds, but they can be missed —
 * a dropped event would otherwise freeze the panel forever — so this is the
 * floor under them, at one request a minute, not the mechanism.
 */
const REFRESH_MS = 60_000

export interface RosterPanelProps {
  readonly port: TuiPort
  readonly feed: RosterFeed
  readonly sessionID: string
}

export function RosterPanel(props: RosterPanelProps) {
  // The view's one call; after it, the plugin's own change events are what
  // keeps the panel current.
  onMount(() => {
    props.feed.open()
    const timer = setInterval(() => props.feed.open(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  const content = createMemo(() =>
    viewContent({
      state: props.feed.state(),
      sessionID: props.sessionID,
      sessionDirectory: props.port.sessionDirectory(props.sessionID),
    }),
  )

  const colour = (tone: LineTone) => {
    const palette = props.port.palette()
    if (tone === "muted") return palette.muted
    if (tone === "error") return palette.error
    return palette.base
  }

  return (
    <box flexDirection="column">
      <text fg={colour("base")}>
        <b>{content().title}</b>
      </text>
      <text fg={colour("muted")}>{content().context.join("\n")}</text>
      <text fg={colour("base")}>{content().rows.join("\n")}</text>
      <text fg={colour(content().noteTone)}>{content().notes.join("\n")}</text>
    </box>
  )
}
