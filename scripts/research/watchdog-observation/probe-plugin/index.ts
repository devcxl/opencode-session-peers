/**
 * Research-grade observation probe (issue #56).
 *
 * This is NOT production code. It is a dependency-free plugin loaded into a
 * throwaway `opencode serve` instance so a run can record what a would-be
 * watchdog can actually see:
 *
 *   - every event the host streams after this instance subscribed (no replay);
 *   - a periodic snapshot of every session: `time.busy`, `time.idle`,
 *     `outcome`, title, and the pending-permission list for that session;
 *   - setup/cleanup markers, so location eviction and hot reload are visible;
 *   - a storage heartbeat, to test that plugin-written heartbeats produce no
 *     session activity.
 *
 * Everything is appended as JSONL to `WATCHDOG_PROBE_LOG`. Paths and values
 * are truncated so one long turn cannot produce an unbounded file.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const LOG_PATH = process.env["WATCHDOG_PROBE_LOG"] ?? process.env["SESSION_PEERS_HARNESS_PROBE_LOG"]
const POLL_MS = Number(process.env["WATCHDOG_PROBE_POLL_MS"] ?? "500")
const HEARTBEAT_MS = Number(process.env["WATCHDOG_PROBE_HEARTBEAT_MS"] ?? "1000")
const SUBSCRIBE_DELAY_MS = Number(process.env["WATCHDOG_PROBE_SUBSCRIBE_DELAY_MS"] ?? "0")
const MAX_STRING = 240
const MAX_ARRAY = 8
const MAX_DEPTH = 4

interface ProbeContext {
  readonly app: { readonly version: string }
  readonly location: { readonly directory: string }
  readonly event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> }
  readonly session: {
    list?: () => Promise<unknown>
    get?: (input: { sessionID: string }) => Promise<unknown>
  }
  readonly permission: {
    list?: (input: { sessionID: string }) => Promise<unknown>
  }
  readonly storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<unknown>
    scan?: (input: { prefix: string; limit?: number }) => Promise<unknown>
  }
}

let ready = false

function record(record: Record<string, unknown>): void {
  if (LOG_PATH === undefined || LOG_PATH.length === 0) return
  if (!ready) {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    ready = true
  }
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ t: Date.now(), wall: new Date().toISOString(), ...record })}\n`)
  } catch {
    // A research probe must never take the instance down for a log write.
  }
}

function trim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…`
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return "[depth]"
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((item) => trim(item, depth + 1))
    return value.length > MAX_ARRAY ? [...kept, `[+${value.length - MAX_ARRAY}]`] : kept
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = trim(item, depth + 1)
  }
  return output
}

function sessionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const data = (raw as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? data : []
}

function permissionList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const data = (raw as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? data : []
}

export default {
  id: "watchdog-observation-probe",
  async setup(ctx: ProbeContext): Promise<() => Promise<void>> {
    const directory = ctx.location.directory
    const startedAt = Date.now()
    const controller = new AbortController()
    const storageKey = `watchdog-probe:${process.pid}:${directory}`
    let previousHeartbeat: unknown = null
    try {
      previousHeartbeat = await ctx.storage.get(storageKey)
    } catch (error) {
      previousHeartbeat = `unreadable: ${String(error)}`
    }
    let globalBefore: unknown = null
    try {
      globalBefore = await ctx.storage.get("watchdog-probe:probe-global")
      await ctx.storage.set("watchdog-probe:probe-global", { pid: process.pid, directory, at: Date.now() })
    } catch (error) {
      globalBefore = `unreadable: ${String(error)}`
    }
    let scannedKeys: unknown = null
    if (ctx.storage.scan !== undefined) {
      try {
        const scanned = await ctx.storage.scan({ prefix: "watchdog-probe:", limit: 50 })
        const list = Array.isArray(scanned)
          ? scanned
          : ((scanned as { entries?: unknown; data?: unknown }).entries ?? (scanned as { data?: unknown }).data ?? [])
        scannedKeys = Array.isArray(list)
          ? list.map((entry) => (typeof entry === "string" ? entry : (entry as { key?: unknown }).key))
          : list
      } catch (error) {
        scannedKeys = `unreadable: ${String(error)}`
      }
    }
    record({
      kind: "setup",
      pid: process.pid,
      version: ctx.app.version,
      directory,
      previousHeartbeat,
      globalBefore,
      scannedKeys,
      sessionKeys: Object.keys(ctx.session as object),
      hasSessionForm: typeof (ctx.session as { form?: unknown }).form,
      permissionKeys: Object.keys(ctx.permission as object),
    })

    const eventLoop = (async () => {
      if (SUBSCRIBE_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_DELAY_MS))
      record({
        kind: "subscription-started",
        pid: process.pid,
        directory,
        delayMs: SUBSCRIBE_DELAY_MS,
        subscriptionStartedAt: Date.now(),
      })
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const shaped = event as { type?: string; data?: unknown; durable?: unknown; location?: unknown }
        record({
          kind: "event",
          pid: process.pid,
          directory,
          type: shaped.type ?? "unknown",
          durable: shaped.durable,
          location: shaped.location,
          data: trim(shaped.data),
        })
      }
    })().catch((error: unknown) => {
      record({ kind: "event-stream-ended", pid: process.pid, directory, message: String(error) })
    })

    const snapshot = async () => {
      try {
        const list = ctx.session.list === undefined ? [] : sessionList(await ctx.session.list())
        for (const item of list) {
          const session = item as {
            id?: string
            title?: string
            outcome?: string
            parentID?: string
            location?: { directory?: string }
            time?: Record<string, unknown>
          }
          if (session.id === undefined) continue
          let permissions: unknown[] = []
          let permissionError: string | undefined
          if (ctx.permission.list !== undefined) {
            try {
              permissions = permissionList(await ctx.permission.list({ sessionID: session.id }))
            } catch (error) {
              permissionError = String(error)
            }
          }
          record({
            kind: "snapshot",
            pid: process.pid,
            directory,
            sessionID: session.id,
            title: session.title,
            outcome: session.outcome,
            parentID: session.parentID,
            sessionDirectory: session.location?.directory,
            time: session.time,
            permissions: permissions.map((entry) => trim(entry)),
            ...(permissionError === undefined ? {} : { permissionError }),
          })
        }
        record({ kind: "snapshot-meta", pid: process.pid, directory, sessions: list.length })
      } catch (error) {
        record({ kind: "snapshot-error", pid: process.pid, directory, message: String(error) })
      }
    }

    const snapshotTimer = setInterval(() => void snapshot(), POLL_MS)
    const heartbeatTimer = setInterval(() => {
      void ctx.storage.set(storageKey, { updatedAt: Date.now() }).catch((error: unknown) => {
        record({ kind: "heartbeat-error", pid: process.pid, directory, message: String(error) })
      })
    }, HEARTBEAT_MS)

    return async () => {
      clearInterval(snapshotTimer)
      clearInterval(heartbeatTimer)
      controller.abort()
      record({ kind: "cleanup", pid: process.pid, directory, livedMs: Date.now() - startedAt })
      await eventLoop
    }
  },
}
