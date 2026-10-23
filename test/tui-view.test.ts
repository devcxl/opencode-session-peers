/**
 * What the dialog shows, cell by cell.
 *
 * The dialog only draws these cells, so everything a person would read is
 * asserted here — including the promises the view must not break: a status
 * that is not known is never rendered as idle, and an empty view names which
 * of the three situations it is.
 */

import { describe, expect, test } from "bun:test"

import type { RosterPayload, RosterPeer } from "../src/rpc.ts"
import {
  COLUMNS,
  emptyCause,
  emptyCauseLine,
  foldSessionID,
  HEADER_LIMIT,
  marksFor,
  peerCells,
  statusText,
  viewContent,
  type RosterState,
  type TableCell,
  type ViewContent,
} from "../src/tui/view.ts"

const SELF = "ses_self0000"

function payload(overrides: Partial<RosterPayload> = {}): RosterPayload {
  return {
    enabled: true,
    scope: "default",
    rosterTtlMs: 90_000,
    peers: [],
    quietInScope: 0,
    liveInOtherScopes: 0,
    ...overrides,
  }
}

function peer(overrides: Partial<RosterPeer> & { sessionID: string }): RosterPeer {
  return {
    title: "peer session",
    directory: "/work/alpha",
    status: "idle",
    statusReason: null,
    ...overrides,
  }
}

function content(
  state: RosterState,
  sessionDirectory: string | undefined = undefined,
): ViewContent {
  return viewContent({ state, viewpoint: { sessionID: SELF, directory: sessionDirectory } })
}

function state(overrides: Partial<RosterPayload> = {}): RosterState {
  return { kind: "payload", payload: payload(overrides) }
}

/** The column is what the reader scans; tests read cells by column name. */
const COLUMN_NAMES = ["Session", "ID", "Directory", "Status", "Marks"]

function rowTexts(row: readonly TableCell[]): string[] {
  return row.map((cell) => cell.text)
}

describe("the header", () => {
  test("names the scope and says who can appear", () => {
    expect(HEADER_LIMIT).toBe("only sessions loading this plugin appear")
    const blocks = content(state({ scope: "team-a", peers: [peer({ sessionID: "ses_aaaa1111" })] }))
    expect(blocks.title).toBe("Session peers")
    expect(blocks.contextLines).toEqual(["scope: team-a", HEADER_LIMIT])
  })

  test("puts one fact per column, in a fixed order", () => {
    expect(COLUMNS.map((cell) => cell.text)).toEqual(COLUMN_NAMES)
    const blocks = content(state({ peers: [peer({ sessionID: "ses_aaaa1111" })] }))
    expect(blocks.columns).toEqual(COLUMNS)
    for (const row of blocks.rows) expect(row).toHaveLength(COLUMN_NAMES.length)
  })
})

describe("a row", () => {
  test("carries the title, a folded id, the directory, the status and its marks", () => {
    const row = peerCells(
      peer({
        sessionID: "ses_aaaa1111",
        title: "Payments API",
        directory: "/work/alpha",
        status: "busy",
      }),
      { self: true, sameDirectory: false },
    )
    expect(rowTexts(row)).toEqual([
      "Payments API",
      "…1111",
      "/work/alpha",
      "busy",
      "this session",
    ])
  })

  test("keeps only the tail of the session id", () => {
    expect(foldSessionID("ses_aaaa1111")).toBe("…1111")
    // Too short to fold: shown as it is, because there is nothing to hide.
    expect(foldSessionID("s1")).toBe("s1")
  })

  test("renders a status it does not have as unknown with the reason, never as idle", () => {
    const status = statusText(
      peer({
        sessionID: "ses_bbbb2222",
        title: "Docs site",
        directory: "/work/beta",
        status: null,
        statusReason: "not seen running since this instance started",
      }),
    )
    expect(status).toBe("unknown · not seen running since this instance started")
    expect(status).not.toContain("idle")

    // No reason to give: it says unknown, and nothing more.
    expect(statusText(peer({ sessionID: "ses_bbbb2222", status: null, statusReason: null }))).toBe(
      "unknown",
    )
  })

  test("marks this session and the peers that share its directory", () => {
    const here = { sessionID: SELF, directory: "/work/alpha" }
    expect(marksFor(peer({ sessionID: SELF }), here)).toEqual({
      self: true,
      sameDirectory: false,
    })
    expect(marksFor(peer({ sessionID: "ses_b" }), here)).toEqual({
      self: false,
      sameDirectory: true,
    })
    expect(marksFor(peer({ sessionID: "ses_c", directory: "/work/beta" }), here)).toEqual({
      self: false,
      sameDirectory: false,
    })
    // The TUI does not know the session: nothing is claimed about its directory.
    expect(marksFor(peer({ sessionID: "ses_b" }), { sessionID: SELF, directory: undefined })).toEqual({
      self: false,
      sameDirectory: false,
    })
    // The TUI has no session open: nothing is claimed about this session either.
    expect(marksFor(peer({ sessionID: "ses_b" }), { sessionID: undefined, directory: undefined })).toEqual(
      {
        self: false,
        sameDirectory: false,
      },
    )
  })

  test("draws the marks in their own column", () => {
    const blocks = content(
      state({
        peers: [
          peer({ sessionID: SELF, title: "This one", directory: "/work/alpha" }),
          peer({ sessionID: "ses_b", title: "Sibling", directory: "/work/alpha" }),
          peer({ sessionID: "ses_c", title: "Far away", directory: "/work/beta" }),
        ],
      }),
      "/work/alpha",
    )
    const marksColumn = COLUMN_NAMES.indexOf("Marks")
    const marks = blocks.rows.map((row) => rowTexts(row)[marksColumn])
    expect(marks).toEqual(["this session", "same dir", ""])
  })
})

