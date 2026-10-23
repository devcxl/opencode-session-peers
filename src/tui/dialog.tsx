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

import { createMemo } from "solid-js"
import { extend } from "@opentui/solid"
import { fg, TextTableRenderable, type TextChunk, type TextTableContent } from "@opentui/core"

import type { TuiPalette } from "../host/tui.ts"
import type { TableCell, Tone, ViewContent } from "./view.ts"
import { viewContent, type RosterState } from "./view.ts"

// The plugin's JSX is created in the TUI's own @opentui/solid (the loader
// resolves the package to it), so this is the catalogue the dialog renders
// from. Registered once at module load, not per dialog.
extend({ text_table: TextTableRenderable })

export interface RosterDialogProps {
  /** The state as it stands now; re-read whenever the feed changes it. */
  readonly state: () => RosterState
  /** The session the dialog is for; its marks are relative to this one. */
  readonly sessionID: string | undefined
  /** The directory that session works in, when the TUI knows the session. */
  readonly sessionDirectory: string | undefined
  /** The palette as it stands now, so a theme switch shows. */
  readonly palette: () => TuiPalette
}

export function RosterDialog(props: RosterDialogProps) {
  const content = createMemo(() =>
    viewContent({
      state: props.state(),
      sessionID: props.sessionID,
      sessionDirectory: props.sessionDirectory,
    }),
  )

  const colour = (tone: Tone) => {
    const palette = props.palette()
    if (tone === "muted") return palette.muted
    if (tone === "error") return palette.error
    return palette.base
  }

  return (
    <box flexDirection="column">
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

/** The table's content: the header row first, then one row per peer. */
function tableContent(view: ViewContent, palette: TuiPalette): TextTableContent {
  return [view.columns, ...view.rows].map((row) => row.map((cell) => cellChunks(cell, palette)))
}

function cellChunks(cell: TableCell, palette: TuiPalette): TextChunk[] {
  const tone = cell.tone
  const colour = tone === "muted" ? palette.muted : tone === "error" ? palette.error : palette.base
  return [fg(colour)(cell.text)]
}
