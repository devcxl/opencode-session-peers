/**
 * Reclaiming records that outlived their owner.
 *
 * Nothing deletes a record when its owner dies uncleanly — a SIGKILL, a crash,
 * a reboot, a session deleted while no instance was listening — so stale keys
 * accumulate: ignored by every reader, but still scanned by each one, so the
 * cost of a roster read grows with the number of records ever written rather
 * than the number of live peers.
 *
 * The rule is deliberately timid. A record must be expired by a wide margin
 * before it is worth deleting, because the two mistakes are not symmetrical:
 * keeping one too long costs a slightly larger scan, while deleting one that is
 * merely late makes a live peer vanish from the roster of everyone who reads it.
 */

/** How many record lifetimes past expiry a key must sit before it is reclaimed. */
export const RECLAIM_MARGIN = 10

/**
 * `expiredAt` is when the record stopped being valid and `lifetimeMs` is how
 * long it was valid for, so the margin scales with the thing being reclaimed
 * instead of being a second number to keep in sync with the first.
 */
export function reclaimable(expiredAt: number, now: number, lifetimeMs: number): boolean {
  return now - expiredAt > lifetimeMs * RECLAIM_MARGIN
}
