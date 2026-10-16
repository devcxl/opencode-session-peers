/**
 * The host's plugin storage, as a fake.
 *
 * One subject: the durable JSON namespace opencode keeps per plugin id, shared
 * by every location instance on the machine — the rendezvous the roster, asks
 * and replies live in. Values stay `unknown` on purpose: the fake must not
 * quietly mirror the host's JSON type to look more like the host than it is,
 * which is why `fakePluginStorage` exists to see the same store through the
 * plugin's own adapter.
 *
 * Scan pages like the host's, so nothing can rely on a single page.
 */

import { pluginStorage, type PluginStorage } from "../src/host/storage.ts"

export interface FakeScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface FakeStorage {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: FakeScanOptions) => Promise<{
    readonly entries: readonly { readonly key: string; readonly value: unknown }[]
    readonly next?: string
  }>
  /** Every stored value, in key order: what the plugin asked the host to keep. */
  values(): readonly unknown[]
}

/** One scan page. The real host may page; the fake always does, so nothing can rely on a single page. */
const SCAN_PAGE = 2

export function fakeStorage(): FakeStorage {
  const entries = new Map<string, unknown>()

  return {
    async get(key) {
      return entries.get(key)
    },
    async set(key, value) {
      entries.set(key, value)
    },
    async remove(key) {
      entries.delete(key)
    },
    async scan(options) {
      const matching = [...entries.keys()]
        .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
        .sort()
      const page = matching.slice(0, options.limit ?? SCAN_PAGE)
      const next = matching.length > page.length ? page[page.length - 1] : undefined
      return {
        entries: page.map((key) => ({ key, value: entries.get(key) })),
        ...(next === undefined ? {} : { next }),
      }
    },
    values() {
      return [...entries.keys()].sort().map((key) => entries.get(key))
    },
  }
}

/**
 * The same storage seen through the plugin's own adapter.
 *
 * The fake keeps values as `unknown` while the adapter takes the host's JSON
 * type; the conversion belongs here, next to the fake, rather than in every
 * test that seeds or inspects the namespace.
 */
export function fakePluginStorage(raw: FakeStorage): PluginStorage {
  return pluginStorage(raw as unknown as Parameters<typeof pluginStorage>[0])
}
