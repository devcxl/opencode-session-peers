/**
 * The host table both dialogs draw with.
 *
 * The dialog chrome belongs to the host; this module only turns the view's
 * cells into the `text_table` renderable the host's own markdown tables use.
 * `extend` registers that renderable once, when either dialog module loads, not
 * per dialog.
 */

import { extend } from "@opentui/solid"
import {
  fg,
  TextTableRenderable,
  type TextChunk,
  type TextTableContent,
  type TextTableOptions,
} from "@opentui/core"

import type { TuiPalette } from "../host/tui.ts"
import type { TableCell, Tone } from "./view.ts"

// The plugin's JSX is created in the TUI's own @opentui/solid (the loader
// resolves the package to it), so this is the catalogue the dialogs render
// from. Registered once at module load.
extend({ text_table: TextTableRenderable })

/** One table's look. `measuredWith` lets two tables share their column widths. */
export function tableStyle(
  columns: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  palette: TuiPalette,
  measuredWith: readonly (readonly TableCell[])[] = rows,
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

/** The table's content: the header row first, then one row per fact. */
function tableContent(
  columns: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  palette: TuiPalette,
  measuredWith: readonly (readonly TableCell[])[],
): TextTableContent {
  // No rows means no table at all: a header floating over nothing would claim
  // a section the view does not have.
  if (rows.length === 0) return []
  // Both tables must lay their columns out the same way, or two sections read
  // as two unrelated tables. They are measured against the same cells, so
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
export function colourFor(tone: Tone, palette: TuiPalette): TuiPalette["base"] {
  if (tone === "muted") return palette.muted
  if (tone === "error") return palette.error
  return palette.base
}
