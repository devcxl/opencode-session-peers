/**
 * What the dialog shows, as a table.
 *
 * Everything that decides a cell lives here, so it can be read and tested
 * without a terminal: the dialog component only maps these cells onto the
 * host's table renderable and its colours, and `test/tui-view.test.ts` asserts
 * the cells themselves.
 *
 * The vocabulary is the ticket's: this is a read-only view of one scope, a peer
 * with no live status says `unknown` and why, and an empty view names which of
 * the three reasons it is.
 */

import type { RosterPayload, RosterPeer } from "../rpc.ts"

/** What the dialog is showing right now. */
export type RosterState =
  | { readonly kind: "loading" }
  | { readonly kind: "payload"; readonly payload: RosterPayload }
  /** The plugin answered, but not with a roster this build understands. */
  | { readonly kind: "unreadable" }
  /** The call itself failed: no plugin here, no answer, a timeout. */
  | { readonly kind: "failed"; readonly reason: string }

/** How much secondary emphasis a cell asks for. */
export type Tone = "base" | "muted" | "error"

/**
 * The session the view is read from: what `this session` and `same dir` are
 * relative to. `directory` is `undefined` when the TUI does not know the
 * session, and then nothing is claimed about directories at all.
 */
export interface Viewpoint {
  readonly sessionID: string | undefined
  readonly directory: string | undefined
}

/** One cell of the table: its text, and how much it stands out. */
export interface TableCell {
  readonly text: string
  readonly tone: Tone
}

/**
 * The dialog's content, as the four stable blocks it draws.
 *
 * Four blocks rather than free composition because of what the host repaints:
 * an element whose *content* changes is redrawn, while inserting or removing
 * elements was measured not to reach the screen on its own (measured in a
 * slot; the dialog keeps the same shape rather than re-testing it). So the
 * dialog keeps its elements and changes only what the blocks say — a table
 * with no content draws nothing.
 */
export interface ViewContent {
  /** The dialog's own line: what this table is. */
  readonly title: string
  /** Under the title: the scope, and why the table is not the whole machine. */
  readonly contextLines: readonly string[]
  /** The header row; empty when there is no table to show. */
  readonly columns: readonly TableCell[]
  /** The peers on this page, one row each, in the same order as the columns. */
  readonly rows: readonly (readonly TableCell[])[]
  /** What is left to say: the empty cause, a refusal, a broken answer. */
  readonly notes: readonly string[]
  readonly noteTone: Tone
}

export interface ViewInput {
  readonly state: RosterState
  /** The session the dialog is for; its marks are relative to this one. */
  readonly viewpoint: Viewpoint
  /**
   * Which page of peers to show, 0-based. It is clamped: a roster that shrinks
   * under the reader falls back to a page that exists rather than showing none.
   */
  readonly page?: number
  /** How many peers one page holds; omitted means every peer on one page. */
  readonly pageSize?: number
}

export function viewContent(input: ViewInput): ViewContent {
  switch (input.state.kind) {
    case "loading":
      return {
        title: "Session peers",
        contextLines: ["reading the roster…"],
        columns: COLUMNS,
        rows: [],
        notes: [],
        noteTone: "muted",
      }
    case "failed":
      return {
        title: "Session peers is unavailable",
        contextLines: [],
        columns: [],
        rows: [],
        notes: [input.state.reason],
        noteTone: "error",
      }
    case "unreadable":
      return {
        title: "Session peers is unavailable",
        contextLines: [],
        columns: [],
        rows: [],
        notes: ["the answer was not a roster this view understands"],
        noteTone: "error",
      }
    case "payload": {
      const payload = input.state.payload
      if (!payload.enabled) {
        return {
          title: "Session peers",
          contextLines: [],
          columns: [],
          rows: [],
          notes: ["off here: enabled is false, so nothing is published"],
          noteTone: "muted",
        }
      }
      const page = pageOf(payload.peers.length, input.pageSize, input.page)
      const cause = emptyCause(payload, input.viewpoint.sessionID)
      const notes: string[] = []
      if (cause !== undefined) notes.push(emptyCauseLine(cause, payload))
      const paging = pageNote(page)
      if (paging !== undefined) notes.push(paging)
      return {
        title: "Session peers",
        contextLines: [scopeLine(payload.scope), HEADER_LIMIT],
        columns: COLUMNS,
        rows: payload.peers
          .slice(page.start, page.start + page.size)
          .map((peer) => peerCells(peer, marksFor(peer, input.viewpoint))),
        notes,
        noteTone: "muted",
      }
    }
  }
}

function cell(text: string, tone: Tone): TableCell {
  return { text, tone }
}

/** The header row: one column per fact, one fact per column. */
export const COLUMNS: readonly TableCell[] = [
  cell("Session", "muted"),
  cell("ID", "muted"),
  cell("Directory", "muted"),
  cell("Status", "muted"),
  cell("Marks", "muted"),
]

/** The header's second line: the reason this table is not the whole machine. */
export const HEADER_LIMIT = "only sessions loading this plugin appear"

function scopeLine(scope: string): string {
  return `scope: ${scope}`
}

/**
 * One page of the roster: where it starts, how many peers it holds, and which
 * page of how many it is. `index` is clamped to the pages that exist, so a
 * reader who paged deep and a roster that shrank never combine into a blank
 * page; an empty roster still has the one page it is shown on.
 */
