/**
 * The watchdog's security ledger: the only authority for a watched task.
 *
 * It is a plugin-private SQLite database, not `ctx.storage`. The host storage
 * namespace is a discovery surface; it must never decide authorization, quota,
 * ownership or whether a task still exists.
 *
 * The ledger is deliberately conservative. Opening validates a fixed canonical
 * path, the SQLite build, the ledger identity, the schema/protocol versions and
 * the stored path. Any mismatch closes the database and reports a code the
 * caller can show; it never repairs, copies or recreates an old task. Writes
 * run in `BEGIN IMMEDIATE` transactions with unique constraints, so two
 * processes can race for the same session without both succeeding.
 */

import { randomUUID } from "node:crypto"
import {
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { Database } from "bun:sqlite"

import {
  canonicalJson,
  enrollmentFingerprint,
  nextTaskState,
  readEvidence,
  readGoal,
  readIdentifier,
  readReportKind,
  type WatchEvidence,
  type WatchMode,
  type WatchReportKind,
  type WatchState,
  type WatchTaskRecord,
  type WatchedTaskState,
} from "../domain/watch.ts"

export const WATCH_LEDGER_SCHEMA_VERSION = 1
export const WATCH_LEDGER_PROTOCOL_VERSION = 1
export const WATCH_MIN_SQLITE = "3.51.3"

export type WatchLedgerErrorCode =
  | "invalid_input"
  | "unsafe_path"
  | "readonly"
  | "corrupt"
  | "unsupported_schema"
  | "ledger_path_mismatch"
  | "ledger_mismatch"
  | "ledger_missing"
  | "unsafe_sqlite"
  | "lock_timeout"
  | "io_error"
  | "conflict"
  | "session_conflict"
  | "request_conflict"
  | "unknown_task"
  | "caller_mismatch"
  | "stale_version"
  | "report_conflict"
  | "invalid_transition"
  | "ended"
  | "ledger_error"

export type LedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WatchLedgerErrorCode; readonly detail: string }

export interface OpenWatchLedgerOptions {
  /** Absolute path to the plugin's own database file. Never a model-provided path. */
  readonly path: string
  readonly busyTimeoutMs?: number
  /** Bounded retries for a cold start that loses the first write race. */
  readonly openAttempts?: number
  /**
   * Test seam for the version gate. The host adapter leaves this out and reads
   * the embedded runtime; a caller cannot lower the production requirement.
   */
  readonly sqliteVersion?: string
  readonly now?: () => number
}

export type OpenWatchLedgerResult =
  | { readonly ok: true; readonly ledger: WatchLedger }
  | { readonly ok: false; readonly code: WatchLedgerErrorCode; readonly detail: string }

export interface EnrollWatchTaskInput {
  readonly requestId: string
  readonly initiatorSessionId: string
  readonly targetSessionId: string
  readonly goal: string
  readonly mode: WatchMode
  readonly ownerActivation: string
}

export interface ReportWatchTaskInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly expectedVersion: number
  readonly reportId: string
  readonly kind: WatchReportKind
  readonly evidence: WatchEvidence
}

export interface ControlWatchTaskInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly expectedVersion: number
  readonly operation: "pause" | "end"
}

export interface WatchLedger {
  readonly ledgerId: string
  readonly path: string
  /** The SQLite version the ledger accepted; useful for the capability panel. */
  readonly sqliteVersion: string
  enroll(input: EnrollWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly created: boolean }>
  show(input: { readonly taskID?: string; readonly sessionID: string }): LedgerResult<WatchTaskRecord | null>
  report(input: ReportWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly duplicate: boolean }>
  control(input: ControlWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly changed: boolean }>
  close(): void
}

class LedgerFailure extends Error {
  constructor(
    readonly code: WatchLedgerErrorCode,
    readonly detail: string,
  ) {
    super(detail)
    this.name = "LedgerFailure"
  }
}

