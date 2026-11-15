/**
 * The watchdog's security ledger, against a real SQLite file.
 *
 * This is the persistence seam: the tests open the same database the plugin
 * will open, through the ledger's own interface, and assert only what a caller
 * can see. They never read a table directly, so a schema change that keeps the
 * interface is not a test failure — while a missing file, reused quota or
 * recreated task is.
 *
 * The SQLite build matters: the ledger refuses to run on a SQLite older than
 * 3.51.3, because earlier releases carry the WAL-reset race. The default Bun on
 * this machine embeds 3.51.2, so the positive matrix is skipped there and is
 * run with the verified 1.4.4 binary (see the ticket's verification section).
 * The refusal itself is tested on every runtime.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { WatchEvidence, WatchReportKind } from "../src/domain/watch.ts"
import { openWatchLedger, type WatchLedger } from "../src/watch/ledger.ts"
import { mapLedgerFailure } from "../src/watch/service.ts"

const ROOT = mkdtempSync(join(tmpdir(), "session-peers-watch-ledger-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

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

const runtimeVersion = (() => {
  const db = new Database(":memory:")
  const row = db.query("SELECT sqlite_version() AS version").get() as { version: string }
  db.close()
  return row.version
})()
const safeRuntime = versionAtLeast(runtimeVersion, "3.51.3")
const describeSafe = safeRuntime ? describe : describe.skip

let sequence = 0
function ledgerPath(name: string): string {
  sequence += 1
  return join(ROOT, `${name}-${sequence}`, "opencode-session-peers", "watchdog", "watch-ledger.sqlite3")
}

function open(path = ledgerPath("ledger"), busyTimeoutMs = 250): WatchLedger {
  const opened = openWatchLedger({ path, busyTimeoutMs })
  if (!opened.ok) throw new Error(`ledger did not open: ${opened.code}: ${opened.detail}`)
  return opened.ledger
}

function enrollInput(overrides: Partial<Parameters<WatchLedger["enroll"]>[0]> = {}) {
  return {
    requestId: "req-1",
    initiatorSessionId: "ses_alpha",
    targetSessionId: "ses_alpha",
    goal: "Ship the parser fix",
    mode: "alert" as const,
    ownerActivation: "activation-a",
    ...overrides,
  }
}

function evidence(kind: WatchReportKind): WatchEvidence {
  switch (kind) {
    case "begin":
      return {}
    case "progress":
      return { summary: "Parser fixtures now pass", reference: "test/parser.test.ts:42" }
    case "waiting":
      return { waitKind: "human", waitFor: "the reviewer", reason: "needs approval", reference: "ask-42" }
    case "blocked":
      return { summary: "Cannot proceed", reason: "missing credentials", reference: "run-7" }
    case "completed":
      return { summary: "All parser tests pass", reference: "commit abc123" }
  }
}

interface WorkerOutcome {
  readonly ok: boolean
  readonly ledgerId: string
  readonly taskID?: string
  readonly created?: boolean
  readonly code?: string
  readonly detail?: string
}

async function runWorker(path: string, requestId: string, sessionId: string, owner: string): Promise<WorkerOutcome> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "fixtures", "watch-enroll-worker.ts"),
      path,
      requestId,
      sessionId,
      owner,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await child.exited
  const output = (await new Response(child.stdout).text()).trim()
  const error = (await new Response(child.stderr).text()).trim()
  if (exitCode !== 0 || output.length === 0) {
    throw new Error(`watch worker exited ${exitCode}: ${error || output}`)
  }
  return JSON.parse(output) as WorkerOutcome
}

function report(ledger: WatchLedger, taskId: string, version: number, kind: WatchReportKind, id = `report-${kind}`) {
  return ledger.report({
    taskId,
    callerSessionId: "ses_alpha",
    expectedVersion: version,
    reportId: id,
    kind,
    evidence: evidence(kind),
  })
}

describeSafe("the security ledger", () => {
  test("creates a private file and records an alert-only task", () => {
    const path = ledgerPath("private")
    const ledger = open(path)
    try {
      const enrolled = ledger.enroll(enrollInput())
      expect(enrolled.ok).toBe(true)
      if (!enrolled.ok) return
      expect(enrolled.value.created).toBe(true)
      expect(enrolled.value.task).toMatchObject({
        taskID: enrolled.value.task.taskID,
        initiatorSessionID: "ses_alpha",
        targetSessionID: "ses_alpha",
        goal: "Ship the parser fix",
        mode: "alert",
        watchState: "active",
        taskState: "not-started",
        version: 1,
        generation: 1,
        attemptsUsed: 0,
        ownerActivation: "activation-a",
      })
      expect(enrolled.value.task.lastReport).toBeUndefined()

      const shown = ledger.show({ sessionID: "ses_alpha" })
      expect(shown.ok && shown.value?.taskID).toBe(enrolled.value.task.taskID)

      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
      for (const sidecar of [`${path}-wal`, `${path}-shm`, join(dirname(path), "watch-ledger.identity.json")]) {
        if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600)
      }
      expect(existsSync(join(dirname(path), "watch-ledger.identity.json"))).toBe(true)
    } finally {
      ledger.close()
    }
  })

  test("scopes request-id idempotency to the initiator session", () => {
    const ledger = open()
    try {
      const alpha = ledger.enroll(
        enrollInput({ requestId: "req-shared", initiatorSessionId: "ses_a", targetSessionId: "ses_a" }),
      )
      const beta = ledger.enroll(
        enrollInput({ requestId: "req-shared", initiatorSessionId: "ses_b", targetSessionId: "ses_b" }),
      )
      expect(alpha.ok).toBe(true)
      expect(beta.ok).toBe(true)
      if (!alpha.ok || !beta.ok) return
      expect(alpha.value.created).toBe(true)
      expect(beta.value.created).toBe(true)
      expect(alpha.value.task.taskID).not.toBe(beta.value.task.taskID)

      const alphaRepeat = ledger.enroll(
        enrollInput({ requestId: "req-shared", initiatorSessionId: "ses_a", targetSessionId: "ses_a" }),
      )
      expect(alphaRepeat.ok).toBe(true)
      if (alphaRepeat.ok) {
        expect(alphaRepeat.value.created).toBe(false)
        expect(alphaRepeat.value.task.taskID).toBe(alpha.value.task.taskID)
      }

      expect(
        ledger.enroll(
          enrollInput({
            requestId: "req-shared",
            initiatorSessionId: "ses_a",
            targetSessionId: "ses_a",
            goal: "A different goal",
          }),
        ),
      ).toMatchObject({ ok: false, code: "request_conflict" })
      expect(
        ledger.enroll(
          enrollInput({
            requestId: "req-shared",
            initiatorSessionId: "ses_b",
            targetSessionId: "ses_b",
            goal: "A different goal",
          }),
        ),
      ).toMatchObject({ ok: false, code: "request_conflict" })
    } finally {
      ledger.close()
    }
  })

  test("keeps one live task per session, including a paused one", () => {
    const ledger = open()
    try {
      const first = ledger.enroll(enrollInput())
      expect(first.ok).toBe(true)
      if (!first.ok) return

      const sameRequest = ledger.enroll(enrollInput())
      expect(sameRequest.ok).toBe(true)
      if (sameRequest.ok) {
        expect(sameRequest.value.created).toBe(false)
        expect(sameRequest.value.task.taskID).toBe(first.value.task.taskID)
      }

      const differentPayload = ledger.enroll(enrollInput({ goal: "A different goal" }))
      expect(differentPayload).toMatchObject({ ok: false, code: "request_conflict" })

      const differentRequest = ledger.enroll(enrollInput({ requestId: "req-2" }))
      expect(differentRequest).toMatchObject({ ok: false, code: "session_conflict" })

      const paused = ledger.control({
        taskId: first.value.task.taskID,
        callerSessionId: "ses_alpha",
        expectedVersion: 1,
        operation: "pause",
      })
      expect(paused.ok).toBe(true)
      if (paused.ok) expect(paused.value.task.watchState).toBe("paused")

      const whilePaused = ledger.enroll(enrollInput({ requestId: "req-3" }))
      expect(whilePaused).toMatchObject({ ok: false, code: "session_conflict" })

      const ended = ledger.control({
        taskId: first.value.task.taskID,
        callerSessionId: "ses_alpha",
        expectedVersion: 2,
        operation: "end",
      })
      expect(ended.ok).toBe(true)
      if (ended.ok) expect(ended.value.task.watchState).toBe("ended")

      const replacement = ledger.enroll(enrollInput({ requestId: "req-4", goal: "The next task" }))
      expect(replacement.ok).toBe(true)
      if (replacement.ok) expect(replacement.value.created).toBe(true)
    } finally {
      ledger.close()
    }
  })

  test("records evidence in order and makes a repeated report idempotent", () => {
    const ledger = open()
    try {
      const enrolled = ledger.enroll(enrollInput())
      if (!enrolled.ok) throw new Error("enrollment failed")
      const taskId = enrolled.value.task.taskID

      const begin = report(ledger, taskId, 1, "begin")
      expect(begin.ok).toBe(true)
      if (!begin.ok) return
      expect(begin.value.task).toMatchObject({ taskState: "in-progress", version: 2 })

      const progress = report(ledger, taskId, 2, "progress")
      expect(progress.ok).toBe(true)
      if (!progress.ok) return
      expect(progress.value.task).toMatchObject({ taskState: "in-progress", version: 3 })
      expect(progress.value.task.lastReport?.evidence.summary).toBe("Parser fixtures now pass")

      const waiting = report(ledger, taskId, 3, "waiting")
      expect(waiting.ok).toBe(true)
      if (!waiting.ok) return
      expect(waiting.value.task).toMatchObject({ taskState: "waiting", version: 4 })
      expect(waiting.value.task.lastReport?.evidence.waitFor).toBe("the reviewer")

      const blocked = report(ledger, taskId, 4, "blocked")
      expect(blocked.ok).toBe(true)
      if (!blocked.ok) return
      expect(blocked.value.task).toMatchObject({ taskState: "blocked", version: 5 })

      const completed = report(ledger, taskId, 5, "completed")
      expect(completed.ok).toBe(true)
      if (!completed.ok) return
      expect(completed.value.task.taskState).toBe("completed")
      expect(completed.value.task.watchState).toBe("ended")
      expect(completed.value.task.completedAt).toBeNumber()
      expect(completed.value.task.endedAt).toBeNumber()
      expect(completed.value.task.lastReport?.kind).toBe("completed")

      const duplicate = report(ledger, taskId, 5, "completed")
      expect(duplicate.ok).toBe(true)
      if (duplicate.ok) {
        expect(duplicate.value.duplicate).toBe(true)
        expect(duplicate.value.task.version).toBe(6)
      }

      const conflict = ledger.report({
        taskId,
        callerSessionId: "ses_alpha",
        expectedVersion: 5,
        reportId: "report-completed",
        kind: "completed",
        evidence: { summary: "Different evidence", reference: "elsewhere" },
      })
      expect(conflict).toMatchObject({ ok: false, code: "report_conflict" })

      const stale = report(ledger, taskId, 5, "progress", "report-late")
      expect(stale).toMatchObject({ ok: false, code: "stale_version" })

      const wrongCaller = ledger.report({
        taskId,
        callerSessionId: "ses_intruder",
        expectedVersion: 6,
        reportId: "report-intruder",
        kind: "progress",
        evidence: evidence("progress"),
      })
      expect(wrongCaller).toMatchObject({ ok: false, code: "caller_mismatch" })

      const afterCompletion = report(ledger, taskId, 6, "progress", "report-after")
      expect(afterCompletion).toMatchObject({ ok: false, code: "ended" })

      // Completion releases the one live slot, and its history remains.
      const replacement = ledger.enroll(enrollInput({ requestId: "req-after-complete", goal: "The next task" }))
      expect(replacement.ok).toBe(true)
      if (replacement.ok) expect(replacement.value.created).toBe(true)
      expect(ledger.show({ taskID: taskId, sessionID: "ses_alpha" })).toMatchObject({
        ok: true,
        value: { taskState: "completed", watchState: "ended" },
      })
    } finally {
      ledger.close()
    }
  })

  test("rejects a report that does not carry the evidence its state needs", () => {
    const ledger = open()
    try {
      const enrolled = ledger.enroll(enrollInput())
      if (!enrolled.ok) throw new Error("enrollment failed")
      const taskId = enrolled.value.task.taskID
      const missingReference = ledger.report({
        taskId,
        callerSessionId: "ses_alpha",
        expectedVersion: 1,
        reportId: "no-evidence",
        kind: "progress",
        evidence: { summary: "Parser fixtures pass" },
      })
      expect(missingReference).toMatchObject({ ok: false, code: "invalid_input" })
    } finally {
      ledger.close()
    }
  })

  test("keeps the task and its history across a reopen", () => {
    const path = ledgerPath("reopen")
    const first = open(path)
    const enrolled = first.enroll(enrollInput())
    if (!enrolled.ok) throw new Error("enrollment failed")
    const taskId = enrolled.value.task.taskID
    expect(report(first, taskId, 1, "begin")).toMatchObject({ ok: true })
    first.close()

    const second = open(path)
    try {
      const shown = second.show({ taskID: taskId, sessionID: "ses_alpha" })
      expect(shown.ok).toBe(true)
      if (!shown.ok || shown.value === null) return
      expect(shown.value).toMatchObject({
        taskID: taskId,
        taskState: "in-progress",
        version: 2,
      })
      expect(shown.value.lastReport?.kind).toBe("begin")
    } finally {
      second.close()
    }
  })

  test("ends supervision without claiming the business task completed", () => {
    const ledger = open()
    try {
      const enrolled = ledger.enroll(enrollInput())
      if (!enrolled.ok) throw new Error("enrollment failed")
      const taskId = enrolled.value.task.taskID
      expect(report(ledger, taskId, 1, "begin")).toMatchObject({ ok: true })

      const ended = ledger.control({
        taskId,
        callerSessionId: "ses_alpha",
        expectedVersion: 2,
        operation: "end",
      })
      expect(ended.ok).toBe(true)
      if (ended.ok) {
        expect(ended.value.task.watchState).toBe("ended")
        expect(ended.value.task.taskState).toBe("in-progress")
        expect(ended.value.task.completedAt).toBeUndefined()
        expect(ended.value.task.endedAt).toBeNumber()
      }

      expect(report(ledger, taskId, 3, "completed", "late-completion")).toMatchObject({
        ok: false,
        code: "ended",
      })
    } finally {
      ledger.close()
    }
  })

  test("refuses a copied, corrupted or unsupported ledger", () => {
    const path = ledgerPath("identity")
    const first = open(path)
    const enrolled = first.enroll(enrollInput())
    if (!enrolled.ok) throw new Error("enrollment failed")
    first.close()

    const copy = join(ROOT, "copied", "ledger.sqlite3")
    mkdirSync(join(ROOT, "copied"), { recursive: true })
    copyFileSync(path, copy)
    expect(openWatchLedger({ path: copy })).toMatchObject({ ok: false, code: "ledger_path_mismatch" })

    const damaged = ledgerPath("damaged")
    mkdirSync(dirname(damaged), { recursive: true })
    writeFileSync(damaged, "this is not a SQLite database")
    expect(openWatchLedger({ path: damaged })).toMatchObject({ ok: false })

    const versioned = ledgerPath("versioned")
    const versionedLedger = open(versioned)
    versionedLedger.close()
    const db = new Database(versioned)
    db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
    db.close()
    expect(openWatchLedger({ path: versioned })).toMatchObject({ ok: false, code: "unsupported_schema" })

    const target = ledgerPath("target")
    const symlink = join(ROOT, "symlink.sqlite3")
    symlinkSync(target, symlink)
    expect(openWatchLedger({ path: symlink })).toMatchObject({ ok: false, code: "unsafe_path" })

    const realState = join(ROOT, "real-state")
    mkdirSync(realState, { recursive: true })
    const alias = join(ROOT, "state-alias")
    symlinkSync(realState, alias)
    expect(openWatchLedger({ path: join(alias, "watch-ledger.sqlite3") })).toMatchObject({
      ok: false,
      code: "unsafe_path",
    })
    expect(existsSync(join(realState, "watch-ledger.sqlite3"))).toBe(false)

    const lost = ledgerPath("lost")
    const lostLedger = open(lost)
    const lostTask = lostLedger.enroll(enrollInput({ requestId: "req-lost" }))
    expect(lostTask.ok).toBe(true)
    lostLedger.close()
    rmSync(lost)
    expect(openWatchLedger({ path: lost })).toMatchObject({ ok: false, code: "ledger_missing" })
    writeFileSync(lost, "")
    expect(openWatchLedger({ path: lost })).toMatchObject({ ok: false, code: "ledger_missing" })

    const mismatched = ledgerPath("mismatched")
    const mismatchedLedger = open(mismatched)
    expect(mismatchedLedger.enroll(enrollInput({ requestId: "req-mismatch" })).ok).toBe(true)
    mismatchedLedger.close()
    const mismatchedDb = new Database(mismatched)
    mismatchedDb.run("UPDATE meta SET value = 'another-ledger' WHERE key = 'ledger_id'")
    mismatchedDb.close()
    expect(openWatchLedger({ path: mismatched })).toMatchObject({ ok: false, code: "ledger_mismatch" })

    expect(openWatchLedger({ path: ledgerPath("old-runtime"), sqliteVersion: "3.51.2" })).toMatchObject({
      ok: false,
      code: "unsafe_sqlite",
    })

    // A real filesystem permission failure (this test is not portable to a
    // platform without /proc); the ledger must report it, not claim a usable
    // unsecured file.
    if (process.platform === "linux") {
      const denied = openWatchLedger({ path: "/proc/session-peers-watch-test/watch-ledger.sqlite3" })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(["readonly", "io_error"]).toContain(denied.code)
    }
  })

  test("a held write lock times out instead of waiting forever", async () => {
    const path = ledgerPath("locked")
    const ledger = open(path)
    ledger.close()

    const marker = `${path}.lock-held`
    const holder = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "fixtures", "watch-hold-lock.ts"), path, marker, "800"],
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      // Wait until the holder has actually taken the lock.
      for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(existsSync(marker)).toBe(true)
      const contender = openWatchLedger({ path, busyTimeoutMs: 100, openAttempts: 1 })
      expect(contender.ok).toBe(true)
      if (!contender.ok) return
      try {
        expect(
          contender.ledger.enroll(enrollInput({ requestId: "req-lock", ownerActivation: "activation-lock" })),
        ).toMatchObject({ ok: false, code: "lock_timeout" })
      } finally {
        contender.ledger.close()
      }
    } finally {
      await holder.exited
    }
  })
})

describeSafe("schema and integrity gates", () => {
  test("an old schema version is unsupported, not read as the current one", () => {
    const path = ledgerPath("old-schema")
    const ledger = open(path)
    const enrolled = ledger.enroll(enrollInput({ requestId: "req-old-schema" }))
    expect(enrolled.ok).toBe(true)
    ledger.close()

    const db = new Database(path)
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    db.close()
    expect(openWatchLedger({ path })).toMatchObject({ ok: false, code: "unsupported_schema" })

    const previous = new Database(path)
    previous.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'")
    previous.close()
    expect(openWatchLedger({ path })).toMatchObject({ ok: false, code: "unsupported_schema" })
  })

  test("a missing attempts_used column is corrupt, not a zero fallback", () => {
    const path = ledgerPath("missing-attempts")
    const ledger = open(path)
    expect(ledger.enroll(enrollInput({ requestId: "req-missing-attempts" })).ok).toBe(true)
    ledger.close()

    const db = new Database(path)
    db.run("ALTER TABLE watch_tasks DROP COLUMN attempts_used")
    db.close()
    expect(openWatchLedger({ path })).toMatchObject({ ok: false, code: "corrupt" })
  })

  test("a non-integer attempts_used is corrupt, not coerced", () => {
    const path = ledgerPath("bad-attempts")
    const ledger = open(path)
    const enrolled = ledger.enroll(enrollInput({ requestId: "req-bad-attempts" }))
    expect(enrolled.ok).toBe(true)
    ledger.close()

    const db = new Database(path)
    // The CHECK constraint stops an out-of-range write; this real value gets
    // past the range but fails the integer/type integrity gate.
    db.run("UPDATE watch_tasks SET attempts_used = 1.5")
    db.close()
    expect(openWatchLedger({ path })).toMatchObject({ ok: false, code: "corrupt" })
  })

  test("a non-numeric schema string is not truncated into a version", () => {
    const path = ledgerPath("bad-version")
    const ledger = open(path)
    expect(ledger.enroll(enrollInput({ requestId: "req-bad-version" })).ok).toBe(true)
    ledger.close()

    const db = new Database(path)
    db.run("UPDATE meta SET value = '2junk' WHERE key = 'schema_version'")
    db.close()
    expect(openWatchLedger({ path })).toMatchObject({ ok: false, code: "unsupported_schema" })
  })
})

describeSafe("the ledger across independent processes", () => {
  test("six processes sharing one request produce one task", async () => {
    const path = ledgerPath("concurrent-same")
    const workers = Array.from({ length: 6 }, (_, index) =>
      runWorker(path, "req-shared", "ses_alpha", `owner-${index}`),
    )
    const results = await Promise.all(workers)
    const successes = results.filter((result) => result.ok)
    expect(successes).toHaveLength(6)
    expect(new Set(results.map((result) => result.ledgerId)).size).toBe(1)
    expect(new Set(successes.map((result) => result.taskID)).size).toBe(1)
    expect(results.filter((result) => result.created === true)).toHaveLength(1)

    const ledger = open(path)
    try {
      const shown = ledger.show({ sessionID: "ses_alpha" })
      expect(shown.ok).toBe(true)
      if (shown.ok) expect(shown.value?.taskID).toBe(successes[0]?.taskID)
    } finally {
      ledger.close()
    }
  })

  test("six processes with different requests for one session produce one live task", async () => {
    const path = ledgerPath("concurrent-distinct")
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => runWorker(path, `req-${index}`, "ses_race", `owner-${index}`)),
    )
    const winners = results.filter((result) => result.ok)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.created).toBe(true)
    expect(new Set(results.map((result) => result.ledgerId)).size).toBe(1)
    expect(results.filter((result) => result.code === "session_conflict")).toHaveLength(5)
  })
})

describe("a post-commit failure is not described as an unchanged ledger", () => {
  test("says the state may have changed and asks for a re-read", () => {
    const failure = mapLedgerFailure("state_unknown", "chmod denied")
    expect(failure.code).toBe("E_WATCH_UNAVAILABLE")
    expect(failure.reason).toContain("may already have changed")
    expect(failure.reason).toContain("re-read")
    expect(failure.reason).toContain("No automatic retry")
    expect(failure.reason).not.toContain("No watched task was created or changed")
  })
})

describe("the ledger's runtime gate", () => {
  test("reports the SQLite version and refuses one before the WAL-reset fix", () => {
    const path = ledgerPath("old-runtime-gate")
    expect(openWatchLedger({ path, sqliteVersion: "3.51.2" })).toMatchObject({
      ok: false,
      code: "unsafe_sqlite",
    })
    expect(lstatSync(ROOT).isDirectory()).toBe(true)
  })

  test("matches the gate to the runtime it is actually running on", () => {
    expect(runtimeVersion).toBeString()
    const path = ledgerPath("runtime-match")
    const opened = openWatchLedger({ path })
    if (safeRuntime) {
      expect(opened.ok).toBe(true)
      if (opened.ok) opened.ledger.close()
    } else {
      expect(opened).toMatchObject({ ok: false, code: "unsafe_sqlite" })
    }
  })
})
