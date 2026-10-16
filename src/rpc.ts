/**
 * The plugin's RPC surface, as the TUI half and any other plugin sees it.
 *
 * A server plugin cannot be read by a TUI plugin any other supported way: no
 * route exposes plugin storage, and the plugin's own events are live-only
 * (`docs/research/tui-surface-data-path.md` §3, §5). So this definition is part
 * of the public surface — it ships through the package's `./rpc` export, is
 * versioned in its id, and carries no import of plugin internals, so a consumer
 * can depend on the shape below without depending on this build's wiring.
 *
 * The shape, as of `session-peers.v1`:
 *
 *   method `roster`, input `{}`, output:
 *     {
 *       enabled: boolean          // false: the plugin is off at the answering
 *                                 // location, which is not an empty roster
 *       scope: string             // the visibility partition the rows were
 *                                 // resolved in, named by the header
 *       rosterTtlMs: number       // how long a record is trusted without a
 *                                 // heartbeat; rows are already filtered by it
 *       peers: RosterPeer[]       // every live peer in scope, in `peers list`
 *                                 // order (directory, title, id)
 *       quietInScope: number      // in-scope records whose heartbeat stopped:
 *                                 // the peers that went quiet
 *       liveInOtherScopes: number // live records in another scope: sessions
 *                                 // this view cannot reach
 *     }
 *
 *   event `changed`, data `{ at: number }`: the roster this definition's handler
 *   answers from may have changed, so a reader should take a fresh snapshot.
 *   It is a nudge, not a value: the snapshot is always the truth, and events are
 *   live-only, so a reader that starts late must snapshot rather than wait.
 *
 * The method is registered even when the plugin is disabled, so a reader can
 * tell "off here" from "not loaded here" (`rpc.unavailable`).
 *
 * A `RosterPeer` is a wire shape, not `domain/types.ts`'s `Peer`: it carries
 * what a reader renders and nothing else — no instance id, no timestamps.
 */

import type { Rpc } from "@opencode/plugin"

export const SESSION_PEERS_RPC_ID = "session-peers.v1"

/** One peer, as the view reads it. */
export interface RosterPeer {
  readonly sessionID: string
  /** Session title; the name peers address each other by. */
  readonly title: string
  readonly directory: string
  /** The last status the answering instance saw, or `null` when it has none. */
  readonly status: string | null
  /** Why the status is not known; `null` exactly when `status` is known. */
  readonly statusReason: string | null
}

/** The answer to one `roster` call. */
export interface RosterPayload {
  readonly enabled: boolean
  readonly scope: string
  readonly rosterTtlMs: number
  readonly peers: readonly RosterPeer[]
  readonly quietInScope: number
  readonly liveInOtherScopes: number
}

const peerSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    title: { type: "string" },
    directory: { type: "string" },
    status: { type: ["string", "null"] },
    statusReason: { type: ["string", "null"] },
  },
  required: ["sessionID", "title", "directory", "status", "statusReason"],
  additionalProperties: false,
} as const

export const SESSION_PEERS_RPC = {
  id: SESSION_PEERS_RPC_ID,
  methods: {
    roster: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          scope: { type: "string" },
          rosterTtlMs: { type: "number" },
          peers: { type: "array", items: peerSchema },
          quietInScope: { type: "number" },
          liveInOtherScopes: { type: "number" },
        },
        required: [
          "enabled",
          "scope",
          "rosterTtlMs",
          "peers",
          "quietInScope",
          "liveInOtherScopes",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { at: { type: "number" } },
        required: ["at"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

/**
 * Reads an RPC answer as a payload, or `undefined` when it is not one.
 *
 * The transport hands the answer back as `unknown` — a plain JSON Schema is
 * validated by the host, but nothing types the result on the calling side — and
 * a view that renders a malformed answer as if it were a roster would be lying
 * about what it knows. A reader shows this as its own "not understood" state.
 */
export function readRosterPayload(value: unknown): RosterPayload | undefined {
  const payload = asRecord(value)
  if (payload === undefined) return undefined
  const { enabled, scope, rosterTtlMs, peers, quietInScope, liveInOtherScopes } = payload
  if (typeof enabled !== "boolean" || typeof scope !== "string" || typeof rosterTtlMs !== "number") {
    return undefined
  }
  if (typeof quietInScope !== "number" || typeof liveInOtherScopes !== "number") return undefined
  if (!Array.isArray(peers)) return undefined

  const rows: RosterPeer[] = []
  for (const candidate of peers) {
    const peer = readRosterPeer(candidate)
    if (peer === undefined) return undefined
    rows.push(peer)
  }
  return { enabled, scope, rosterTtlMs, peers: rows, quietInScope, liveInOtherScopes }
}

function readRosterPeer(value: unknown): RosterPeer | undefined {
  const peer = asRecord(value)
  if (peer === undefined) return undefined
  const { sessionID, title, directory, status, statusReason } = peer
  if (typeof sessionID !== "string" || typeof title !== "string" || typeof directory !== "string") {
    return undefined
  }
  if (!isStringOrNull(status) || !isStringOrNull(statusReason)) return undefined
  return { sessionID, title, directory, status, statusReason }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}
