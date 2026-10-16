/**
 * The roster: the rendezvous that makes peers visible to each other.
 *
 * A plugin instance is created per project directory, with its own module
 * instance, and module-level state dies with it
 * (`docs/research/plugin-instance-scoping.md` §1). The one namespace every
 * instance on the machine shares is plugin storage, so a session's row is
 * published there: the instance that serves a session writes one record per
 * session, refreshes it on a heartbeat, and reads the whole registry back —
 * dropping records whose heartbeat stopped and records outside its scope.
 *
 * Records are keyed by session id, so an instance that reloads overwrites its
 * predecessor's rows instead of doubling them, and a session is on the roster
 * at most once.
 */

import { randomUUID } from "node:crypto"

import type { Config } from "../config.ts"
import { describeError } from "../domain/errors.ts"
import type { Peer, SessionID } from "../domain/types.ts"
import { startSessionIndex, type EventSource, type SessionChange, type SessionIndex } from "../host/events.ts"
import type { InstanceLocation } from "../host/index.ts"
import type { SessionLookup, SessionRecord } from "../host/session.ts"
import type { PluginStorage, StoredRecord } from "../host/storage.ts"
import { reclaimStale } from "./reclaim.ts"

/** Untitled sessions still need something to be called by. */
const FALLBACK_TITLE = "untitled session"

export interface RosterDeps {
  readonly config: Config
  readonly location: InstanceLocation
  readonly sessions: SessionLookup
  readonly storage: PluginStorage
  readonly events: EventSource
  readonly warn: (message: string) => void
  /** Test seam: publish under a known instance id instead of a generated one. */
  readonly instanceID?: string
}

/** What one read of the roster saw, and what it can say about an empty one. */
export interface RosterReport {
  /** Every live peer in this instance's scope, sorted as `live()` sorts them. */
  readonly peers: readonly Peer[]
  /** In-scope records whose heartbeats stopped: the peers that went quiet. */
  readonly quietInScope: number
  /** Live records in another scope: sessions this instance may not address. */
  readonly liveInOtherScopes: number
}

export interface Roster {
  /**
   * Publishes a session as served by this instance and returns its row. The
   * caller reached this location's tool, so this location is what serves it.
   * Rejects when the host does not know the session.
   */
  publish(sessionID: SessionID): Promise<Peer>
  /** Every live peer in this instance's scope, this instance's sessions included. */
  live(): Promise<readonly Peer[]>
  /** `live()` plus what explains an empty answer: who went quiet, who is elsewhere. */
  report(): Promise<RosterReport>
  /**
   * Called when what a reader of `live()` or `report()` would see changes.
   * Changes a reader cannot observe — a heartbeat refreshing a row that already
   * reads the same — are not announced.
   */
  observe(listener: () => void): void
  /**
   * Stops the heartbeat and the event subscription. The records this instance
   * published are deliberately left behind: the successor that serves this
   * location adopts them, which is the only way a session that is idle across a
   * reload stays visible. What no successor adopts, the sweep reclaims.
   */
  dispose(): Promise<void>
}

export async function startRoster(deps: RosterDeps): Promise<Roster> {
  const roster = new LiveRoster(deps, deps.instanceID ?? randomUUID())
  await roster.seed()
  // Sweeping at start matters more than sweeping per beat: a machine that was
  // killed without unloading leaves its records behind, and the next instance
  // to run is the only thing that will ever notice them.
  await roster.sweep()
  return roster
}

class LiveRoster implements Roster {
  /** The sessions this instance publishes, and what it last wrote for each. */
  private readonly served = new Map<SessionID, Peer>()
  private readonly listeners: (() => void)[] = []
  /** What the last announcement said; a beat that changes nothing stays quiet. */
  private announced: string | undefined
  private readonly index: SessionIndex
  private readonly heartbeat: Timer
  private disposed = false

