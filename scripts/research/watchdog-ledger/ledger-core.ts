/**
 * Core of the issue #57 research ledger: opening, pragmas, schema and the
 * small read/write helpers shared by the operation modules.
 *
 * This is a research fixture, not production code. It deliberately has no
 * dependency beyond Bun and a local SQLite file.
 */

import { Database } from "bun:sqlite"
import { accessSync, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

export const SCHEMA_VERSION = 1
export const PROTOCOL_VERSION = 1
export const MAX_RESERVATIONS = 3

export type ErrorCode =
  | "invalid_input"
  | "unsafe_path"
  | "readonly"
  | "corrupt"
  | "unsupported_schema"
  | "ledger_path_mismatch"
  | "ledger_mismatch"
  | "lock_timeout"
  | "quota_exhausted"
  | "pending_attempt"
  | "stale_owner"
  | "not_active"
  | "unknown_task"
  | "session_conflict"
  | "request_conflict"
  | "reservation_conflict"
  | "already_terminal"
  | "not_reserved"
  | "stop_proof_missing"
  | "conflict"
  | "io_error"
  | "ledger_error"

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; detail?: string }

export interface TaskState {
  task_id: string
  ledger_id: string
  session_id: string
  authorization_round: string
  state: "active" | "paused" | "sealed" | "completed" | "cancelled"
  owner_activation: string
  generation: number
  reserved_count: number
  created_at: number
  updated_at: number
}

export interface ReservationState {
  reservation_id: string
  task_id: string
  ledger_id: string
  generation: number
  attempt_no: number
  state: "reserved" | "sending" | "accepted" | "result_recorded" | "result_unknown" | "aborted"
  created_at: number
  updated_at: number
}

export interface HandoverEvidence {
  readonly oldOwnerStopped: true
  readonly inFlightResolved: true
  readonly noUnconsumedMessages: true
  readonly stopProof: string
  readonly observedAt: number
}

export interface LedgerSnapshot {
  task: TaskState | null
  reservations: ReservationState[]
  handovers: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
}

export interface OpenOptions {
  busyTimeoutMs?: number
  secureDirectory?: boolean
}

export class LedgerFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code)
    this.name = "LedgerFailure"
  }
}

