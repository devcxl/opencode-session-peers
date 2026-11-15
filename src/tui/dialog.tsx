/** @jsxImportSource @opentui/solid */

/**
 * The dialog content: the roster as a table.
 *
 * The dialog chrome belongs to the host — this component draws the four blocks
 * `view.ts` produces inside it: the title, the context lines, the table, and
 * the notes. The table is the host's own `TextTableRenderable`, the same one
 * the host's markdown tables draw with; `extend` adds it to the component
 * catalogue that the plugin's JSX is created in.
 *
 * Measured: an element whose *content* changes is redrawn, while inserting or
 * removing elements was not reliably redrawn on its own (measured in the
 * former sidebar panel's slot; the dialog keeps the same shape rather than
 * re-testing it). So this draws its four elements always and changes only what
 * they say — a table whose content is empty draws nothing at all.
 */

import { createMemo, createSignal } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"

import type { TuiPalette } from "../host/tui.ts"
import type { Tone, Viewpoint } from "./view.ts"
import { pageOf, pageSizeFor, viewContent, type RosterState } from "./view.ts"
import { colourFor, tableStyle } from "./table.ts"

export interface RosterDialogProps {
  /** The state as it stands now; re-read whenever the feed changes it. */
  readonly state: () => RosterState
  /** The session the dialog is for; its marks are relative to this one. */
  readonly viewpoint: Viewpoint
  /** The palette as it stands now, so a theme switch shows. */
  readonly palette: () => TuiPalette
  /**
   * Reads another scope, or the session's own when `undefined` is passed. The
   * dialog asks; the feed decides when the answer replaces the state.
   */
  readonly onScope: (scope: string | undefined) => void
}

export function RosterDialog(props: RosterDialogProps) {
  // Starts at the first page on every opening: the dialog is a fresh view of
  // the roster, not a resumption of the last read.
  const [page, setPage] = createSignal(0)
  const dimensions = useTerminalDimensions()
  // The pinned table above the pages costs lines the pages cannot use.
  const pinnedSelf = createMemo(() => {
    const state = props.state()
    if (state.kind !== "payload" || !state.payload.enabled) return false
    const selfID = props.viewpoint.sessionID
    return selfID !== undefined && state.payload.peers.some((peer) => peer.sessionID === selfID)
  })
  // A page is what the terminal can show without spilling past the screen; it
  // is re-read on resize so the page keeps fitting.
  const pageSize = createMemo(() => pageSizeFor(dimensions().height, pinnedSelf()))

  const lastPage = createMemo(() => {
    const state = props.state()
    if (state.kind !== "payload" || !state.payload.enabled) return 0
    // Pages hold the peers below this session's table, not this session's row.
    const selfID = props.viewpoint.sessionID
    const others = state.payload.peers.filter((peer) => peer.sessionID !== selfID)
    return pageOf(others.length, pageSize(), 0).count - 1
  })

  useKeyboard((key) => {
    if (key.name === "g") {
      const state = props.state()
      if (state.kind !== "payload" || state.payload.sessionScope === "default") return
      setPage(0)
      props.onScope(state.payload.scope === state.payload.sessionScope ? "default" : undefined)
      return
    }
    const step = pageStep(key.name)
    if (step === undefined) return
    // Clamped here too, so a roster that shrank under a deep page still moves
    // on the very next key rather than needing one press per missing page.
    setPage((current) => Math.max(0, Math.min(lastPage(), current + step)))
  })

  const content = createMemo(() =>
    viewContent({
      state: props.state(),
      viewpoint: props.viewpoint,
      page: page(),
      pageSize: pageSize(),
    }),
  )

  const colour = (tone: Tone) => colourFor(tone, props.palette())

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <text fg={colour("base")}>
        <b>{content().title}</b>
      </text>
      <text fg={colour("muted")}>{content().contextLines.join("\n")}</text>
      {/* Two tables, not one with a divider row: this session sits in a table
          of its own above the peers, so the break is the table's own border. */}
      <text_table
        style={tableStyle(content().columns, content().selfRows, props.palette(), content().rows)}
      />
      {/* A blank line between the two tables, and nothing at all when there is
          no first table to separate from. */}
      <text>{content().selfRows.length > 0 ? " " : ""}</text>
      <text_table
        style={tableStyle(content().columns, content().rows, props.palette(), content().selfRows)}
      />
      <text fg={colour(content().noteTone)}>{content().notes.join("\n")}</text>
    </box>
  )
}

/**
 * The keys that flip pages. They are read from the renderer's key stream while
 * the dialog is mounted; the dialog owns no text input, so nothing else here
 * can be typing.
 */
function pageStep(name: string): number | undefined {
  if (name === "left" || name === "pageup") return -1
  if (name === "right" || name === "pagedown") return 1
  return undefined
}