  constructor(
    private readonly deps: RosterDeps,
    private readonly instanceID: string,
  ) {
    // The subscription starts before the first await, so no event can be missed
    // between subscribing and listening.
    this.index = startSessionIndex(deps.events, deps.warn)
    this.index.observe((change) => {
      void this.react(change)
    })
    this.heartbeat = setInterval(
      () => {
        void this.beat()
      },
      // Three beats fit inside one TTL, so a single missed beat does not erase a
      // live peer. The heartbeat is not what keeps the host alive.
      Math.max(1, Math.floor(deps.config.rosterTtlMs / 3)),
    )
    this.heartbeat.unref()
  }

  /**
   * Adopts what an earlier instance of this directory left behind: storage is
   * durable, the event stream is not, so a session that has not run a turn
   * since the host restarted is only visible here.
   */
  async seed(): Promise<void> {
    let stored: readonly StoredRecord<Peer>[]
    try {
      stored = await this.deps.storage.peers.list()
    } catch (error) {
      // Nothing is lost: the roster still fills from live events and from tool
      // calls, and the next beat publishes what this instance serves.
      this.deps.warn(`could not read the roster: ${describeError(error)}`)
      return
    }

    for (const { value: peer } of stored) {
      if (peer.directory !== this.deps.location.directory) continue
      // A record whose session is gone is skipped rather than removed: readers
      // already ignore it past the TTL, and reclaiming records this instance did
      // not write is a decision the plan has not settled (open question 5).
      await this.adopt(peer.sessionID)
    }
    await this.announce()
  }

  async publish(sessionID: SessionID): Promise<Peer> {
    const peer = this.row(await this.deps.sessions.get(sessionID))
    await this.store(peer)
    await this.announce()
    return peer
  }

  async live(): Promise<readonly Peer[]> {
    return (await this.report()).peers
  }

  async report(): Promise<RosterReport> {
    const { rosterTtlMs, scope } = this.deps.config
    const now = Date.now()
    const stored = await this.deps.storage.peers.list()
    const records = stored.map((record) => record.value)

    // A record from another scope is not a peer, and one whose heartbeats
    // stopped belongs to a session (or an instance) that has gone away. The two
    // counts are what tells those cases apart from a scope with nobody in it,
    // which is the difference the view has to report.
    return {
      peers: records
        .filter((peer) => peer.scope === scope && now - peer.updatedAt <= rosterTtlMs)
        .sort(byDirectoryThenTitle),
      quietInScope: records.filter(
        (peer) => peer.scope === scope && now - peer.updatedAt > rosterTtlMs,
      ).length,
      liveInOtherScopes: records.filter(
        (peer) => peer.scope !== scope && now - peer.updatedAt <= rosterTtlMs,
      ).length,
    }
  }

