/**
 * The sweep that keeps plugin storage from growing forever.
 *
 * It rides the roster's heartbeat instead of owning a timer: one scan when a
 * fresh instance starts — so a machine that has been idle for days still cleans
 * up — and one per beat after that. A sweep never makes its caller fail: a
 * record that cannot be removed is worth a warning, not an error, because the
 * records it was reclaiming were already ignored by every reader.
 */

import type { Config } from "../config.ts"
import { reclaimable } from "../domain/reclaim.ts"
import { removeIfStill, type PluginStorage } from "../host/storage.ts"

export interface SweepDeps {
  readonly storage: PluginStorage
  readonly config: Config
  readonly now: number
}

export interface SweepReport {
  readonly reclaimed: number
  readonly failures: number
}

export async function reclaimStale(deps: SweepDeps): Promise<SweepReport> {
  const { storage, config, now } = deps
  let reclaimed = 0
  let failures = 0

  const rosterStale = (updatedAt: number): boolean =>
    reclaimable(updatedAt + config.rosterTtlMs, now, config.rosterTtlMs)

  for (const { value: peer } of await storage.peers.list()) {
    if (!rosterStale(peer.updatedAt)) continue
    try {
      if (await removeIfStill(storage.peers, peer.sessionID, (current) => rosterStale(current.updatedAt))) {
        reclaimed += 1
      }
    } catch {
      failures += 1
    }
  }

  for (const { value: ask } of await storage.asks.list()) {
    // The ask's own lifetime is what its margin scales with, so changing the
    // configured timeout never makes an old record look young.
    if (!reclaimable(ask.expiresAt, now, ask.expiresAt - ask.createdAt)) continue
    try {
      await removeIfStill(storage.asks, ask.askID, (current) =>
        reclaimable(current.expiresAt, now, current.expiresAt - current.createdAt),
      )
      // The reply shares the ask's expiry, and that ask is stale by ten
      // lifetimes, so no asker is still waiting on the slot it would fill.
      await removeIfStill(storage.replies, ask.askID, () => true)
      reclaimed += 1
    } catch {
      failures += 1
    }
  }

  return { reclaimed, failures }
}
