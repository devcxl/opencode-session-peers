/**
 * The alert-only watch slice, driven through the plugin's real entry points.
 *
 * Each test calls `setup` with a fake host, then uses the registered `peers`
 * tool, the registered `watch` RPC method, the registered `/peers-watch`
 * command and the host's normal model-context hook. Assertions are on what the
 * model/user receives and on host side effects — never on ledger tables or
 * internal call order. The ledger itself is a real SQLite file in a throwaway
 * state directory.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.ts"
import { WATCH_STATE_DIR_ENV } from "../src/host/watch.ts"
import { readWatchPayload } from "../src/rpc.ts"
import { CALLER_SESSION_ID, fakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.ts"

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const runtimeVersion = (() => {
  const db = new Database(":memory:")
  const row = db.query("SELECT sqlite_version() AS version").get() as { version: string }
  db.close()
  return row.version
})()
const safeRuntime = (() => {
  const left = runtimeVersion.split(".").map((part) => Number.parseInt(part, 10))
  const right = [3, 51, 3]
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
})()
const describeSafe = safeRuntime ? describe : describe.skip

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-watch-state-"))
  scratch.push(directory)
  return directory
}

async function loaded(options: FakeHostOptions = {}, state = stateDirectory()) {
  const host = fakeHost(options)
  const previous = process.env[WATCH_STATE_DIR_ENV]
  process.env[WATCH_STATE_DIR_ENV] = state
  let dispose: (() => Promise<void> | void) | undefined
  try {
    dispose = await plugin.setup(host.context)
  } finally {
    if (previous === undefined) delete process.env[WATCH_STATE_DIR_ENV]
    else process.env[WATCH_STATE_DIR_ENV] = previous
  }
  return {
    host,
    state,
    async unload() {
      await dispose?.()
    },
  }
}

function watch(host: FakeHost, input: unknown, sessionID = CALLER_SESSION_ID) {
  return host.call("peers", { action: "watch", watch: input }, sessionID)
}

function details(result: Awaited<ReturnType<FakeHost["call"]>>): Record<string, unknown> {
  return result.details as Record<string, unknown>
}

function watchDetails(result: Awaited<ReturnType<FakeHost["call"]>>): Record<string, unknown> {
  return details(result).watch as Record<string, unknown>
}

async function enrolled(host: FakeHost, requestId = "req-1", goal = "Ship the parser fix") {
  const result = await watch(host, { operation: "enroll", requestId, goal })
  const data = watchDetails(result)
  const task = data.task as Record<string, unknown> | null
  if (task === null) throw new Error(`enrollment failed: ${JSON.stringify(data.failure)}`)
  return {
    taskID: task["taskID"] as string,
    version: task["version"] as number,
  }
}

function expectNoAgentCalls(host: FakeHost): void {
  expect(host.prompts).toEqual([])
  expect(host.generations).toEqual([])
  expect(host.interrupts).toEqual([])
}

describeSafe("watch enrollment and reading", () => {
  test("enrolls the calling session explicitly, then shows the separated states", async () => {
    const { host, unload } = await loaded()
    try {
      const result = await watch(host, {
        operation: "enroll",
        requestId: "req-1",
        goal: "Ship the parser fix",
      })
      const data = watchDetails(result)
      expect(data).toMatchObject({
        ok: true,
        created: true,
        failure: null,
      })
      expect(data.task).toMatchObject({
        goal: "Ship the parser fix",
        mode: "alert",
        watchState: "active",
        taskState: "not-started",
        participation: "not-seen",
        ownership: "this-instance",
        attempts: { used: 0, limit: 3 },
        pause: null,
        version: 1,
      })
      expect(data.capability).toMatchObject({
        mode: "alert",
        monitoring: "observer-alerts",
        automaticDetection: "partial",
        automaticDetectionReason: expect.any(String),
        correction: "unavailable",
        correctionReason: expect.any(String),
        delegation: "unavailable",
        delegationReason: expect.any(String),
        transfer: "unavailable",
        transferReason: expect.any(String),
        recovery: "unavailable",
        recoveryReason: expect.any(String),
        safetyPause: "unavailable",
        safetyPauseReason: expect.any(String),
      })
      expect(data.controls).toMatchObject({
        pause: { enabled: true, reason: null },
        end: { enabled: true, reason: null },
        resume: { enabled: false },
        correction: { enabled: false },
        transfer: { enabled: false },
      })
      expect(result.text).toContain("Task state: not-started")
      expect(result.text).toContain("Supervision: active")
      expect(result.text).toContain("Authorization: alert-only")
      expect(result.text).toContain("Protocol participation: not seen")
      expectNoAgentCalls(host)

      const shown = watchDetails(await watch(host, { operation: "show" }))
      expect(shown.task).toMatchObject({ taskID: (data.task as Record<string, unknown>)["taskID"] })
      expect(shown.ok).toBe(true)
      expect(host.rpcs[0]?.events.some((event) => event.name === "watchChanged")).toBe(true)
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a repeat request is idempotent; another request for the same session is refused", async () => {
    const { host, unload } = await loaded()
    try {
      const first = await enrolled(host, "req-1")
      const repeat = watchDetails(
        await watch(host, { operation: "enroll", requestId: "req-1", goal: "Ship the parser fix" }),
      )
      expect(repeat).toMatchObject({ ok: true, created: false })
      expect((repeat.task as Record<string, unknown>)["taskID"]).toBe(first.taskID)

      const conflicting = watchDetails(
        await watch(host, { operation: "enroll", requestId: "req-1", goal: "A different goal" }),
      )
      expect(conflicting).toMatchObject({ ok: false, failure: { code: "E_WATCH_REQUEST_CONFLICT" } })

      const second = watchDetails(
        await watch(host, { operation: "enroll", requestId: "req-2", goal: "A second task" }),
      )
      expect(second).toMatchObject({ ok: false, failure: { code: "E_WATCH_SESSION_BUSY" } })

      const missingGoal = watchDetails(await watch(host, { operation: "enroll", requestId: "req-no-goal" }))
      expect(missingGoal).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a paused task still occupies the one live slot; ending frees it", async () => {
    const { host, unload } = await loaded()
    try {
      const first = await enrolled(host, "req-1")
      expect(
        watchDetails(await watch(host, { operation: "pause", taskID: first.taskID, expectedVersion: 99 })),
      ).toMatchObject({ ok: false, failure: { code: "E_WATCH_STALE" } })
      const paused = watchDetails(
        await watch(host, { operation: "pause", taskID: first.taskID, expectedVersion: first.version }),
      )
      expect(paused).toMatchObject({
        ok: true,
        changed: true,
        task: { watchState: "paused", pause: { kind: "manual", reason: expect.any(String) } },
      })
      expect(
        watchDetails(await watch(host, { operation: "enroll", requestId: "req-2", goal: "Another task" })),
      ).toMatchObject({ ok: false, failure: { code: "E_WATCH_SESSION_BUSY" } })

      const pausedVersion = (paused.task as Record<string, unknown>)["version"] as number
      const ended = watchDetails(
        await watch(host, { operation: "end", taskID: first.taskID, expectedVersion: pausedVersion }),
      )
      expect(ended).toMatchObject({ ok: true, changed: true, task: { watchState: "ended", taskState: "not-started" } })
      expect((ended.task as Record<string, unknown>)["completedAt"]).toBeNull()
      expect(ended.controls).toMatchObject({ pause: { enabled: false }, end: { enabled: false } })
      expectNoAgentCalls(host)

      expect(
        watchDetails(await watch(host, { operation: "enroll", requestId: "req-3", goal: "A new task" })),
      ).toMatchObject({ ok: true, created: true })
    } finally {
      await unload()
    }
  })
})

describeSafe("watch reports", () => {
  test("accepts begin, progress, waiting, blocked and completed with their evidence", async () => {
    const { host, unload } = await loaded()
    try {
      const task = await enrolled(host)
      let version = task.version
      const report = async (
        kind: string,
        reportId: string,
        evidence: Record<string, unknown>,
      ): Promise<Record<string, unknown> & { text: string }> => {
        const raw = await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: version,
          reportId,
          kind,
          evidence,
        })
        const result = watchDetails(raw)
        expect(result.ok).toBe(true)
        version = (result.task as Record<string, unknown>)["version"] as number
        return { ...result, text: raw.text }
      }

      expect((await report("begin", "r-begin", {})).task).toMatchObject({ taskState: "in-progress", participation: "seen" })
      expect(
        (await report("progress", "r-progress", { summary: "Fixtures pass", reference: "test/parser.test.ts:42" })).task,
      ).toMatchObject({ taskState: "in-progress" })
      expect(
        (
          await report("waiting", "r-wait", {
            waitKind: "human",
            waitFor: "the reviewer",
            reason: "approval needed",
            reference: "ask-42",
          })
        ).task,
      ).toMatchObject({ taskState: "waiting" })
      expect(
        (await report("blocked", "r-blocked", { reason: "missing credentials", reference: "run-7" })).task,
      ).toMatchObject({ taskState: "blocked" })
      const completed = await report("completed", "r-completed", {
        summary: "All parser tests pass",
        reference: "commit abc123",
      })
      expect(completed.task).toMatchObject({
        taskState: "completed",
        watchState: "ended",
        completedAt: expect.any(Number),
        endedAt: expect.any(Number),
      })
      expect(completed.controls).toMatchObject({ pause: { enabled: false }, end: { enabled: false } })
      expect(completed.text).toContain("supervision ended because the task completed")
      expect(completed.text).not.toContain("not a business success")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a repeated report is idempotent, a changed payload conflicts and a stale version is refused", async () => {
    const { host, unload } = await loaded()
    try {
      const task = await enrolled(host)
      const begin = watchDetails(
        await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-begin",
          kind: "begin",
          evidence: {},
        }),
      )
      expect(begin).toMatchObject({ ok: true, duplicate: false })
      const version = (begin.task as Record<string, unknown>)["version"] as number

      const duplicate = watchDetails(
        await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-begin",
          kind: "begin",
          evidence: {},
        }),
      )
      expect(duplicate).toMatchObject({ ok: true, duplicate: true })
      expect((duplicate.task as Record<string, unknown>)["version"]).toBe(version)

      const conflict = watchDetails(
        await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-begin",
          kind: "begin",
          evidence: { summary: "changed" },
        }),
      )
      expect(conflict).toMatchObject({ ok: false, failure: { code: "E_WATCH_REPORT_CONFLICT" } })

      const stale = watchDetails(
        await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-late",
          kind: "progress",
          evidence: { summary: "late", reference: "x" },
        }),
      )
      expect(stale).toMatchObject({ ok: false, failure: { code: "E_WATCH_STALE" } })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a different session cannot report on the task", async () => {
    const { host, unload } = await loaded({ sessions: [CALLER_SESSION_ID, "ses_other"] })
    try {
      const task = await enrolled(host)
      const result = await watch(
        host,
        { operation: "show", taskID: task.taskID },
        "ses_other",
      )
      expect(watchDetails(result).task).toBeNull()

      const report = await watch(
        host,
        {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-other",
          kind: "begin",
          evidence: {},
        },
        "ses_other",
      )
      expect(watchDetails(report)).toMatchObject({ ok: false, failure: { code: "E_WATCH_CALLER_MISMATCH" } })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("ending supervision does not complete the business task", async () => {
    const { host, unload } = await loaded()
    try {
      const task = await enrolled(host)
      const begin = watchDetails(
        await watch(host, {
          operation: "report",
          taskID: task.taskID,
          expectedVersion: 1,
          reportId: "r-begin",
          kind: "begin",
          evidence: {},
        }),
      )
      const version = (begin.task as Record<string, unknown>)["version"] as number

      const ended = watchDetails(
        await watch(host, { operation: "end", taskID: task.taskID, expectedVersion: version }),
      )
      expect(ended.task).toMatchObject({ watchState: "ended", taskState: "in-progress", completedAt: null })
      expect(ended.task).toMatchObject({ endedAt: expect.any(Number) })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeSafe("the normal model context", () => {
  test("carries the task protocol without prompting or generating", async () => {
    const { host, unload } = await loaded()
    try {
      expect(await host.modelContext()).toEqual([])
      const task = await enrolled(host, "req-ctx", "Keep the normal turn moving")

      const system = await host.modelContext()
      expect(system).toHaveLength(1)
      expect(system[0]).toContain("[session-peers watch]")
      expect(system[0]).toContain(task.taskID)
      expect(system[0]).toContain("read it with")
      expect(system[0]).not.toContain("Keep the normal turn moving")
      expect(system[0]).toContain("alert-only")
      expect(system[0]).toContain("not a request to start a new turn")
      expectNoAgentCalls(host)

      expect(await host.modelContext("ses_unrelated")).toEqual([])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeSafe("persistence and reload", () => {
  test("reopening reads the task but does not adopt the old owner", async () => {
    const state = stateDirectory()
    const first = await loaded({}, state)
    const task = await enrolled(first.host, "req-reload", "Survive a reload")
    await first.host.call("peers", {
      action: "watch",
      watch: {
        operation: "report",
        taskID: task.taskID,
        expectedVersion: 1,
        reportId: "r-begin",
        kind: "begin",
        evidence: {},
      },
    })
    await first.unload()

    const second = await loaded({}, state)
    try {
      const shown = watchDetails(await watch(second.host, { operation: "show" }))
      expect(shown.task).toMatchObject({
        taskID: task.taskID,
        watchState: "active",
        taskState: "in-progress",
        participation: "seen",
        ownership: "another-activation",
      })
      expectNoAgentCalls(second.host)

      const context = await second.host.modelContext()
      expect(context[0]).toContain(task.taskID)
      expectNoAgentCalls(second.host)
    } finally {
      await second.unload()
    }
  })

  test("a missing database with an identity anchor fails closed instead of starting empty", async () => {
    const state = stateDirectory()
    const first = await loaded({}, state)
    await enrolled(first.host, "req-lost", "A task that must not be recreated")
    await first.unload()

    for (const file of ["watch-ledger.sqlite3", "watch-ledger.sqlite3-wal", "watch-ledger.sqlite3-shm"]) {
      rmSync(join(state, file), { force: true })
    }

    const second = await loaded({}, state)
    try {
      const shown = watchDetails(await watch(second.host, { operation: "show" }))
      expect(shown).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNAVAILABLE" } })
      expect(String((shown.failure as Record<string, unknown>)["reason"])).toContain("not recreated")

      const enrolledAgain = watchDetails(
        await watch(second.host, { operation: "enroll", requestId: "req-recreate", goal: "Should not replace" }),
      )
      expect(enrolledAgain).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNAVAILABLE" } })
      expect(enrolledAgain.task).toBeNull()
      expectNoAgentCalls(second.host)
    } finally {
      await second.unload()
    }
  })
})

describeSafe("cross-location isolation", () => {
  test("a location cannot read or control another location's watched task", async () => {
    const state = stateDirectory()
    const alpha = await loaded(
      {
        location: "/work/alpha",
        caller: "ses_alpha",
        sessions: [{ id: "ses_alpha", title: "Alpha" }],
      },
      state,
    )
    const beta = await loaded(
      {
        location: "/work/beta",
        caller: "ses_beta",
        sessions: [{ id: "ses_beta", title: "Beta" }],
      },
      state,
    )
    try {
      const enrolled = watchDetails(
        await alpha.host.call("peers", {
          action: "watch",
          watch: { operation: "enroll", requestId: "alpha-req", goal: "Alpha private goal" },
        }),
      )
      const task = enrolled.task as Record<string, unknown>
      const taskID = task["taskID"] as string
      const before = watchDetails(
        await alpha.host.call("peers", { action: "watch", watch: { operation: "show" } }),
      )

      const rpc = beta.host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      const shown = readWatchPayload(
        await rpc.call("watch", { operation: "show", sessionID: "ses_alpha" }),
      )
      expect(shown).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })
      expect(JSON.stringify(shown)).not.toContain("Alpha private goal")

      const crossEnroll = readWatchPayload(
        await rpc.call("watch", {
          operation: "enroll",
          sessionID: "ses_alpha",
          requestId: "beta-cross",
          goal: "Must not enroll",
        }),
      )
      expect(crossEnroll).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })

      const pause = readWatchPayload(
        await rpc.call("watch", {
          operation: "pause",
          sessionID: "ses_alpha",
          taskID,
          expectedVersion: 1,
        }),
      )
      expect(pause).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })

      const end = readWatchPayload(
        await rpc.call("watch", {
          operation: "end",
          sessionID: "ses_alpha",
          taskID,
          expectedVersion: 1,
        }),
      )
      expect(end).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })

      const toolShow = watchDetails(
        await beta.host.call("peers", { action: "watch", watch: { operation: "show" } }, "ses_alpha"),
      )
      expect(toolShow).toMatchObject({ ok: false, failure: { code: "E_WATCH_NOT_FOUND" } })

      const toolPause = watchDetails(
        await beta.host.call(
          "peers",
          { action: "watch", watch: { operation: "pause", taskID, expectedVersion: 1 } },
          "ses_alpha",
        ),
      )
      expect(toolPause).toMatchObject({ ok: false, failure: { code: "E_WATCH_NOT_FOUND" } })

      const report = watchDetails(
        await beta.host.call(
          "peers",
          {
            action: "watch",
            watch: {
              operation: "report",
              taskID,
              expectedVersion: 1,
              reportId: "beta-report",
              kind: "begin",
              evidence: {},
            },
          },
          "ses_alpha",
        ),
      )
      expect(report).toMatchObject({ ok: false, failure: { code: "E_WATCH_NOT_FOUND" } })

      await expect(
        beta.host.runCommand("peers-watch", "ses_alpha", `end ${taskID} 1`),
      ).rejects.toThrow("this location does not serve this session")

      expect(await beta.host.modelContext("ses_alpha")).toEqual([])

      const after = watchDetails(
        await alpha.host.call("peers", { action: "watch", watch: { operation: "show" } }),
      )
      expect(after.task).toMatchObject({
        taskID,
        version: (before.task as Record<string, unknown>)["version"],
        watchState: "active",
        taskState: "not-started",
      })
    } finally {
      await alpha.unload()
      await beta.unload()
    }
  })

  test("an unknown or moved session is refused even when no other location is involved", async () => {
    const state = stateDirectory()
    const moved = await loaded(
      {
        location: "/work/moved",
        caller: "ses_moved",
        sessions: [{ id: "ses_moved", title: "Moved", directory: "/work/elsewhere" }],
      },
      state,
    )
    try {
      const rpc = moved.host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      expect(
        readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: "ses_unknown" })),
      ).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })
      expect(
        readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: "ses_moved" })),
      ).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })
      expect(
        readWatchPayload(
          await rpc.call("watch", {
            operation: "enroll",
            sessionID: "ses_moved",
            requestId: "moved-req",
            goal: "Must not enroll",
          }),
        ),
      ).toMatchObject({ task: null, failure: { code: "E_WATCH_NOT_FOUND" } })
    } finally {
      await moved.unload()
    }
  })
})

describe("explicit unavailable capabilities", () => {
  test("correction, transfer and recovery are refused; delegation needs a controlled grant and the reserved fields", async () => {
    const { host, unload } = await loaded({ sessions: [CALLER_SESSION_ID, "ses_child"] })
    try {
      for (const operation of ["grant", "correct", "transfer", "resume"]) {
        const data = watchDetails(await watch(host, { operation }))
        expect(data).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNSUPPORTED" } })
        expect(String((data.failure as Record<string, unknown>)["reason"]).length).toBeGreaterThan(0)
      }

      const delegateMissing = watchDetails(await watch(host, { operation: "delegate" }))
      expect(delegateMissing).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
      expect(String((delegateMissing.failure as Record<string, unknown>)["reason"])).toContain("delegate needs")

      const manualCorrect = watchDetails(await watch(host, { operation: "correct" }))
      expect(manualCorrect).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNSUPPORTED" } })
      expect(String((manualCorrect.failure as Record<string, unknown>)["reason"])).toContain("Manual correction")

      const missingReceipt = watchDetails(await watch(host, { operation: "receipt" }))
      expect(missingReceipt).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
      expect(String((missingReceipt.failure as Record<string, unknown>)["reason"])).toContain("receipt needs")

      const correctionMode = watchDetails(
        await watch(host, { operation: "enroll", requestId: "req-correct", goal: "A task", mode: "correct" }),
      )
      expect(correctionMode).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNSUPPORTED" } })

      const child = watchDetails(
        await watch(host, {
          operation: "enroll",
          requestId: "req-child",
          goal: "A child task",
          targetSessionID: "ses_child",
        }),
      )
      expect(child).toMatchObject({ ok: false, failure: { code: "E_WATCH_INVALID" } })
      expect(String((child.failure as Record<string, unknown>)["reason"])).toContain("non-self enroll")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describe("ledger failure is visible and does not break peers", () => {
  test("a corrupt ledger refuses watch but leaves the peer surface usable", async () => {
    const state = stateDirectory()
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "watch-ledger.sqlite3"), "not sqlite")
    const { host, unload } = await loaded({}, state)
    try {
      const status = await host.call("peers", { action: "status" })
      expect(status.details).toMatchObject({ connected: true })

      const result = await watch(host, { operation: "enroll", requestId: "req-corrupt", goal: "A task" })
      const data = watchDetails(result)
      expect(data).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNAVAILABLE" } })
      expect(String((data.failure as Record<string, unknown>)["reason"])).toContain("No watched task was created")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeSafe("the watch RPC entry point", () => {
  test("reads, enrolls and controls the same task", async () => {
    const { host, unload } = await loaded()
    try {
      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")

      const empty = readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID }))
      expect(empty?.enabled).toBe(true)
      expect(empty?.ledger.available).toBe(true)
      expect(empty?.task).toBeNull()

      const enrolledPayload = readWatchPayload(
        await rpc.call("watch", {
          operation: "enroll",
          sessionID: CALLER_SESSION_ID,
          requestId: "rpc-req-1",
          goal: "An RPC-enrolled task",
        }),
      )
      expect(enrolledPayload?.task).toMatchObject({
        goal: "An RPC-enrolled task",
        watchState: "active",
        attempts: { used: 0, limit: 3 },
        pause: null,
      })
      const taskID = enrolledPayload?.task?.taskID
      expect(taskID).toBeString()

      const shown = readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID }))
      expect(shown?.task?.taskID).toBe(taskID)

      const paused = readWatchPayload(
        await rpc.call("watch", {
          operation: "pause",
          sessionID: CALLER_SESSION_ID,
          taskID,
          expectedVersion: 1,
        }),
      )
      expect(paused?.task).toMatchObject({
        watchState: "paused",
        pause: { kind: "manual", reason: expect.any(String) },
        version: 2,
      })
      expect(paused?.controls.pause.enabled).toBe(false)

      const ended = readWatchPayload(
        await rpc.call("watch", {
          operation: "end",
          sessionID: CALLER_SESSION_ID,
          taskID,
          expectedVersion: 2,
        }),
      )
      expect(ended?.task).toMatchObject({ watchState: "ended", taskState: "not-started" })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

})

describe("the /peers-watch command", () => {
  test("is registered and its default is read-only", async () => {
    const { host, unload } = await loaded()
    try {
      const command = host.commands.find((item) => item.name === "peers-watch")
      expect(command).toBeDefined()
      await host.runCommand("peers-watch", CALLER_SESSION_ID, "")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeSafe("the /peers-watch enrollment", () => {
  test("enrolls through the same application as the tool", async () => {
    const { host, unload } = await loaded()
    try {
      await host.runCommand("peers-watch", CALLER_SESSION_ID, "enroll A command-enrolled task")
      const shown = watchDetails(await watch(host, { operation: "show" }))
      expect(shown.task).toMatchObject({ goal: "A command-enrolled task", watchState: "active" })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describe("a disabled plugin", () => {
  test("still answers the RPC without touching the ledger", async () => {
    const { host, unload } = await loaded({ options: { enabled: false } })
    try {
      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      const payload = readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID }))
      expect(payload).toMatchObject({
        enabled: false,
        task: null,
        failure: { code: "E_WATCH_DISABLED" },
      })
      expect(payload?.ledger.available).toBe(false)
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})