  observe(listener: () => void): void {
    this.listeners.push(listener)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.heartbeat)
    this.index.close()
    // The records stay. Withdrawing them would take each idle session in this
    // location off the roster until it happened to run something, because the
    // successor's seed can only adopt records that still exist — and an
    // instance has no way to enumerate the sessions it serves. Left in place,
    // they age out of every reader's view at the TTL and are re-published by
    // whoever takes over, or reclaimed by the sweep if nobody does.
    this.served.clear()
    this.listeners.length = 0
  }

  /** Keeps the records of this instance's sessions fresh for as long as it runs. */
  private async beat(): Promise<void> {
    for (const sessionID of [...this.served.keys()]) {
      try {
        await this.adopt(sessionID)
      } catch (error) {
        // One session that cannot be refreshed must not stop the others.
        this.deps.warn(`could not refresh ${sessionID} on the roster: ${describeError(error)}`)
      }
    }
    if (this.disposed) return
    await this.sweep()
    // A peer in another location writes to the shared storage without this
    // instance ever seeing an event for it, so the beat is when a foreign row
    // appearing — or going quiet — is noticed at all.
    await this.announce()
  }

  /**
   * Tells the listeners when a read would say something new: a session joining
   * or leaving the roster, or a row's title or status changing. A refresh that
   * leaves a row reading the same is not news, so the signature of what a
   * reader would see is what decides.
   */
  private async announce(): Promise<void> {
    let signature: string
    try {
      signature = signatureOf(await this.report())
    } catch (error) {
      // A reader's own call reports the failure it sees, and the next beat
      // tries again: a roster that cannot be read is not made worse here.
      this.deps.warn(`could not check the roster for changes: ${describeError(error)}`)
      return
    }
    if (signature === this.announced) return
    this.announced = signature
    for (const listener of this.listeners) listener()
  }

  /**
   * Reclaims records nobody owns any more. Housekeeping is never allowed to
   * take the roster down with it, so a failed sweep is a warning and nothing
   * else — the records it failed on were already ignored by every reader.
   */
  async sweep(): Promise<void> {
    try {
      const { failures } = await reclaimStale({
        storage: this.deps.storage,
        config: this.deps.config,
        now: Date.now(),
      })
      if (failures > 0) {
        this.deps.warn(`could not reclaim ${failures} stale record(s) from plugin storage`)
      }
    } catch (error) {
      this.deps.warn(`could not sweep plugin storage: ${describeError(error)}`)
    }
  }

  private async react(change: SessionChange): Promise<void> {
    if (this.disposed) return
    try {
      // A deleted session is off the roster at once rather than at the TTL.
      if (change.kind === "gone") await this.forget(change.sessionID)
      else await this.adopt(change.session.sessionID)
      await this.announce()
    } catch (error) {
      this.deps.warn(`could not update ${change.kind} session on the roster: ${describeError(error)}`)
    }
  }

  /**
   * Publishes a session if this instance serves it. Events are not filtered by
   * location, so the session's own directory is what decides — and a session
   * that has moved away loses its row here.
   */
  private async adopt(sessionID: SessionID): Promise<void> {
    let peer: Peer
    try {
      peer = this.row(await this.deps.sessions.get(sessionID))
    } catch {
      // The host does not know this session (or cannot answer right now). Keep
      // the record we have: if the session really is gone, its heartbeats stop
      // and readers drop it at the TTL, which a transient failure must not short
      // circuit.
      return
    }

    if (peer.directory !== this.deps.location.directory) {
      await this.forget(sessionID)
      return
    }
    await this.store(peer)
  }

  private async store(peer: Peer): Promise<void> {
    await this.deps.storage.peers.write(peer.sessionID, peer)
    this.served.set(peer.sessionID, peer)
  }

  private async forget(sessionID: SessionID): Promise<void> {
    if (!this.served.delete(sessionID)) return
    const record = await this.deps.storage.peers.read(sessionID)
    if (record?.instanceID === this.instanceID) await this.deps.storage.peers.remove(sessionID)
  }

  private row(session: SessionRecord): Peer {
    return {
      sessionID: session.id,
      title: session.title ?? FALLBACK_TITLE,
      directory: session.directory,
      projectID: session.projectID,
      model: session.modelID,
      status: this.index.statusOf(session.id),
      scope: this.deps.config.scope,
      // Only this instance can read its own options, so its sessions declare
      // here what they accept: every sender honours the declaration it reads.
      inboundTrigger: this.deps.config.inbound.trigger,
      parentID: session.parentID,
      instanceID: this.instanceID,
      updatedAt: Date.now(),
    }
  }
}

function byDirectoryThenTitle(left: Peer, right: Peer): number {
  if (left.directory !== right.directory) return left.directory < right.directory ? -1 : 1
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  return left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0
}

/**
 * What a reader would see, as one string — no timestamps: every heartbeat
 * rewrites `updatedAt`, and a row that still reads the same is not a change.
 */
function signatureOf(report: RosterReport): string {
  return JSON.stringify({
    peers: report.peers.map((peer) => [
      peer.sessionID,
      peer.title,
      peer.directory,
      peer.status ?? null,
    ]),
    quietInScope: report.quietInScope,
    liveInOtherScopes: report.liveInOtherScopes,
  })
}