export interface PageWindow {
  /** 0-based page shown. */
  readonly index: number
  /** How many pages the roster has; at least one. */
  readonly count: number
  /** How many peers one page holds. */
  readonly size: number
  /** 0-based position of the page's first peer in the roster. */
  readonly start: number
  /** How many peers the roster has in total. */
  readonly total: number
}

export function pageOf(total: number, size: number | undefined, requested = 0): PageWindow {
  const pageSize = size === undefined || size < 1 ? Math.max(1, total) : size
  const count = Math.max(1, Math.ceil(total / pageSize))
  const index = Math.min(count - 1, Math.max(0, Math.trunc(requested) || 0))
  return { index, count, size: pageSize, start: index * pageSize, total }
}

/**
 * The line under the table that says where the reader is. There is nothing to
 * say when everything fits on one page.
 */
export function pageNote(page: PageWindow): string | undefined {
  if (page.count <= 1) return undefined
  const from = page.start + 1
  const to = Math.min(page.total, page.start + page.size)
  const span = from === to ? `peer ${from} of ${page.total}` : `peers ${from}–${to} of ${page.total}`
  return `page ${page.index + 1} of ${page.count} · ${span} · ←/→ to page`
}

/** The smallest page worth paging. */
const MIN_PAGE_SIZE = 3

/** Past this, a page is harder to scan than it is to flip. */
const MAX_PAGE_SIZE = 16

/**
 * Lines the dialog spends on everything but the peer rows: the host's chrome,
 * the title, the scope lines, the table's frame and header, and the page
 * footer.
 */
const FIXED_LINES = 11

/**
 * Lines one peer row takes. A directory is an absolute path and a status can
 * carry its reason, so the table wraps; the line under each row separates it
 * from the next. Counting one line per peer would put the last rows, and the
 * page footer, past the bottom of the screen.
 */
const LINES_PER_PEER = 3

/**
 * How many peers fit in one page of the dialog on a terminal this tall. The
 * host sizes the dialog to its content, so a page that is too tall loses its
 * bottom rows instead of scrolling; the page is sized to fit the screen.
 */
export function pageSizeFor(terminalHeight: number): number {
  const peers = Math.floor((terminalHeight - FIXED_LINES) / LINES_PER_PEER)
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, peers))
}

export interface RowMarks {
  /** This is the session the dialog is for. */
  readonly self: boolean
  /** The peer works in the same directory as that session. */
  readonly sameDirectory: boolean
}

export function marksFor(peer: RosterPeer, viewpoint: Viewpoint): RowMarks {
  const self = viewpoint.sessionID !== undefined && peer.sessionID === viewpoint.sessionID
  return {
    self,
    // Being the session itself already says where it is; tagging it `same dir`
    // as well would only repeat the row.
    sameDirectory: !self && viewpoint.directory !== undefined && peer.directory === viewpoint.directory,
  }
}

/**
 * One peer as one row: what it is called, a folded id, where it works, what it
 * is doing, and what it is relative to this session. The whole id is
 * deliberately not here — a row is read at a glance, and `peers list` is where
 * the full id belongs.
 */
export function peerCells(peer: RosterPeer, marks: RowMarks): readonly TableCell[] {
  return [
    cell(peer.title, "base"),
    cell(foldSessionID(peer.sessionID), "muted"),
    cell(peer.directory, "base"),
    cell(statusText(peer), "base"),
    cell(marksText(marks), "muted"),
  ]
}

/** How many characters of a session id the row keeps. */
const ID_TAIL = 4

export function foldSessionID(sessionID: string): string {
  if (sessionID.length <= ID_TAIL) return sessionID
  return `…${sessionID.slice(-ID_TAIL)}`
}

/**
 * The status cell. A status that is not known is said to be unknown — never
 * rendered as idle — and the reason rides in the same cell.
 */
export function statusText(peer: RosterPeer): string {
  if (peer.status !== null) return peer.status
  if (peer.statusReason === null) return "unknown"
  return `unknown · ${peer.statusReason}`
}

function marksText(marks: RowMarks): string {
  const tags: string[] = []
  if (marks.self) tags.push("this session")
  if (marks.sameDirectory) tags.push("same dir")
  return tags.join(", ")
}

/** Why this scope has no peer to show. */
export type EmptyCause = "noPeerLoadsPlugin" | "allWentQuiet" | "anotherScope"

/**
 * The cause, or `undefined` when there is a peer to show. A roster holding only
 * the session itself is empty in the sense that matters: it can reach nobody.
 * The causes are checked in the order that tells the reader the most — peers
 * that existed and went quiet are a different situation from peers that never
 * were and one from peers that are live somewhere else.
 */
export function emptyCause(
  payload: RosterPayload,
  sessionID: string | undefined,
): EmptyCause | undefined {
  if (payload.peers.some((peer) => peer.sessionID !== sessionID)) return undefined
  if (payload.quietInScope > 0) return "allWentQuiet"
  if (payload.liveInOtherScopes > 0) return "anotherScope"
  return "noPeerLoadsPlugin"
}

export function emptyCauseLine(cause: EmptyCause, payload: RosterPayload): string {
  switch (cause) {
    case "noPeerLoadsPlugin":
      return "No peer in this scope loads the plugin."
    case "allWentQuiet":
      return `Every peer in this scope went quiet: ${count(payload.quietInScope, "record")} with no heartbeat within the last ${formatDuration(payload.rosterTtlMs)}.`
    case "anotherScope":
      return `No peer in this scope is live; ${count(payload.liveInOtherScopes, "live session")} in another scope.`
  }
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}