describe("an empty view", () => {
  test("separates the three causes", () => {
    expect(emptyCause(payload(), SELF)).toBe("noPeerLoadsPlugin")
    expect(emptyCause(payload({ quietInScope: 2 }), SELF)).toBe("allWentQuiet")
    expect(emptyCause(payload({ liveInOtherScopes: 3 }), SELF)).toBe("anotherScope")
    // Peers that existed and went quiet say more than peers somewhere else.
    expect(emptyCause(payload({ quietInScope: 1, liveInOtherScopes: 3 }), SELF)).toBe("allWentQuiet")
  })

  test("is not empty while another session is on it", () => {
    expect(emptyCause(payload({ peers: [peer({ sessionID: "ses_b" })] }), SELF)).toBeUndefined()
    // This session alone still means nobody to reach.
    expect(emptyCause(payload({ peers: [peer({ sessionID: SELF })] }), SELF)).toBe(
      "noPeerLoadsPlugin",
    )
  })

  test("names the cause, with the TTL it measured against", () => {
    expect(emptyCauseLine("noPeerLoadsPlugin", payload())).toBe(
      "No peer in this scope loads the plugin.",
    )
    expect(emptyCauseLine("allWentQuiet", payload({ quietInScope: 2 }))).toBe(
      "Every peer in this scope went quiet: 2 records with no heartbeat within the last 90s.",
    )
    expect(emptyCauseLine("allWentQuiet", payload({ quietInScope: 1, rosterTtlMs: 120_000 }))).toBe(
      "Every peer in this scope went quiet: 1 record with no heartbeat within the last 2m.",
    )
    expect(emptyCauseLine("anotherScope", payload({ liveInOtherScopes: 1 }))).toBe(
      "No peer in this scope is live; 1 live session in another scope.",
    )
    expect(emptyCauseLine("anotherScope", payload({ liveInOtherScopes: 4 }))).toBe(
      "No peer in this scope is live; 4 live sessions in another scope.",
    )
  })

  test("puts the cause among the notes, and leaves it off when a peer is there", () => {
    const alone = content(state({ quietInScope: 1 }))
    expect(alone.rows).toEqual([])
    expect(alone.notes).toEqual([emptyCauseLine("allWentQuiet", payload({ quietInScope: 1 }))])
    expect(alone.noteTone).toBe("muted")

    const accompanied = content(state({ peers: [peer({ sessionID: "ses_b" })] }))
    expect(accompanied.rows).toHaveLength(1)
    expect(accompanied.notes).toEqual([])
  })
})

describe("the other states", () => {
  test("says it is reading, before the first answer", () => {
    expect(content({ kind: "loading" })).toEqual({
      title: "Session peers",
      contextLines: ["reading the roster…"],
      columns: COLUMNS,
      rows: [],
      notes: [],
      noteTone: "muted",
    })
  })

  test("reports a failed call with its reason instead of an old roster", () => {
    const blocks = content({ kind: "failed", reason: "RPC is unavailable: session-peers.v1" })
    expect(blocks.title).toBe("Session peers is unavailable")
    expect(blocks.notes).toEqual(["RPC is unavailable: session-peers.v1"])
    expect(blocks.noteTone).toBe("error")
    // No table: there is nothing this build would put in one.
    expect(blocks.columns).toEqual([])
    expect(blocks.rows).toEqual([])
  })

  test("refuses to render an answer it does not understand", () => {
    const blocks = content({ kind: "unreadable" })
    expect(blocks.title).toBe("Session peers is unavailable")
    expect(blocks.notes).toEqual(["the answer was not a roster this view understands"])
    expect(blocks.noteTone).toBe("error")
  })

  test("renders a disabled plugin as off, not as an empty roster", () => {
    const blocks = content(state({ enabled: false, peers: [peer({ sessionID: "ses_b" })] }))
    expect(blocks.contextLines).toEqual([])
    expect(blocks.columns).toEqual([])
    expect(blocks.rows).toEqual([])
    expect(blocks.notes).toEqual(["off here: enabled is false, so nothing is published"])
    // No cause is named: the plugin is off, which is not a fact about peers.
  })
})
