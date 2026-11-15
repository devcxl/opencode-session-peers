/**
 * Runtime probe for the watchdog ledger study (issue #57).
 *
 * This file is loaded by an isolated `opencode serve` process as a project
 * plugin. Its only job is to answer a fact question the documentation cannot:
 * does the OpenCode plugin runtime resolve the Bun builtin `bun:sqlite`, and
 * can it use the exact transaction/pragma surface the ledger design needs?
 *
 * It writes one JSON report inside the harness scratch directory named by
 * `WATCHDOG_LEDGER_PROBE_OUT`. It never reads the host database, credentials,
 * user sessions or configuration.
 */

import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

interface ProbeContext {
  readonly location: { readonly directory: string }
  readonly app: { readonly version: string }
  readonly storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
}

type Json = Record<string, unknown>

const OUT = process.env["WATCHDOG_LEDGER_PROBE_OUT"]
const DIR = process.env["WATCHDOG_LEDGER_PROBE_DIR"]

function mode(path: string): string | null {
  try {
    return `0o${(statSync(path).mode & 0o777).toString(8)}`
  } catch {
    return null
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function writeReport(report: Json): void {
  if (OUT === undefined || OUT.length === 0) return
  mkdirSync(dirname(OUT), { recursive: true })
  const temporary = `${OUT}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, OUT)
}

function probeDatabase(directory: string): Json {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const path = join(directory, "ledger-probe.sqlite3")
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600)
    } catch {
      // Best effort cleanup of a previous probe run.
    }
  }

  const db = new Database(path, { create: true, strict: true })
  chmodSync(path, 0o600)

  const journal = db.query("PRAGMA journal_mode = WAL").get() as Json
  db.run("PRAGMA synchronous = FULL")
  db.run("PRAGMA busy_timeout = 1500")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_autocheckpoint = 1000")

  const pragmas = {
    journal_mode: db.query("PRAGMA journal_mode").get() as Json,
    synchronous: db.query("PRAGMA synchronous").get() as Json,
    busy_timeout: db.query("PRAGMA busy_timeout").get() as Json,
    foreign_keys: db.query("PRAGMA foreign_keys").get() as Json,
    sqlite_version: db.query("SELECT sqlite_version() AS v").get() as Json,
    journal_set: journal,
  }

  db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)")
  const insert = db.prepare("INSERT INTO probe (id, value) VALUES (?, ?)")
  const immediate = db.transaction((id: number, value: string) => {
    insert.run(id, value)
    return { id, value }
  })
  const immediateType = typeof (immediate as unknown as { immediate?: unknown }).immediate
  const transactionResult = (immediate as unknown as { immediate: (id: number, value: string) => Json }).immediate(
    1,
    "one",
  )

  let uniqueError: Json = { thrown: false }
  try {
    insert.run(2, "one")
  } catch (error) {
    uniqueError = {
      thrown: true,
      name: error instanceof Error ? error.name : typeof error,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    }
  }

  db.run("INSERT INTO probe (id, value) VALUES (2, 'two')")
  const rows = db.query("SELECT id, value FROM probe ORDER BY id").all() as Json[]

  let readonlyError: Json = { thrown: false }
  try {
    const readonly = new Database(path, { readonly: true, strict: true })
    try {
      readonly.run("INSERT INTO probe (id, value) VALUES (3, 'three')")
    } finally {
      readonly.close()
    }
  } catch (error) {
    readonlyError = {
      thrown: true,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    }
  }

  let createFalseError: Json = { thrown: false }
  try {
    const missing = new Database(join(directory, "missing.sqlite3"), { create: false, strict: true })
    missing.close()
  } catch (error) {
    createFalseError = {
      thrown: true,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    }
  }

  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  const modes = {
    db: mode(path),
    wal: mode(`${path}-wal`),
    shm: mode(`${path}-shm`),
    directory: mode(directory),
  }
  const inTransactionAfter = db.inTransaction
  db.close()

  return {
    path,
    pragmas,
    transaction: {
      immediateType,
      transactionResult,
      inTransactionAfter,
    },
    uniqueError,
    rows,
    readonlyError,
    createFalseError,
    modes,
  }
}

export default {
  id: "watchdog-ledger-runtime-probe",
  async setup(ctx: ProbeContext): Promise<void> {
    const started = Date.now()
    const report: Json = {
      kind: "watchdog-ledger-runtime-probe",
      pid: process.pid,
      appVersion: ctx.app.version,
      location: ctx.location.directory,
      runtime: {
        bunVersion: typeof Bun === "undefined" ? null : Bun.version,
        versions: {
          bun: process.versions["bun"] ?? null,
          node: process.versions["node"] ?? null,
          sqlite: process.versions["sqlite"] ?? null,
        },
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
      },
      context: {
        keys: Object.keys(ctx).sort(),
        appKeys: Object.keys(ctx.app).sort(),
        locationKeys: Object.keys(ctx.location).sort(),
      },
      storage: {
        keys: Object.keys(ctx.storage).sort(),
        compareAndSet: typeof (ctx.storage as unknown as { compareAndSet?: unknown }).compareAndSet,
        transaction: typeof (ctx.storage as unknown as { transaction?: unknown }).transaction,
      },
    }

    try {
      report["database"] = probeDatabase(DIR ?? join(ctx.location.directory, ".watchdog-ledger-probe"))
      const key = `watchdog-ledger-probe/${process.pid}`
      await ctx.storage.set(key, { at: started })
      const storage = report["storage"] as Json
      storage["setGet"] = await ctx.storage.get(key)
      await ctx.storage.remove(key)
      report["ok"] = true
    } catch (error) {
      report["ok"] = false
      report["error"] = {
        name: error instanceof Error ? error.name : typeof error,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    } finally {
      report["durationMs"] = Date.now() - started
      writeReport(report)
    }
  },
}
