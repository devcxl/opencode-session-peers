/**
 * The RPC surface's answer.
 *
 * One read of the roster, in the shape `src/rpc.ts` documents. The roster's own
 * rules — scope, TTL, ordering — stay in `peers/roster.ts`: this module only
 * selects what a reader may see and names the shape, so the roster dialog and
 * the `peers list` tool cannot resolve different sets.
 */

import type { Config } from "./config.ts"
import type { Peer } from "./domain/types.ts"
import type { Roster } from "./peers/roster.ts"
import type { RosterPayload, RosterPeer } from "./rpc.ts"

/**
 * Why a row's status is not known: the answering instance builds every row it
 * publishes from what it has seen itself, so a record adopted from storage — a
 * session idle since the instance that served it was replaced — has no status
 * until that session is seen again.
 */
const STATUS_UNKNOWN = "not seen running since this instance started"

export interface RosterSurfaceDeps {
  readonly config: Config
  /** Absent exactly when the plugin is disabled: then nothing was published either. */
  readonly roster?: Roster
  /**
   * The session the reader is about. Its own scope is the answer's `scope`, so
   * a session moved with `/peers-scope` is read from where it now belongs.
   */
  readonly sessionID?: string
  /** A scope to read instead of that session's own: the dialog's preview. */
  readonly scope?: string
}

export async function rosterPayload(deps: RosterSurfaceDeps): Promise<RosterPayload> {
  const { config, roster, sessionID, scope: preview } = deps
  const sessionScope =
    sessionID === undefined || roster === undefined
      ? config.scope
      : await roster.scopeOf(sessionID)
  const shown = preview ?? sessionScope
  const facts = { scope: shown, sessionScope, rosterTtlMs: config.rosterTtlMs }

  // A disabled location still answers, with `enabled: false`: a reader can then
  // tell "off here" from "not loaded here" (`rpc.unavailable`).
  if (roster === undefined) {
    return { enabled: false, ...facts, peers: [], quietInScope: 0, liveInOtherScopes: 0 }
  }

  const report = await roster.report(shown)
  return {
    enabled: true,
    ...facts,
    peers: report.peers.map(peerPayload),
    quietInScope: report.quietInScope,
    liveInOtherScopes: report.liveInOtherScopes,
  }
}

function peerPayload(peer: Peer): RosterPeer {
  return {
    sessionID: peer.sessionID,
    title: peer.title,
    directory: peer.directory,
    // `null`, never absent: the schema requires both fields, and a reader must
    // not have to guess whether a missing status means "unknown" or "not sent".
    status: peer.status ?? null,
    statusReason: peer.status === undefined ? STATUS_UNKNOWN : null,
  }
}