interface TaskRow {
  readonly task_id: string
  readonly ledger_id: string
  readonly initiator_session_id: string
  readonly target_session_id: string
  readonly goal: string
  readonly mode: string
  readonly watch_state: string
  readonly task_state: string
  readonly version: number
  readonly generation: number
  readonly owner_activation: string
  readonly last_report_id: string | null
  readonly last_report_kind: string | null
  readonly last_report_evidence: string | null
  readonly last_report_at: number | null
  readonly last_report_version: number | null
  readonly created_at: number
  readonly updated_at: number
  readonly completed_at: number | null
  readonly ended_at: number | null
}

interface ReportRow {
  readonly report_id: string
  readonly kind: string
  readonly evidence: string
  readonly created_at: number
  readonly version: number
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
  initiator_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'alert'),
  watch_state TEXT NOT NULL CHECK (watch_state IN ('active','paused','ended')),
  task_state TEXT NOT NULL CHECK (task_state IN ('not-started','in-progress','waiting','blocked','completed')),
  version INTEGER NOT NULL CHECK (version >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  owner_activation TEXT NOT NULL,
  last_report_id TEXT,
  last_report_kind TEXT,
  last_report_evidence TEXT,
  last_report_at INTEGER,
  last_report_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  ended_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_watch_task_per_session
  ON watch_tasks(target_session_id) WHERE watch_state IN ('active','paused');

CREATE TABLE IF NOT EXISTS enrollment_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  session_id TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_reports (
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  report_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, report_id)
);
`

const REQUIRED_TABLES = ["meta", "watch_tasks", "enrollment_requests", "watch_reports"]
const ANCHOR_NAME = "watch-ledger.identity.json"

interface LedgerAnchor {
  readonly ledgerId: string
  readonly canonicalPath: string
  readonly schemaVersion: number
  readonly protocolVersion: number
  readonly createdAt: number
}

function anchorPathFor(canonicalLedgerPath: string): string {
  return join(dirname(canonicalLedgerPath), ANCHOR_NAME)
}

/**
 * The identity anchor is a small plugin-owned file beside the database. It is
 * not a second authority for tasks, quota or authorization; it only lets an
 * existing identity survive a missing database as an error instead of silently
 * becoming a fresh, empty ledger. Losing both files cannot be distinguished
 * from a first run by the plugin, and the same OS user can always do that.
 */
function readAnchor(path: string): LedgerAnchor | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined
    throw new LedgerFailure("io_error", `could not read the ledger identity anchor: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is not an object")
  }
  const record = parsed as Record<string, unknown>
  const ledgerId = record["ledgerId"]
  const canonicalPath = record["canonicalPath"]
  const schemaVersion = record["schemaVersion"]
  const protocolVersion = record["protocolVersion"]
  const createdAt = record["createdAt"]
  if (
    typeof ledgerId !== "string" ||
    typeof canonicalPath !== "string" ||
    typeof schemaVersion !== "number" ||
    typeof protocolVersion !== "number" ||
    typeof createdAt !== "number"
  ) {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is incomplete")
  }
  if (schemaVersion !== WATCH_LEDGER_SCHEMA_VERSION || protocolVersion !== WATCH_LEDGER_PROTOCOL_VERSION) {
    throw new LedgerFailure(
      "unsupported_schema",
      `identity anchor schema=${schemaVersion} protocol=${protocolVersion}`,
    )
  }
  return { ledgerId, canonicalPath, schemaVersion, protocolVersion, createdAt }
}

function writeAnchor(path: string, anchor: LedgerAnchor): void {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(anchor)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try {
      if (existsSync(temporary)) chmodSync(temporary, 0o600)
    } catch {
      // The failure below is the one that matters.
    }
    throw new LedgerFailure("readonly", `could not write the ledger identity anchor: ${String(error)}`)
  }
}

/**
 * Reject every symlink in the requested path, not just the final file. A
 * parent alias would otherwise be silently resolved and a chmod could touch a
 * directory the fixed-state-path contract did not select.
 */
