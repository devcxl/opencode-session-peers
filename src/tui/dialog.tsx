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
import { extend, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { fg, TextTableRenderable, type TextChunk, type TextTableContent } from "@opentui/core"

import type { TuiPalette } from "../host/tui.ts"
import type { TableCell, Tone, ViewContent, Viewpoint } from "./view.ts"
import { pageOf, pageSizeFor, viewContent, type RosterState } from "./view.ts"

// The plugin's JSX is created in the TUI's own @opentui/solid (the loader
// resolves the package to it), so this is the catalogue the dialog renders
// from. Registered once at module load, not per dialog.
extend({ text_table: TextTableRenderable })

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
  // The pinned row above the pages costs lines the pages cannot use.
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
    return pageOf(state.payload.peers.length, pageSize(), 0).count - 1
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
      <text_table
        style={{
          content: tableContent(content(), props.palette()),
          width: "100%",
          columnWidthMode: "full",
          columnFitter: "balanced",
          wrapMode: "word",
          showBorders: true,
          border: true,
          outerBorder: true,
          cellPaddingX: 1,
          columnGap: 2,
          fg: props.palette().base,
          borderColor: props.palette().muted,
        }}
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

/** The table's content: the header row first, then one row per peer. */
function tableContent(view: ViewContent, palette: TuiPalette): TextTableContent {
  return [view.columns, ...view.rows].map((row) => row.map((cell) => cellChunks(cell, palette)))
}

function cellChunks(cell: TableCell, palette: TuiPalette): TextChunk[] {
  return [fg(colourFor(cell.tone, palette))(cell.text)]
}

/** The one place tone becomes colour. */
function colourFor(tone: Tone, palette: TuiPalette): TuiPalette["base"] {
  if (tone === "muted") return palette.muted
  if (tone === "error") return palette.error
  return palette.base
}
