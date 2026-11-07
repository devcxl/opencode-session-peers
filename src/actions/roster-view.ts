/**
 * Reading the roster for a list action.
 *
 * The two list actions differ only in which peers they show, so what they share
 * lives here: publishing the caller first (so the row the model reads back is
 * one this session will answer to), rendering a row, and turning a refusal into
 * the text the model reads.
 */

import { failure, type ErrorCode } from "../domain/errors.ts"
import type { ActionResult, Peer, SessionID } from "../domain/types.ts"
import type { Roster } from "../peers/roster.ts"

export interface RosterView {
  /** The calling session's own row, as published for this call. */
  readonly self: Peer
  /** Every live peer in this instance's scope, self included. */
  readonly peers: readonly Peer[]
}

export async function readRoster(roster: Roster, caller: SessionID): Promise<RosterView> {
  // The caller's own row says which scope it belongs to; that row is published
  // first, so the scope is the one the session was just moved to, not the one
  // this instance was configured with.
  const published = await roster.publish(caller)
  const { peers } = await roster.report(published.scope)
  return { self: peers.find((peer) => peer.sessionID === caller) ?? published, peers }
}

/**
 * What a row carries into the tool result's details, for a caller that reads them.
 *
 * Absent fields are left out rather than set to `undefined`: opencode 2.0.29
 * never delivers a tool result whose metadata holds an `undefined` value — the
 * call stays running and the model sees no output at all — and `test/fake-host.ts`
 * refuses one, so this cannot come back.
 */
export function peerDetails(peer: Peer, selfID: SessionID): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> = {
    sessionID: peer.sessionID,
    title: peer.title,
    directory: peer.directory,
    self: peer.sessionID === selfID,
  }
  if (peer.model !== undefined) details.model = peer.model
  if (peer.status !== undefined) details.status = peer.status
  if (peer.parentID !== undefined) details.parentID = peer.parentID
  return details
}

export function failed(code: ErrorCode, detail = ""): ActionResult {
  const { reason } = failure(code, detail)
  return { text: reason, details: { code, reason } }
}