function assertNoSymlinkComponents(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new LedgerFailure("unsafe_path", "the ledger path must be absolute and canonical")
  }
  let current = "/"
  for (const part of path.split("/").filter((piece) => piece.length > 0)) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return
      throw new LedgerFailure("io_error", `could not inspect ${current}: ${String(error)}`)
    }
    if (stat.isSymbolicLink()) {
      throw new LedgerFailure("unsafe_path", `the ledger path contains a symlink: ${current}`)
    }
  }
}

export function openWatchLedger(options: OpenWatchLedgerOptions): OpenWatchLedgerResult {
  const attempts = Math.max(1, Math.trunc(options.openAttempts ?? 3))
  let last: OpenWatchLedgerResult | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = openOnce(options)
    if (result.ok || result.code !== "lock_timeout") return result
    last = result
    // A cold start can lose a short race while the first process creates the
    // schema. Retry a bounded number of times; a persistent lock is reported.
    Bun.sleepSync(10 * (attempt + 1))
  }
  return last ?? { ok: false, code: "lock_timeout", detail: "the ledger did not open" }
}

function openOnce(options: OpenWatchLedgerOptions): OpenWatchLedgerResult {
  let db: Database | undefined
  try {
    const path = options.path
    // Check the requested path before creating or chmod-ing anything: a parent
    // symlink is an alias to a directory this fixed-state-path contract did not
    // select, and resolving it silently is not acceptable.
    assertNoSymlinkComponents(path)
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertNoSymlinkComponents(path)
    chmodSync(directory, 0o700)

    const anchorPath = anchorPathFor(path)
    assertNoSymlinkComponents(anchorPath)
    const anchor = readAnchor(anchorPath)
    if (anchor !== undefined) {
      if (anchor.canonicalPath !== path) {
        throw new LedgerFailure(
          "ledger_path_mismatch",
          `identity anchor path=${anchor.canonicalPath} opened=${path}`,
        )
      }
      if (!existsSync(path)) {
        throw new LedgerFailure(
          "ledger_missing",
          "the ledger identity anchor exists but the database is missing; it is not recreated",
        )
      }
    }
    checkWritable(path, directory)

    db = new Database(path, { create: anchor === undefined, strict: true })
    chmodSync(path, 0o600)
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 500))}`)
    db.run("PRAGMA synchronous = FULL")
    db.run("PRAGMA foreign_keys = ON")

    const versionRow = db.query("SELECT sqlite_version() AS version").get() as { version: string }
    const sqliteVersion = options.sqliteVersion ?? versionRow.version
    if (!versionAtLeast(sqliteVersion, WATCH_MIN_SQLITE)) {
      throw new LedgerFailure(
        "unsafe_sqlite",
        `SQLite ${sqliteVersion} predates ${WATCH_MIN_SQLITE}; the WAL-reset fix is required`,
      )
    }

    const currentJournal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
    if (currentJournal.journal_mode !== "wal") {
      const journal = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string }
      if (journal.journal_mode !== "wal") {
        throw new LedgerFailure("readonly", `WAL is unavailable (journal_mode=${journal.journal_mode ?? "unknown"})`)
      }
    }

    const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check?: string }>
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new LedgerFailure("corrupt", "PRAGMA quick_check did not return ok")
    }

    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    const existing = tables.size > 0
    if (!existing) {
      if (anchor !== undefined) {
        throw new LedgerFailure(
          "ledger_missing",
          "the ledger identity anchor exists but the database has no schema; it is not recreated",
        )
      }
      initializeLedger(db, path, options.now?.() ?? Date.now())
    } else {
      for (const table of REQUIRED_TABLES) {
        if (!tables.has(table)) throw new LedgerFailure("corrupt", `the ledger is missing the ${table} table`)
      }
    }

    const metadata = readMetadata(db)
    if (metadata.canonicalPath === undefined) {
      throw new LedgerFailure("corrupt", "the ledger has no canonical path")
    }
    if (metadata.canonicalPath !== path) {
      throw new LedgerFailure("ledger_path_mismatch", `stored=${metadata.canonicalPath} opened=${path}`)
    }
    if (metadata.schemaVersion !== WATCH_LEDGER_SCHEMA_VERSION) {
      throw new LedgerFailure("unsupported_schema", `schema_version=${metadata.schemaVersion}`)
    }
    if (metadata.protocolVersion !== WATCH_LEDGER_PROTOCOL_VERSION) {
      throw new LedgerFailure("unsupported_schema", `protocol_version=${metadata.protocolVersion}`)
    }
    if (metadata.ledgerId === undefined) throw new LedgerFailure("corrupt", "the ledger has no ledger id")
    const mismatch = db
      .query("SELECT COUNT(*) AS n FROM watch_tasks WHERE ledger_id <> ?")
      .get(metadata.ledgerId) as { n: number }
    if (mismatch.n !== 0) {
      throw new LedgerFailure("ledger_mismatch", "task rows carry a different ledger id")
    }
    if (anchor !== undefined) {
      if (anchor.ledgerId !== metadata.ledgerId) {
        throw new LedgerFailure(
          "ledger_mismatch",
          `identity anchor ledger=${anchor.ledgerId} database=${metadata.ledgerId}`,
        )
      }
    } else {
      writeAnchor(anchorPath, {
        ledgerId: metadata.ledgerId,
        canonicalPath: path,
        schemaVersion: WATCH_LEDGER_SCHEMA_VERSION,
        protocolVersion: WATCH_LEDGER_PROTOCOL_VERSION,
        createdAt: metadata.createdAt ?? options.now?.() ?? Date.now(),
      })
    }

    const ledger = new SqliteWatchLedger(db, path, metadata.ledgerId, sqliteVersion, options.now ?? Date.now)
    ledger.secureFiles()
    db = undefined
    return { ok: true, ledger }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // The failure being reported is the useful one.
    }
    return { ok: false, ...mapError(error) }
  }
}

function checkWritable(file: string, directory: string): void {
  if (existsSync(file)) {
    try {
      accessSync(file, 0o2)
    } catch {
      throw new LedgerFailure("readonly", "the ledger file is not writable")
    }
  }
  try {
    accessSync(directory, 0o2)
  } catch {
    throw new LedgerFailure("readonly", "the ledger directory is not writable")
  }
}

/**
 * Create the schema and its identity in one immediate transaction. A second
 * process that arrives during a cold start either waits for the lock or sees a
 * complete ledger; it never sees half a schema and calls that corruption.
 */
function initializeLedger(db: Database, canonical: string, now: number): void {
  const insert = "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  db.transaction(() => {
    // The lock is acquired after the caller's first look. A process that lost
    // the race must not replace the winner's identity with its own.
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    if (tables.length > 0) return
    db.run(DDL)
    db.run(insert, ["ledger_id", randomUUID()])
    db.run(insert, ["schema_version", String(WATCH_LEDGER_SCHEMA_VERSION)])
    db.run(insert, ["protocol_version", String(WATCH_LEDGER_PROTOCOL_VERSION)])
    db.run(insert, ["canonical_path", canonical])
    db.run(insert, ["created_at", String(now)])
  }).immediate()
}

interface Metadata {
  readonly ledgerId?: string
  readonly schemaVersion?: number
  readonly protocolVersion?: number
  readonly canonicalPath?: string
  readonly createdAt?: number
}

function readMetadata(db: Database): Metadata {
  const rows = db.query("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>
  const values = new Map(rows.map((row) => [row.key, row.value]))
  const number = (key: string): number | undefined => {
    const value = values.get(key)
    if (value === undefined) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return {
    ledgerId: values.get("ledger_id"),
    schemaVersion: number("schema_version"),
    protocolVersion: number("protocol_version"),
    canonicalPath: values.get("canonical_path"),
    createdAt: number("created_at"),
  }
}

class SqliteWatchLedger implements WatchLedger {
  constructor(
    private readonly db: Database,
    readonly path: string,
    readonly ledgerId: string,
    readonly sqliteVersion: string,
    private readonly now: () => number,
  ) {}

  close(): void {
    try {
      // Leave the committed state in the main database, not only in a WAL a
      // copy would miss. This is a checkpoint, not a rewrite of any task.
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      // Closing is still the right next step; a busy checkpoint is not a reason
      // to keep the handle open.
    }
    this.db.close()
  }

  enroll(input: EnrollWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly created: boolean }> {
    return this.immediate(() => {
      const requestId = requiredIdentifier(input.requestId, "requestId")
      const initiator = requiredIdentifier(input.initiatorSessionId, "initiatorSessionId")
      const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const goal = requiredGoal(input.goal)
      if (input.mode !== "alert") throw new LedgerFailure("invalid_input", "only alert-only mode is available")

      const fingerprint = enrollmentFingerprint({
        initiatorSessionId: initiator,
        targetSessionId: target,
        goal,
        mode: "alert",
      })
      const existingRequest = this.db
        .query("SELECT * FROM enrollment_requests WHERE request_id = ?")
        .get(requestId) as
        | { task_id: string; session_id: string; params_fingerprint: string }
        | null
      if (existingRequest !== null) {
        if (existingRequest.params_fingerprint !== fingerprint || existingRequest.session_id !== target) {
          throw new LedgerFailure("request_conflict", "that request id was used with different parameters")
        }
        return { task: this.task(existingRequest.task_id), created: false }
      }

      const live = this.db
        .query(
          "SELECT task_id FROM watch_tasks WHERE target_session_id = ? AND watch_state IN ('active','paused') LIMIT 1",
        )
        .get(target) as { task_id: string } | null
      if (live !== null) {
        throw new LedgerFailure("session_conflict", `the session already has a live watched task: ${live.task_id}`)
      }

      const taskID = randomUUID()
      const at = this.now()
      this.db
        .query(
          `INSERT INTO watch_tasks (
            task_id, ledger_id, schema_version, protocol_version,
            initiator_session_id, target_session_id, goal, mode,
            watch_state, task_state, version, generation, owner_activation,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'alert', 'active', 'not-started', 1, 1, ?, ?, ?)`,
        )
        .run(
          taskID,
          this.ledgerId,
          WATCH_LEDGER_SCHEMA_VERSION,
          WATCH_LEDGER_PROTOCOL_VERSION,
          initiator,
          target,
          goal,
          owner,
          at,
          at,
        )
      this.db
        .query(
          "INSERT INTO enrollment_requests (request_id, task_id, session_id, params_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(requestId, taskID, target, fingerprint, at)
      return { task: this.task(taskID), created: true }
    })
  }

  show(input: { readonly taskID?: string; readonly sessionID: string }): LedgerResult<WatchTaskRecord | null> {
    const sessionID = requiredIdentifier(input.sessionID, "sessionID")
    return this.read(() => {
      if (input.taskID !== undefined) {
        const taskID = requiredIdentifier(input.taskID, "taskID")
        const row = this.taskRow(taskID)
        if (row === null) return null
        if (row.target_session_id !== sessionID && row.initiator_session_id !== sessionID) return null
        return taskFromRow(row)
      }
      const row = this.db
        .query(
          `SELECT * FROM watch_tasks
           WHERE target_session_id = ? OR initiator_session_id = ?
           ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        )
        .get(sessionID, sessionID) as TaskRow | null
      return row === null ? null : taskFromRow(row)
    })
  }

  report(input: ReportWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly duplicate: boolean }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const reportID = requiredIdentifier(input.reportId, "reportId")
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new LedgerFailure("invalid_input", "expectedVersion must be a positive integer")
      }
      const kind = readReportKind(input.kind)
      if (!kind.ok) throw new LedgerFailure("invalid_input", kind.reason)
      const evidence = readEvidence(kind.value, input.evidence)
      if (!evidence.ok) throw new LedgerFailure("invalid_input", evidence.reason)

      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.target_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the target session may report on this task")
      }

      const existing = this.db
        .query("SELECT * FROM watch_reports WHERE task_id = ? AND report_id = ?")
        .get(taskID, reportID) as ReportRow | null
      if (existing !== null) {
        if (existing.kind !== kind.value || existing.evidence !== canonicalJson(evidence.value)) {
          throw new LedgerFailure("report_conflict", "that report id was used with different evidence")
        }
        return { task: taskFromRow(task), duplicate: true }
      }

      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure(
          "stale_version",
          `the task is at version ${task.version}, not ${input.expectedVersion}`,
        )
      }
      if (task.watch_state === "ended") {
        throw new LedgerFailure("ended", "the watch has ended; reports are no longer recorded")
      }
      if (task.watch_state === "paused") {
        // Pausing stops proactive reminders, not the business task; a report
        // may still arrive and is recorded.
      }
      const next = nextTaskState(task.task_state as WatchedTaskState, kind.value)
      if (!next.ok) throw new LedgerFailure("invalid_transition", next.reason)

      const at = this.now()
      const version = task.version + 1
      const encoded = canonicalJson(evidence.value)
      const completedAt = next.value === "completed" ? at : task.completed_at
      // Completion ends supervision: the business goal is done, so the live
      // slot is released. The task row and its reports remain as history; this
      // is not a manual "end", which is what must not be read as success.
      const completes = next.value === "completed"
      const watchState = completes ? "ended" : task.watch_state
      const endedAt = completes ? at : task.ended_at
      this.db
        .query(
          "INSERT INTO watch_reports (task_id, report_id, kind, evidence, version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(taskID, reportID, kind.value, encoded, version, at)
      this.db
        .query(
          `UPDATE watch_tasks SET
            task_state = ?, watch_state = ?, version = ?, updated_at = ?,
            last_report_id = ?, last_report_kind = ?, last_report_evidence = ?,
            last_report_at = ?, last_report_version = ?, completed_at = ?, ended_at = ?
           WHERE task_id = ?`,
        )
        .run(
          next.value,
          watchState,
          version,
          at,
          reportID,
          kind.value,
          encoded,
          at,
          version,
          completedAt,
          endedAt,
          taskID,
        )
      return { task: this.task(taskID), duplicate: false }
    })
  }

  control(input: ControlWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly changed: boolean }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new LedgerFailure("invalid_input", "expectedVersion must be a positive integer")
      }
      if (input.operation !== "pause" && input.operation !== "end") {
        throw new LedgerFailure("invalid_input", "operation must be pause or end")
      }
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the enrolling session may control this task")
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure(
          "stale_version",
          `the task is at version ${task.version}, not ${input.expectedVersion}`,
        )
      }
      if (task.watch_state === "ended") {
        if (input.operation === "end") return { task: taskFromRow(task), changed: false }
        throw new LedgerFailure("ended", "the watch has ended")
      }
      if (input.operation === "pause" && task.watch_state === "paused") {
        return { task: taskFromRow(task), changed: false }
      }

      const at = this.now()
      const version = task.version + 1
      if (input.operation === "pause") {
        this.db
          .query("UPDATE watch_tasks SET watch_state = 'paused', version = ?, updated_at = ? WHERE task_id = ?")
          .run(version, at, taskID)
      } else {
        this.db
          .query(
            `UPDATE watch_tasks SET watch_state = 'ended', version = ?, updated_at = ?, ended_at = ?
             WHERE task_id = ?`,
          )
          .run(version, at, at, taskID)
      }
      return { task: this.task(taskID), changed: true }
    })
  }

  secureFiles(): void {
    const targets = [this.path, `${this.path}-wal`, `${this.path}-shm`, anchorPathFor(this.path)]
    for (const target of targets) {
      if (!existsSync(target)) continue
      try {
        chmodSync(target, 0o600)
      } catch (error) {
        // Returning success while a file may be readable by another OS user
        // would contradict the 0600 requirement. Fail closed instead.
        throw new LedgerFailure("readonly", `could not set 0600 on ${target}: ${String(error)}`)
      }
    }
  }

  private task(taskID: string): WatchTaskRecord {
    const row = this.taskRow(taskID)
    if (row === null) throw new LedgerFailure("unknown_task", taskID)
    this.checkLedger(row)
    return taskFromRow(row)
  }

  private taskRow(taskID: string): TaskRow | null {
    return this.db.query("SELECT * FROM watch_tasks WHERE task_id = ?").get(taskID) as TaskRow | null
  }

  private checkLedger(row: TaskRow): void {
    if (row.ledger_id !== this.ledgerId) {
      throw new LedgerFailure("ledger_mismatch", "the task belongs to a different ledger")
    }
  }

  private immediate<T>(fn: () => T): LedgerResult<T> {
    try {
      const value = this.db.transaction(fn).immediate() as T
      this.secureFiles()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, ...mapError(error) }
    }
  }

  private read<T>(fn: () => T): LedgerResult<T> {
    try {
      return { ok: true, value: fn() }
    } catch (error) {
      return { ok: false, ...mapError(error) }
    }
  }
}

