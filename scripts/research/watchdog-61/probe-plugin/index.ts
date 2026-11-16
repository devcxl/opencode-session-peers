/**
 * Runtime probe plugin for the #61 isolated smoke.
 *
 * It runs inside the throwaway opencode service process, so the SQLite facts
 * it reads are the host plugin runtime's facts, not the external Bun CLI's.
 * It writes one JSON line only inside the scratch directory named by
 * `WATCH61_PROBE_LOG`; it never reads credentials, sessions or the live store.
 */

import { appendFileSync, mkdirSync, statfsSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"

interface ProbeContext {
  readonly app: { readonly version: string }
  readonly location: { readonly directory: string }
}

const logPath = process.env["WATCH61_PROBE_LOG"]
const dbPath = process.env["WATCH61_PROBE_DB"]

export default {
  id: "session-peers-watchdog-61-probe",
  async setup(ctx: ProbeContext): Promise<void> {
    if (logPath === undefined || logPath.length === 0) return
    if (dbPath === undefined || dbPath.length === 0) return
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    const db = new Database(dbPath, { create: true, strict: true })
    try {
      db.run("PRAGMA busy_timeout = 500")
      const busy = db.query("PRAGMA busy_timeout").get() as { timeout?: number }
      const journal = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string }
      db.run("PRAGMA synchronous = FULL")
      const synchronous = db.query("PRAGMA synchronous").get() as { synchronous?: number }
      const sqlite = db.query("SELECT sqlite_version() AS version").get() as { version?: string }
      let filesystem = "unknown"
      try {
        const stats = statfsSync(dirname(dbPath)) as unknown as { type?: number | bigint }
        filesystem = stats.type === undefined ? "unknown" : String(stats.type)
      } catch {
        filesystem = "unknown"
      }
      const record = {
        pid: process.pid,
        appVersion: ctx.app.version,
        platform: process.platform,
        arch: process.arch,
        directory: ctx.location.directory,
        sqliteVersion: sqlite.version ?? null,
        journalMode: journal.journal_mode ?? null,
        synchronous: synchronous.synchronous ?? null,
        busyTimeoutMs: busy.timeout ?? null,
        databasePath: dbPath,
        filesystem,
      }
      appendFileSync(logPath, `${JSON.stringify(record)}\n`)
    } finally {
      db.close()
    }
  },
}
