/**
 * What the sidebar shows, as text.
 *
 * Everything that decides a line lives here, so it can be read and tested
 * without a terminal: the panel component only maps these lines onto coloured
 * `text` elements, and `test/tui-view.test.ts` asserts the lines themselves.
 *
 * The vocabulary is the ticket's: this is a read-only view of one scope, a peer
 * with no live status says `unknown` and why, and an empty view names which of
 * the three reasons it is.
 */

import type { RosterPayload, RosterPeer } from "../rpc.ts"

/** What the panel is showing right now. */
export type RosterState =
  | { readonly kind: "loading" }
  | { readonly kind: "payload"; readonly payload: RosterPayload }
  /** The plugin answered, but not with a roster this build understands. */
  | { readonly kind: "unreadable" }
  /** The call itself failed: no plugin here, no answer, a timeout. */
  | { readonly kind: "failed"; readonly reason: string }

/** How much secondary emphasis a line asks for. */
export type LineTone = "base" | "muted" | "error"

export interface ViewLine {
  readonly text: string
  readonly tone: LineTone
  /** The section's own line: the title, not a row. */
  readonly strong?: true
}

export interface ViewInput {
  readonly state: RosterState
  /** The session whose sidebar this is; only it is marked `this session`. */
  readonly sessionID: string
  /** The directory that session works in, when the TUI knows the session. */
  readonly sessionDirectory: string | undefined
}

export function viewLines(input: ViewInput): readonly ViewLine[] {
  const lines: ViewLine[] = [title(input.state)]

  switch (input.state.kind) {
    case "loading":
      lines.push({ text: "reading the roster…", tone: "muted" })
      return lines
    case "failed":
      lines.push({ text: input.state.reason, tone: "error" })
      return lines
    case "unreadable":
      lines.push({
        text: "the answer was not a roster this view understands",
        tone: "error",
      })
      return lines
    case "payload": {
      const payload = input.state.payload
      if (!payload.enabled) {
        lines.push({ text: "off here: enabled is false, so nothing is published", tone: "muted" })
        return lines
      }
      lines.push({ text: scopeLine(payload.scope), tone: "muted" })
      lines.push({ text: HEADER_LIMIT, tone: "muted" })
      for (const peer of payload.peers) {
        lines.push({ text: peerRow(peer, marksFor(peer, input.sessionID, input.sessionDirectory)), tone: "base" })
      }
      const cause = emptyCause(payload, input.sessionID)
      if (cause !== undefined) lines.push({ text: emptyCauseLine(cause, payload), tone: "muted" })
      return lines
    }
  }
}

/** The header's second line: the reason this list is not the whole machine. */
export const HEADER_LIMIT = "only sessions loading this plugin appear"

function scopeLine(scope: string): string {
  return `scope: ${scope}`
}

function title(state: RosterState): ViewLine {
  if (state.kind === "failed" || state.kind === "unreadable") {
    return { text: "Session peers is unavailable", tone: "base", strong: true }
  }
  return { text: "Session peers", tone: "base", strong: true }
}

export interface RowMarks {
  /** This is the session the sidebar belongs to. */
  readonly self: boolean
  /** The peer works in the same directory as this session. */
  readonly sameDirectory: boolean
}

export function marksFor(
  peer: RosterPeer,
  sessionID: string,
  sessionDirectory: string | undefined,
): RowMarks {
  const self = peer.sessionID === sessionID
  return {
    self,
    // Being the session itself already says where it is; tagging it `same dir`
    // as well would only repeat the row.
    sameDirectory: !self && sessionDirectory !== undefined && peer.directory === sessionDirectory,
  }
}

/**
 * One peer as one line: title, a folded id, where it works, its status, and
 * what it is relative to this session. The whole id is deliberately not here —
 * a row is read at a glance, and `peers list` is where the full id belongs.
 */
export function peerRow(peer: RosterPeer, marks: RowMarks): string {
  const facts = statusFacts(peer)
  const tags: string[] = []
  if (marks.self) tags.push("this session")
  if (marks.sameDirectory) tags.push("same dir")
  const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : ""
  return `• ${peer.title} (${foldSessionID(peer.sessionID)}) — ${peer.directory} (${facts.join(" · ")})${suffix}`
}

/** How many characters of a session id the row keeps. */
const ID_TAIL = 4

export function foldSessionID(sessionID: string): string {
  if (sessionID.length <= ID_TAIL) return sessionID
  return `…${sessionID.slice(-ID_TAIL)}`
}

/**
 * The status facts of a row. A status that is not known is said to be unknown —
 * never rendered as idle — and the reason rides on the same line.
 */
function statusFacts(peer: RosterPeer): readonly string[] {
  if (peer.status !== null) return [peer.status]
  if (peer.statusReason === null) return ["unknown"]
  return ["unknown", peer.statusReason]
}

/** Why this scope has no peer to show. */
export type EmptyCause = "noPeerLoadsPlugin" | "allWentQuiet" | "anotherScope"

/**
 * The cause, or `undefined` when there is a peer to show. A roster holding only
 * this session is empty in the sense that matters: it can reach nobody. The
 * causes are checked in the order that tells the reader the most — peers that
 * existed and went quiet are a different situation from peers that never were
 * and one from peers that are live somewhere else.
 */
export function emptyCause(payload: RosterPayload, sessionID: string): EmptyCause | undefined {
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
