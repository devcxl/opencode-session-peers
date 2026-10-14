/**
 * Turning what the model wrote into a peer.
 *
 * The order — exact session id, then a case-insensitive exact title, then an id
 * prefix — is ported from pi-intercom: in particular every step fails closed on
 * more than one match instead of picking one, because guessing a recipient is
 * how a message ends up in the wrong session.
 */

import type { Peer, SessionID } from "./types.ts"

export type MatchKind = "id" | "title" | "id-prefix"

export type Resolution =
  | { kind: "resolved"; peer: Peer; matchedBy: MatchKind }
  | { kind: "self" }
  | { kind: "ambiguous"; candidates: readonly Peer[] }
  | { kind: "not-found" }

export function resolvePeer(target: string, peers: readonly Peer[], selfID: SessionID): Resolution {
  const wanted = target.trim()
  if (wanted.length === 0) return { kind: "not-found" }
  if (wanted === selfID) return { kind: "self" }

  const byID = peers.find((peer) => peer.sessionID === wanted)
  if (byID !== undefined) return { kind: "resolved", peer: byID, matchedBy: "id" }

  const wantedLower = wanted.toLowerCase()
  const byTitle = peers.filter((peer) => peer.title.toLowerCase() === wantedLower)
  if (byTitle.length === 1) return { kind: "resolved", peer: byTitle[0]!, matchedBy: "title" }
  if (byTitle.length > 1) return { kind: "ambiguous", candidates: byTitle }

  const byPrefix = peers.filter((peer) => peer.sessionID.startsWith(wanted))
  if (byPrefix.length === 1) return { kind: "resolved", peer: byPrefix[0]!, matchedBy: "id-prefix" }
  if (byPrefix.length > 1) return { kind: "ambiguous", candidates: byPrefix }

  return { kind: "not-found" }
}

/**
 * The shortest prefix of `id` that no other peer shares, so a roster can show
 * something short enough to type without ever showing an ambiguous one.
 */
export function shortestUniquePrefix(id: SessionID, peers: readonly Peer[], minimum = 8): string {
  const others = peers.filter((peer) => peer.sessionID !== id).map((peer) => peer.sessionID)
  for (let length = Math.max(minimum, 1); length < id.length; length += 1) {
    const candidate = id.slice(0, length)
    if (!others.some((other) => other.startsWith(candidate))) return candidate
  }
  return id
}