function taskFromRow(row: TaskRow): WatchTaskRecord {
  const lastReport =
    row.last_report_id === null
      ? undefined
      : {
          reportID: row.last_report_id,
          kind: parseReportKind(row.last_report_kind),
          evidence: parseEvidence(row.last_report_evidence),
          at: row.last_report_at ?? row.updated_at,
          version: row.last_report_version ?? row.version,
        }
  return {
    taskID: row.task_id,
    initiatorSessionID: row.initiator_session_id,
    targetSessionID: row.target_session_id,
    goal: row.goal,
    mode: "alert",
    watchState: parseWatchState(row.watch_state),
    taskState: parseTaskState(row.task_state),
    version: row.version,
    generation: row.generation,
    ownerActivation: row.owner_activation,
    ...(lastReport === undefined ? {} : { lastReport }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  }
}

function parseWatchState(value: string): WatchState {
  if (value === "active" || value === "paused" || value === "ended") return value
  throw new LedgerFailure("corrupt", `unknown watch state ${value}`)
}

function parseTaskState(value: string): WatchedTaskState {
  if (value === "not-started" || value === "in-progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown task state ${value}`)
}

function parseReportKind(value: string | null): WatchReportKind {
  if (value === "begin" || value === "progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown report kind ${String(value)}`)
}

function parseEvidence(value: string | null): WatchEvidence {
  if (value === null) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("evidence is not an object")
    }
    return parsed as WatchEvidence
  } catch (error) {
    throw new LedgerFailure("corrupt", `stored evidence is unreadable: ${String(error)}`)
  }
}

function requiredIdentifier(value: string, field: string): string {
  const checked = readIdentifier(value, field)
  if (!checked.ok) throw new LedgerFailure("invalid_input", checked.reason)
  return checked.value
}

function requiredGoal(value: string): string {
  const checked = readGoal(value)
  if (!checked.ok) throw new LedgerFailure("invalid_input", checked.reason)
  return checked.value
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => Number.parseInt(part, 10))
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

function mapError(error: unknown): { readonly code: WatchLedgerErrorCode; readonly detail: string } {
  if (error instanceof LedgerFailure) return { code: error.code, detail: error.detail }
  const code = (error as { code?: unknown } | null)?.code
  const text = error instanceof Error ? error.message : String(error)
  if (typeof code === "string") {
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { code: "lock_timeout", detail: text }
    if (code === "SQLITE_READONLY") return { code: "readonly", detail: text }
    if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return { code: "corrupt", detail: text }
    if (code.startsWith("SQLITE_CONSTRAINT")) return { code: "conflict", detail: text }
    if (code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN") return { code: "io_error", detail: text }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { code: "readonly", detail: text }
    if (code === "ENOENT") return { code: "io_error", detail: text }
  }
  return { code: "ledger_error", detail: text }
}
