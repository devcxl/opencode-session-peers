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

export interface Roster {
  /**
   * Publishes a session as served by this instance and returns its row. The
   * caller reached this location's tool, so this location is what serves it.
   * Rejects when the host does not know the session.
   */
  publish(sessionID: SessionID): Promise<Peer>
  /** Every live peer in this instance's scope, this instance's sessions included. */
  live(): Promise<readonly Peer[]>
  /** Stops the heartbeat and the event subscription, and removes this instance's records. */
  dispose(): Promise<void>
}

export async function startRoster(deps: RosterDeps): Promise<Roster> {
  const roster = new LiveRoster(deps, deps.instanceID ?? randomUUID())
  await roster.seed()
  return roster
}

class LiveRoster implements Roster {
  /** The sessions this instance publishes, and what it last wrote for each. */
  private readonly served = new Map<SessionID, Peer>()
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
  }

  async publish(sessionID: SessionID): Promise<Peer> {
    const peer = this.row(await this.deps.sessions.get(sessionID))
    await this.store(peer)
    return peer
  }

  async live(): Promise<readonly Peer[]> {
    const { rosterTtlMs, scope } = this.deps.config
    const now = Date.now()
    const stored = await this.deps.storage.peers.list()

    return stored
      .map((record) => record.value)
      // A record from another scope is not a peer, and one whose heartbeats
      // stopped belongs to a session (or an instance) that has gone away.
      .filter((peer) => peer.scope === scope && now - peer.updatedAt <= rosterTtlMs)
      .sort(byDirectoryThenTitle)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.heartbeat)
    this.index.close()

    for (const sessionID of [...this.served.keys()]) {
      try {
        // Remove the row only while this instance still owns it: the same
        // session may since have been published by the instance that reloaded
        // this one, and that record is the live one.
        const record = await this.deps.storage.peers.read(sessionID)
        if (record?.instanceID === this.instanceID) await this.deps.storage.peers.remove(sessionID)
      } catch (error) {
        this.deps.warn(`could not withdraw ${sessionID} from the roster: ${describeError(error)}`)
      }
    }
    this.served.clear()
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
  }

  private async react(change: SessionChange): Promise<void> {
    if (this.disposed) return
    try {
      // A deleted session is off the roster at once rather than at the TTL.
      if (change.kind === "gone") await this.forget(change.sessionID)
      else await this.adopt(change.session.sessionID)
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
