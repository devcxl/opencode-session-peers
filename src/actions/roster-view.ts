/**
 * Reading the roster for a list action.
 *
 * The two list actions differ only in which peers they show, so what they share
 * lives here: publishing the caller first (so the row the model reads back is
 * one this session will answer to), rendering a row with an id prefix that is
 * unique among the rows in view, and turning a refusal into the text the model
 * reads.
 */

import { shortestUniquePrefix } from "../domain/addressing.ts"
import { failure, type ErrorCode } from "../domain/errors.ts"
import { rosterRow } from "../domain/format.ts"
import type { ActionResult, Peer, SessionID } from "../domain/types.ts"
import type { Roster } from "../peers/roster.ts"

export interface RosterView {
  /** The calling session's own row, as published for this call. */
  readonly self: Peer
  /** Every live peer in this instance's scope, self included. */
  readonly peers: readonly Peer[]
}

export async function readRoster(roster: Roster, caller: SessionID): Promise<RosterView> {
  const published = await roster.publish(caller)
  const peers = await roster.live()
  return { self: peers.find((peer) => peer.sessionID === caller) ?? published, peers }
}

/** The row the model reads. The prefix is unique among the rows in view. */
export function rowFor(peer: Peer, view: RosterView, tags: { self: boolean; sameDirectory: boolean }): string {
  return rosterRow(peer, { ...tags, prefix: shortestUniquePrefix(peer.sessionID, view.peers) })
}

/** What a row carries into the tool result's details, for a caller that reads them. */
export function peerDetails(peer: Peer, selfID: SessionID): Readonly<Record<string, unknown>> {
  return {
    sessionID: peer.sessionID,
    title: peer.title,
    directory: peer.directory,
    model: peer.model,
    status: peer.status,
    parentID: peer.parentID,
    self: peer.sessionID === selfID,
  }
}

export function failed(code: ErrorCode, detail = ""): ActionResult {
  const { reason } = failure(code, detail)
  return { text: reason, details: { code, reason } }
}
