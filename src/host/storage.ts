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
 *   v1/asks/<askID>        one record per question a session is blocked on,
 *                          written by the asker's instance, so any instance can
 *                          find the question waiting for its session
 *   v1/replies/<askID>     the answer, written by the instance that served the
 *                          answering session and read by the blocked asker
 *
 * `v1` is the layout version: records written by an incompatible earlier build
 * simply fail to appear rather than being half-understood.
 */

import type { Plugin } from "@opencode/plugin"

import type { AskRecord, Peer, ReplyRecord } from "../domain/types.ts"

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
  /** Outstanding asks, keyed by question id. */
  readonly asks: RecordStore<AskRecord>
  /** Answers, keyed by the question they answer; read once by the asker. */
  readonly replies: RecordStore<ReplyRecord>
}

const LAYOUT = "v1"
const PEER_PREFIX = `${LAYOUT}/peers/`
const ASK_PREFIX = `${LAYOUT}/asks/`
const REPLY_PREFIX = `${LAYOUT}/replies/`

/**
 * Where a session's roster record lives. Exported because a *second* instance
 * has to write the same key — and a test standing in for one has to as well.
 */
export function peerKey(sessionID: string): string {
  return `${PEER_PREFIX}${sessionID}`
}

/** Where a question's ask record lives. Exported for the same reason as `peerKey`. */
export function askKey(askID: string): string {
  return `${ASK_PREFIX}${askID}`
}

/** Where the answer to one question lives. Exported for the same reason as `peerKey`. */
export function replyKey(askID: string): string {
  return `${REPLY_PREFIX}${askID}`
}

export function pluginStorage(storage: RawStorage): PluginStorage {
  return {
    peers: recordStore<Peer>(storage, PEER_PREFIX),
    asks: recordStore<AskRecord>(storage, ASK_PREFIX),
    replies: recordStore<ReplyRecord>(storage, REPLY_PREFIX),
  }
}

/**
 * Deletes a record only while it still looks stale.
 *
 * A writer may have refreshed the record between the scan that found it and
 * this removal, and the refreshed one is the live record; re-reading is what
 * makes it safe for any number of instances to sweep the same storage at once.
 */
export async function removeIfStill<T>(
  store: RecordStore<T>,
  id: string,
  stillStale: (value: T) => boolean,
): Promise<boolean> {
  const current = await store.read(id)
  if (current === undefined || !stillStale(current)) return false
  await store.remove(id)
  return true
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
