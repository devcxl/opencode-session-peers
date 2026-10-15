/**
 * The `list-cwd` action: only the peers working in this session's directory.
 *
 * The original also takes a `cwd` parameter to look into another directory and
 * opens a Herdr pane when nobody is there; panes are out of scope, and the
 * caller's own directory is the one a session can speak about, so that is the
 * filter. The header names the directory because the same rows mean different
 * things in a different directory.
 */

import { describeError } from "../domain/errors.ts"
import type { ActionResult } from "../domain/types.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { failed, peerDetails, readRoster, rowFor } from "./roster-view.ts"

export interface ListCwdDeps {
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function listCwdAction(deps: ListCwdDeps, call: ToolCall): Promise<ActionResult> {
  const { roster } = deps
  if (roster === undefined) return failed("E_DISABLED")

  try {
    const view = await readRoster(roster, call.sessionID)
    const directory = view.self.directory
    // No "same cwd" tag: the header already says every row is in this cwd.
    const here = view.peers.filter(
      (peer) => peer.sessionID !== view.self.sessionID && peer.directory === directory,
    )
    const rows = here.map((peer) => rowFor(peer, view, { self: false, sameDirectory: false }))

    return {
      text:
        here.length === 0
          ? "No other sessions in this directory."
          : [`**Other sessions (cwd: ${directory}):**`, ...rows].join("\n"),
      details: {
        roster: {
          peers: here.map((peer) => peerDetails(peer, call.sessionID)),
          total: here.length,
          cwd: directory,
        },
      },
    }
  } catch (error) {
    return failed("E_NOT_CONNECTED", describeError(error))
  }
}
