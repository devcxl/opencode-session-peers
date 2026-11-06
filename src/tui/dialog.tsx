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
import { fg, TextTableRenderable, type TextChunk, type TextTableContent, type TextTableOptions } from "@opentui/core"

import type { TuiPalette } from "../host/tui.ts"
import type { TableCell, Tone, Viewpoint } from "./view.ts"
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

/** One table's look; both tables share it so their columns line up. */
function tableStyle(
  columns: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  palette: TuiPalette,
  measuredWith: readonly (readonly TableCell[])[],
): TextTableOptions {
  return {
    content: tableContent(columns, rows, palette, measuredWith),
    width: "100%",
    columnWidthMode: "full",
    columnFitter: "balanced",
    wrapMode: "word",
    showBorders: true,
    border: true,
    outerBorder: true,
    cellPaddingX: 1,
    columnGap: 2,
    fg: palette.base,
    borderColor: palette.muted,
  }
}

/** The table's content: the header row first, then one row per peer. */
function tableContent(
  columns: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  palette: TuiPalette,
  measuredWith: readonly (readonly TableCell[])[],
): TextTableContent {
  // No rows means no table at all: a header floating over nothing would claim
  // a section the roster does not have.
  if (rows.length === 0) return []
  // Both tables must lay their columns out the same way, or the two sections
  // read as two unrelated tables. They are measured against the same cells, so
  // every column's widest cell is the same in both.
  const widths = sharedWidths(columns, rows, measuredWith)
  return [columns, ...rows].map((row) =>
    row.map((cell, index) => cellChunks(padCell(cell, widths[index] ?? 0), palette)),
  )
}

/** The widest display width of every column, across both tables. */
function sharedWidths(
  columns: readonly TableCell[],
  ...groups: readonly (readonly (readonly TableCell[])[])[]
): readonly number[] {
  return columns.map((column, index) => {
    let width = displayWidth(column.text)
    for (const group of groups) {
      for (const row of group) width = Math.max(width, displayWidth(row[index]?.text ?? ""))
    }
    return width
  })
}

function padCell(cell: TableCell, width: number): TableCell {
  const pad = width - displayWidth(cell.text)
  return pad <= 0 ? cell : { ...cell, text: cell.text + " ".repeat(pad) }
}

function displayWidth(text: string): number {
  return Bun.stringWidth(text)
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
