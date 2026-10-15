/**
 * The host's plugin storage, as this plugin sees it.
 *
 * The host keeps one JSON namespace per plugin id, shared by every location
 * instance on the machine and durable across process restarts
 * (`docs/research/plugin-instance-scoping.md` §4), so this is the only place a
 * machine-wide rendezvous can live. The key layout is owned here and nowhere
 * else, because a change to it has to be made in one file:
 *
 *   v1/peers/<sessionID>   one roster record per session, written by the
 *                          instance that serves it (`peers/roster.ts`)
 *
 * `v1` is the layout version: records written by an incompatible earlier build
 * simply fail to appear rather than being half-understood.
 */

import type { Plugin } from "@opencode/plugin"

import type { Peer } from "../domain/types.ts"

/** A value the host accepts; JSON is all it promises to store. */
type StorageValue = Parameters<Plugin.Context["storage"]["set"]>[1]

type RawStorage = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">

export interface StoredRecord<T> {
  readonly id: string
  readonly value: T
}

/** One kind of record: keyed by id, opaque to the host. */
export interface RecordStore<T> {
  read(id: string): Promise<T | undefined>
  write(id: string, value: T): Promise<void>
  remove(id: string): Promise<void>
  /** Every record of this kind, from every instance on the machine. */
  list(): Promise<readonly StoredRecord<T>[]>
}

export interface PluginStorage {
  readonly peers: RecordStore<Peer>
}

const LAYOUT = "v1"
const PEER_PREFIX = `${LAYOUT}/peers/`

/**
 * Where a session's roster record lives. Exported because a *second* instance
 * has to write the same key — and a test standing in for one has to as well.
 */
export function peerKey(sessionID: string): string {
  return `${PEER_PREFIX}${sessionID}`
}

export function pluginStorage(storage: RawStorage): PluginStorage {
  return { peers: recordStore<Peer>(storage, PEER_PREFIX) }
}

function recordStore<T>(storage: RawStorage, prefix: string): RecordStore<T> {
  return {
    async read(id) {
      const value = await storage.get(`${prefix}${id}`)
      return value as unknown as T | undefined
    },

    async write(id, value) {
      await storage.set(`${prefix}${id}`, value as unknown as StorageValue)
    },

    async remove(id) {
      await storage.remove(`${prefix}${id}`)
    },

    async list() {
      const records: StoredRecord<T>[] = []
      let after: string | undefined
      // A scan may come back paged; follow the cursor to the end so no caller
      // ever sees half a registry. The guard stops a host that returns the same
      // cursor twice from looping forever inside a tool call.
      for (;;) {
        const page = await storage.scan(after === undefined ? { prefix } : { prefix, after })
        for (const entry of page.entries) {
          records.push({ id: entry.key.slice(prefix.length), value: entry.value as unknown as T })
        }
        if (page.next === undefined || page.next === after) return records
        after = page.next
      }
    },
  }
}