export function sqliteCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function mapError(error: unknown): { code: ErrorCode; detail: string } {
  if (error instanceof LedgerFailure) return { code: error.code, detail: error.detail ?? error.code }
  const code = sqliteCode(error) ?? ""
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { code: "lock_timeout", detail: message(error) }
  if (code === "SQLITE_READONLY") return { code: "readonly", detail: message(error) }
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return { code: "corrupt", detail: message(error) }
  if (code.startsWith("SQLITE_CONSTRAINT")) return { code: "conflict", detail: message(error) }
  if (code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN") return { code: "io_error", detail: message(error) }
  return { code: "ledger_error", detail: message(error) }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function checkID(name: string, value: string): void {
  if (!ID.test(value)) throw new LedgerFailure("invalid_input", `${name} is not a stable identifier: ${value}`)
}

export function checkGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new LedgerFailure("invalid_input", "generation must be >= 1")
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS watch_tasks (
  task_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  authorization_round TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','paused','sealed','completed','cancelled')),
  owner_activation TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count BETWEEN 0 AND ${MAX_RESERVATIONS}),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_task_per_session
  ON watch_tasks(session_id) WHERE state IN ('active','paused');
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  ledger_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND ${MAX_RESERVATIONS}),
  state TEXT NOT NULL CHECK (state IN ('reserved','sending','accepted','result_recorded','result_unknown','aborted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_reservation_per_task
  ON reservations(task_id) WHERE state IN ('reserved','sending','accepted','result_unknown');
CREATE TABLE IF NOT EXISTS handovers (
  handover_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  from_generation INTEGER NOT NULL,
  to_generation INTEGER NOT NULL,
  from_activation TEXT NOT NULL,
  to_activation TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, to_generation)
);
CREATE TABLE IF NOT EXISTS registration_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

export class LedgerCore {
  constructor(
    readonly db: Database,
    readonly path: string,
    readonly ledgerId: string,
  ) {}

  close(): void {
    this.db.close()
  }

  /** Test-only: hold the write lock so a contender can hit busy_timeout. */
  holdWriteLock(ms: number): void {
    this.db.run("BEGIN IMMEDIATE")
    Bun.sleepSync(ms)
    this.db.run("COMMIT")
  }

  secureFiles(): void {
    for (const target of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        if (existsSync(target)) chmodSync(target, 0o600)
      } catch {
        // Best effort: the containing directory (0700) is the primary boundary.
      }
    }
  }

  info(): { ledgerId: string; path: string; schemaVersion: number; protocolVersion: number } {
    return {
      ledgerId: this.ledgerId,
      path: this.path,
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }
  }

  immediate<T>(fn: () => T): Outcome<T> {
    try {
      const value = this.db.transaction(fn).immediate() as T
      this.secureFiles()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, ...mapError(error) }
    }
  }

  task(taskId: string): TaskState {
    const row = this.db.query("SELECT * FROM watch_tasks WHERE task_id = ?").get(taskId) as TaskState | null
    if (row === null) throw new LedgerFailure("unknown_task", taskId)
    if (row.ledger_id !== this.ledgerId) throw new LedgerFailure("ledger_mismatch", row.ledger_id)
    return row
  }

  reservation(reservationId: string): ReservationState {
    const row = this.db.query("SELECT * FROM reservations WHERE reservation_id = ?").get(reservationId) as
      | ReservationState
      | null
    if (row === null) throw new LedgerFailure("not_reserved", reservationId)
    if (row.ledger_id !== this.ledgerId) throw new LedgerFailure("ledger_mismatch", row.ledger_id)
    return row
  }

  event(taskId: string | null, kind: string, detail: unknown, now: number): void {
    this.db
      .query("INSERT INTO ledger_events (task_id, kind, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, kind, JSON.stringify(detail), now)
  }

  snapshot(taskId: string): LedgerSnapshot {
    return {
      task: this.db.query("SELECT * FROM watch_tasks WHERE task_id = ?").get(taskId) as TaskState | null,
      reservations: this.db
        .query("SELECT * FROM reservations WHERE task_id = ? ORDER BY attempt_no")
        .all(taskId) as ReservationState[],
      handovers: this.db.query("SELECT * FROM handovers WHERE task_id = ? ORDER BY to_generation").all(taskId) as Array<
        Record<string, unknown>
      >,
      events: this.db.query("SELECT * FROM ledger_events WHERE task_id = ? ORDER BY seq").all(taskId) as Array<
        Record<string, unknown>
      >,
    }
  }

  countReservations(taskId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM reservations WHERE task_id = ?").get(taskId) as { n: number }).n
  }

  countTasks(sessionId?: string): number {
    if (sessionId === undefined) {
      return (this.db.query("SELECT COUNT(*) AS n FROM watch_tasks").get() as { n: number }).n
    }
    return (
      this.db.query("SELECT COUNT(*) AS n FROM watch_tasks WHERE session_id = ?").get(sessionId) as { n: number }
    ).n
  }

  mode(): { db: number; directory: number } {
    return { db: statSync(this.path).mode & 0o777, directory: statSync(dirname(this.path)).mode & 0o777 }
  }
}

export function openCore(inputPath: string, options: OpenOptions = {}): Outcome<LedgerCore> {
  try {
    if (!isAbsolute(inputPath)) throw new LedgerFailure("unsafe_path", "the ledger path must be absolute")
    const directory = dirname(inputPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (options.secureDirectory !== false) chmodSync(directory, 0o700)

    if (existsSync(inputPath) && lstatSync(inputPath).isSymbolicLink()) {
      throw new LedgerFailure("unsafe_path", "the ledger path must not be a symlink")
    }
    const canonical = existsSync(inputPath)
      ? realpathSync(inputPath)
      : join(realpathSync(directory), basename(inputPath))
    if (resolve(canonical) !== canonical) throw new LedgerFailure("unsafe_path", "the ledger path is not canonical")
    try {
      accessSync(canonical, 0o2)
    } catch {
      if (existsSync(canonical)) throw new LedgerFailure("readonly", "the ledger file is not writable")
    }
    try {
      accessSync(directory, 0o2)
    } catch {
      throw new LedgerFailure("readonly", "the ledger directory is not writable")
    }

    const db = new Database(canonical, { create: true, strict: true })
    chmodSync(canonical, 0o600)
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 1500))}`)
    db.run("PRAGMA synchronous = FULL")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_autocheckpoint = 1000")
    const currentJournal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
    if (currentJournal.journal_mode !== "wal") {
      const journal = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string }
      if (journal.journal_mode !== "wal") {
        db.close()
        throw new LedgerFailure("readonly", `WAL is unavailable (journal_mode=${journal.journal_mode ?? "unknown"})`)
      }
    }
    const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check?: string }>
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      db.close()
      throw new LedgerFailure("corrupt", "PRAGMA quick_check did not return ok")
    }

    const existingTables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    const required = ["meta", "watch_tasks", "reservations", "handovers", "registration_requests", "ledger_events"]
    if (required.some((name) => !existingTables.has(name))) db.run(DDL)

    const read = (key: string): string | undefined =>
      (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value
    const existingSchema = read("schema_version")
    const existingProtocol = read("protocol_version")
    if (existingSchema !== undefined && existingSchema !== String(SCHEMA_VERSION)) {
      db.close()
      throw new LedgerFailure("unsupported_schema", `schema_version=${existingSchema}`)
    }
    if (existingProtocol !== undefined && existingProtocol !== String(PROTOCOL_VERSION)) {
      db.close()
      throw new LedgerFailure("unsupported_schema", `protocol_version=${existingProtocol}`)
    }
    const storedPath = read("canonical_path")
    if (storedPath !== undefined && storedPath !== canonical) {
      db.close()
      throw new LedgerFailure("ledger_path_mismatch", `stored=${storedPath} opened=${canonical}`)
    }

    const ledgerId = read("ledger_id") ?? crypto.randomUUID()
    const missing: Array<[string, string]> = []
    if (read("schema_version") === undefined) missing.push(["schema_version", String(SCHEMA_VERSION)])
    if (read("protocol_version") === undefined) missing.push(["protocol_version", String(PROTOCOL_VERSION)])
    if (read("ledger_id") === undefined) missing.push(["ledger_id", ledgerId])
    if (read("canonical_path") === undefined) missing.push(["canonical_path", canonical])
    if (read("created_at") === undefined) missing.push(["created_at", String(Date.now())])
    if (missing.length > 0) {
      const set = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      db.transaction(() => {
        for (const [key, value] of missing) set.run(key, value)
      }).immediate()
    }
    const core = new LedgerCore(db, canonical, ledgerId)
    core.secureFiles()
    return { ok: true, value: core }
  } catch (error) {
    return { ok: false, ...mapError(error) }
  }
}
