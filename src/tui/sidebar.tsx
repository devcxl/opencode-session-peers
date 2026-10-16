/** @jsxImportSource @opentui/solid */

/**
 * The sidebar panel.
 *
 * Mounted into `sidebar.content`; every decision about what it shows lives in
 * `view.ts`, so this file only maps lines onto coloured text and asks the port
 * for the one thing the lines need that is not in the payload — the directory
 * the open session works in, which decides the `same dir` mark.
 */

import { For, createMemo, onMount } from "solid-js"

import type { TuiPort } from "../host/tui.ts"
import type { RosterFeed } from "./feed.ts"
import { viewLines, type LineTone } from "./view.ts"

export interface RosterPanelProps {
  readonly port: TuiPort
  readonly feed: RosterFeed
  readonly sessionID: string
}

export function RosterPanel(props: RosterPanelProps) {
  // The view's one call; after it, the plugin's own change events are what
  // keeps the panel current.
  onMount(() => props.feed.open())

  const lines = createMemo(() =>
    viewLines({
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
      <For each={lines()}>
        {(line) => (
          <text fg={colour(line.tone)}>{line.strong === true ? <b>{line.text}</b> : line.text}</text>
        )}
      </For>
    </box>
  )
}
