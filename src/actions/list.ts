/**
 * The `list` action.
 *
 * Everything the calling session can address, itself included: the original's
 * split of "Current session" from "Other sessions" is kept, because the model
 * needs the self row to check that it is on the roster at all, and the id
 * prefix is the target it will write back.
 */

import { describeError } from "../domain/errors.ts"
import type { ActionResult } from "../domain/types.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { failed, peerDetails, readRoster, rowFor } from "./roster-view.ts"

export interface ListDeps {
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function listAction(deps: ListDeps, call: ToolCall): Promise<ActionResult> {
  const { roster } = deps
  if (roster === undefined) return failed("E_DISABLED")

  try {
    const view = await readRoster(roster, call.sessionID)
    const selfRow = rowFor(view.self, view, { self: true, sameDirectory: false })
    const others = view.peers
      .filter((peer) => peer.sessionID !== view.self.sessionID)
      .map((peer) =>
        rowFor(peer, view, { self: false, sameDirectory: peer.directory === view.self.directory }),
      )

    return {
      text: [
        "**Current session:**",
        selfRow,
        "",
        // The original's wording: with nobody else connected there is no
        // "Other sessions" block to head.
        others.length > 0 ? `**Other sessions:**\n${others.join("\n")}` : "No other sessions connected.",
      ].join("\n"),
      details: {
        roster: {
          peers: view.peers.map((peer) => peerDetails(peer, call.sessionID)),
          total: view.peers.length,
        },
      },
    }
  } catch (error) {
    return failed("E_NOT_CONNECTED", describeError(error))
  }
}
