/**
 * Observation and persistent alerts through the real plugin entry.
 *
 * Execution lifecycle is emitted as host events, the clock is advanced through
 * the fake scheduler, and permission/form waits are deterministic fixtures.
 * The assertions are on the RPC/view a user receives and on the absence of
 * prompts, generations or interrupts — never on an internal function.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AskRecord } from "../src/domain/types.ts"
import { askKey } from "../src/host/storage.ts"
import { Database } from "bun:sqlite"

import plugin from "../src/index.ts"
import { WATCH_STATE_DIR_ENV } from "../src/host/watch.ts"
import { readWatchPayload, type WatchPayload } from "../src/rpc.ts"
import { CALLER_SESSION_ID, fakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.ts"

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
const describeWatch = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-observe-state-"))
  scratch.push(directory)
  return directory
}

const WATCH_OPTIONS = {
  idleMs: 2_000,
  runningSilentMs: 10_000,
  waitOverdueMs: 60_000,
  tickMs: 1_000,
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

async function enroll(host: FakeHost, requestId = "observe-req", sessionID = CALLER_SESSION_ID) {
  const result = await host.call(
    "peers",
    {
      action: "watch",
      watch: { operation: "enroll", requestId, goal: "Observe this task" },
    },
    sessionID,
  )
  const task = (result.details as { watch: { task: { taskID: string } } }).watch.task
  return task.taskID
}

async function show(host: FakeHost): Promise<WatchPayload> {
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("no RPC surface")
  const payload = readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID }))
  if (payload === undefined) throw new Error("the watch answer is not understood")
  return payload
}

function settle(host: FakeHost, at: number, created = true) {
  if (created) host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
  host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
  host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
  host.setBusy(CALLER_SESSION_ID, at)
  host.setIdle(CALLER_SESSION_ID, at)
}

function expectNoAgentCalls(host: FakeHost): void {
  expect(host.prompts).toEqual([])
  expect(host.generations).toEqual([])
  expect(host.interrupts).toEqual([])
}

describeWatch("trusted idle and running observation", () => {
  test("an existing session without a created event is unknown even after a fresh terminal", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at, false)
      await enroll(host)
      await host.advance(1_000)
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.observation?.trusted).toBe(false)
      expect(payload.observation?.waitsPartial).toBe(true)
      expect(payload.observation?.reason).toContain("predates continuous observation")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a terminal execution plus a sustained idle window forms one persistent alert", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      const taskID = await enroll(host)
      await host.advance(1_000)
      let payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "active", trusted: true, idleSince: at })
      expect(payload.alerts?.items).toEqual([])

      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation).toMatchObject({
        state: "idle-candidate",
        trusted: true,
        effective: { idleMs: 2_000, runningSilentMs: 10_000, waitOverdueMs: 60_000 },
      })
      expect(payload.alerts?.items).toHaveLength(1)
      expect(payload.alerts?.items[0]).toMatchObject({
        taskID,
        kind: "idle",
        state: "unread",
        summary: expect.any(String),
      })
      expect(payload.alerts?.unread).toBe(1)
      expect(JSON.stringify(payload.alerts)).not.toContain("Observe this task")
      expectNoAgentCalls(host)

      // The same continuing problem updates the same alert rather than adding
      // another one; a second observation tick supplies the one escalation fact.
      await host.advance(1_000)
      const updated = await show(host)
      expect(updated.alerts?.items).toHaveLength(1)
      expect(updated.alerts?.items[0]?.alertID).toBe(payload.alerts?.items[0]?.alertID)
      expect(updated.alerts?.items[0]?.escalatedAt).toBeNumber()

      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      const acked = readWatchPayload(
        await rpc.call("watch", {
          operation: "ack",
          sessionID: CALLER_SESSION_ID,
          alertID: payload.alerts?.items[0]?.alertID,
        }),
      )
      expect(acked?.alerts?.items[0]).toMatchObject({ state: "read", readAt: expect.any(Number) })
      expect(acked?.alerts?.items[0]?.alertID).toBe(payload.alerts?.items[0]?.alertID)
      expect(acked?.task?.version).toBe(payload.task?.version)
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("running without target activity alerts but never becomes an idle candidate", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      await enroll(host)
      await host.advance(9_000)
      let payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "active", trusted: true })
      expect(payload.alerts?.items ?? []).toEqual([])

      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "running-silence", trusted: true })
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["running-silent"])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("target text is activity and restarts the idle baseline", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.emit("session.text.started", { sessionID: CALLER_SESSION_ID }, host.now())
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      expect((await show(host)).observation?.state).toBe("active")
      await host.advance(1_000)
      expect((await show(host)).observation?.state).toBe("idle-candidate")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("title and inbox admission do not refresh the activity clock", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.emit("session.renamed", { sessionID: CALLER_SESSION_ID }, at + 1_000)
      host.emit("session.inbox.enqueued", { sessionID: CALLER_SESSION_ID }, at + 1_000)
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).not.toBe("idle-candidate")
      expect(payload.alerts?.items ?? []).toEqual([])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeWatch("normal waits", () => {
  test("a same-location permission wait suppresses idle and only alerts after its window", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissions: {
        [CALLER_SESSION_ID]: [{ id: "perm-1", action: "bash", resources: ["echo ok"] }],
      },
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(3_000)
      let payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "normal-waiting", trusted: false })
      expect(payload.observation?.waits).toHaveLength(1)
      expect(payload.observation?.waits[0]).toMatchObject({
        source: "permission",
        object: "permission:bash",
        status: "active",
      })
      expect(payload.alerts?.items ?? []).toEqual([])

      await host.advance(60_000)
      payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["wait-overdue"])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a truncated wait list stays partial and never becomes an idle claim", async () => {
    const permissions = Object.fromEntries([
      [
        CALLER_SESSION_ID,
        Array.from({ length: 15 }, (_, index) => ({
          id: `perm-${index}`,
          action: "bash",
          resources: [`echo ${index}`],
        })),
      ],
    ])
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS }, permissions })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waitsTruncated).toBe(true)
      expect(payload.observation?.waitsPartial).toBe(true)
      expect(payload.observation?.waits).toHaveLength(12)
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a retry event is a normal wait and target activity is its matching termination", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.emit(
        "session.retry.scheduled",
        { sessionID: CALLER_SESSION_ID, attempt: 1, assistantMessageID: "msg-1", at },
        at,
      )
      await enroll(host)
      await host.advance(3_000)
      let payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waits.some((wait) => wait.source === "retry")).toBe(true)
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")

      host.emit("session.text.started", { sessionID: CALLER_SESSION_ID }, host.now())
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.waits.some((wait) => wait.source === "retry" && wait.status === "active")).toBe(
        false,
      )
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a form response clears only the matching form wait", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.setIdle(CALLER_SESSION_ID, at)
      host.emit(
        "form.created",
        { form: { id: "form-a", sessionID: CALLER_SESSION_ID, title: "A", fields: [] } },
        at,
      )
      host.emit(
        "form.created",
        { form: { id: "form-b", sessionID: CALLER_SESSION_ID, title: "B", fields: [] } },
        at,
      )
      await enroll(host)
      await host.advance(1_000)
      host.emit("form.replied", { id: "form-a", sessionID: CALLER_SESSION_ID, answer: {} }, host.now())
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ waitID: "form:form-a", status: "cleared", clearEvidence: "form replied" }),
          expect.objectContaining({ waitID: "form:form-b", status: "active" }),
        ]),
      )
      expect(payload.alerts?.items ?? []).toEqual([])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeWatch("reported waits and control capability", () => {
  test("different reported waits coexist and a clear needs its matching evidence", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      const taskID = await enroll(host)
      let payload = await show(host)
      const begin = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: payload.task?.version,
          reportId: "multi-begin",
          kind: "begin",
          evidence: {},
        },
      })
      const beginVersion = (begin.details as { watch: { task: { version: number } } }).watch.task.version
      const waitOne = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: beginVersion,
          reportId: "multi-wait-a",
          kind: "waiting",
          evidence: {
            waitKind: "human",
            waitFor: "reviewer A",
            reason: "A",
            reference: "ask-a",
            waitID: "wait-a",
          },
        },
      })
      const versionAfterA = (waitOne.details as { watch: { task: { version: number } } }).watch.task.version
      const waitTwo = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: versionAfterA,
          reportId: "multi-wait-b",
          kind: "waiting",
          evidence: {
            waitKind: "human",
            waitFor: "reviewer B",
            reason: "B",
            reference: "ask-b",
            waitID: "wait-b",
          },
        },
      })
      const versionAfterB = (waitTwo.details as { watch: { task: { version: number } } }).watch.task.version
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.waits.map((wait) => wait.waitID)).toEqual(
        expect.arrayContaining(["wait-a", "wait-b"]),
      )

      const badWaitID = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: versionAfterB,
          reportId: "bad-wait-id",
          kind: "waiting",
          evidence: {
            waitKind: "human",
            waitFor: "x",
            reason: "x",
            reference: "x",
            waitID: "bad id",
          },
        },
      })
      expect((badWaitID.details as { watch: { failure: { code: string } } }).watch.failure.code).toBe(
        "E_WATCH_INVALID",
      )

      const missingEvidence = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: versionAfterB,
          reportId: "bad-clear",
          kind: "progress",
          evidence: { summary: "x", reference: "y", clearsWaitID: "wait-a" },
        },
      })
      expect((missingEvidence.details as { watch: { failure: { code: string } } }).watch.failure.code).toBe(
        "E_WATCH_INVALID",
      )

      const clearA = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: versionAfterB,
          reportId: "clear-a",
          kind: "progress",
          evidence: {
            summary: "A answered",
            reference: "reply-a",
            clearsWaitID: "wait-a",
            clearEvidence: "reply-a stored",
          },
        },
      })
      const versionAfterClear = (clearA.details as { watch: { task: { version: number } } }).watch.task.version
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.waits.find((wait) => wait.waitID === "wait-a")?.status).toBe("cleared")
      expect(payload.observation?.waits.find((wait) => wait.waitID === "wait-b")?.status).toBe("active")

      await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: versionAfterClear,
          reportId: "unrelated-progress",
          kind: "progress",
          evidence: { summary: "unrelated", reference: "step" },
        },
      })
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.waits.find((wait) => wait.waitID === "wait-b")?.status).toBe("active")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a reported wait object is shown in DTOs but never copied into a persistent alert", async () => {
    const state = stateDirectory()
    const sentinel = "SENSITIVE-WAIT-OBJECT-9f2c"
    const first = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      const at = first.host.now()
      settle(first.host, at)
      const taskID = await enroll(first.host, "sensitive-wait")
      let payload = await show(first.host)
      const begin = await first.host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: payload.task?.version,
          reportId: "sensitive-begin",
          kind: "begin",
          evidence: {},
        },
      })
      const beginVersion = (begin.details as { watch: { task: { version: number } } }).watch.task.version
      await first.host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: beginVersion,
          reportId: "sensitive-wait",
          kind: "waiting",
          evidence: {
            waitKind: "human",
            waitFor: sentinel,
            reason: "private reason",
            reference: "private-ref",
            waitID: "sensitive-wait",
            waitUntil: at + 1_000,
          },
        },
      })
      await first.host.advance(1_000)
      payload = await show(first.host)
      expect(payload.observation?.waits[0]?.object).toBe(sentinel)
      expect(payload.alerts?.items.map((alert) => alert.kind)).toContain("wait-overdue")
      const rendered = JSON.stringify(payload.alerts)
      expect(rendered).not.toContain(sentinel)
      expect(rendered).not.toContain("private reason")
    } finally {
      await first.unload()
    }

    const second = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      const reconnected = await show(second.host)
      const rendered = JSON.stringify(reconnected.alerts)
      expect(rendered).toContain("wait-overdue")
      expect(rendered).not.toContain(sentinel)
      expect(rendered).not.toContain("private reason")
    } finally {
      await second.unload()
    }
  })

  test("a reported wait has a deadline and only a matching clear entry removes it", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      const taskID = await enroll(host)
      let payload = await show(host)
      const begin = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: payload.task?.version,
          reportId: "begin-1",
          kind: "begin",
          evidence: {},
        },
      })
      const beginVersion = (begin.details as { watch: { task: { version: number } } }).watch.task.version
      await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: beginVersion,
          reportId: "wait-1",
          kind: "waiting",
          evidence: {
            waitKind: "human",
            waitFor: "the reviewer",
            reason: "needs approval",
            reference: "ask-1",
            waitID: "wait-1",
            waitUntil: at + 5_000,
          },
        },
      })
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waits[0]).toMatchObject({
        waitID: "wait-1",
        source: "reported",
        deadline: at + 5_000,
        status: "active",
      })
      expect(payload.controls.acknowledge).toMatchObject({ enabled: true, reason: null })

      const waitVersion = payload.task?.version
      await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: waitVersion,
          reportId: "progress-unrelated",
          kind: "progress",
          evidence: { summary: "still working", reference: "step-2" },
        },
      })
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waits[0]?.waitID).toBe("wait-1")

      await host.advance(4_000)
      payload = await show(host)
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["wait-overdue"])

      const progressVersion = payload.task?.version
      await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID,
          expectedVersion: progressVersion,
          reportId: "clear-wait",
          kind: "progress",
          evidence: {
            summary: "answer received",
            reference: "reply-1",
            clearsWaitID: "wait-1",
            clearEvidence: "reply stored for this ask",
          },
        },
      })
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.waits.find((wait) => wait.waitID === "wait-1")?.status).toBe("cleared")
      const overdue = payload.alerts?.items.find((alert) => alert.kind === "wait-overdue")
      expect(overdue?.resolvedAt).toBeNumber()
      expect(payload.alerts?.active).toBe(0)
      expect(payload.alerts?.total).toBeGreaterThan(0)
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describeWatch("unknown observation and reloads", () => {
  test("missing execution evidence is unknown, not idle, and does not create an idle alert", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, host.now())
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "unknown", trusted: false })
      expect(payload.observation?.reason).toContain("no local terminal")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a future event timestamp is not trusted", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.emit("session.text.started", { sessionID: CALLER_SESSION_ID }, host.now() + 5_000)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a forward clock/scheduling gap resets the baseline instead of trusting old silence", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.jumpClock(61_000)
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a backwards clock jump resets the baseline too", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.jumpClock(-2_000)
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a host busy time newer than idle is unknown, not a quiet idle", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at + 1_000)
      host.setIdle(CALLER_SESSION_ID, at)
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.observation?.reason).toContain("busy")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a failed terminal is blocked rather than an idle candidate", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.failed", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.setIdle(CALLER_SESSION_ID, at)
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("blocked")
      expect(payload.observation?.reason).toContain("failed")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("an old session cannot regain lifecycle coverage; a later new session ID can", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      sessions: [CALLER_SESSION_ID, "ses_new"],
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host, "old-session")
      await host.advance(1_000)
      host.jumpClock(61_000)
      await host.advance(1_000)

      // A fresh terminal with a consistent snapshot is not enough to recover
      // wait coverage for a session that predates continuous observation.
      const freshAt = host.now()
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, freshAt)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, freshAt)
      host.setBusy(CALLER_SESSION_ID, freshAt)
      host.setIdle(CALLER_SESSION_ID, freshAt)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      await host.advance(1_000)
      let oldPayload = await show(host)
      expect(oldPayload.observation).toMatchObject({ state: "unknown", trusted: false, waitsPartial: true })
      expect(oldPayload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")

      // A duplicate/old session.created for the same identity also cannot
      // restore coverage; only a genuinely new session ID can.
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, host.now())
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      oldPayload = await show(host)
      expect(oldPayload.observation).toMatchObject({ state: "unknown", trusted: false, waitsPartial: true })

      const newAt = host.now()
      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      await rpc.call("watch", {
        operation: "enroll",
        sessionID: "ses_new",
        requestId: "new-session-task",
        goal: "New session task",
      })
      host.emit("session.created", { sessionID: "ses_new" }, newAt)
      host.emit("session.execution.started", { sessionID: "ses_new" }, newAt)
      host.emit("session.execution.succeeded", { sessionID: "ses_new" }, newAt)
      host.setBusy("ses_new", newAt)
      host.setIdle("ses_new", newAt)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      await host.advance(1_000)
      const newer = readWatchPayload(
        await rpc.call("watch", { operation: "show", sessionID: "ses_new" }),
      )
      expect(newer?.observation).toMatchObject({ state: "idle-candidate", trusted: true })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("an uncovered running session can still warn, with partial/trusted false", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      await enroll(host)
      await host.advance(10_000)
      let payload = await show(host)
      expect(payload.observation).toMatchObject({
        state: "running-silence",
        trusted: false,
        waitsPartial: true,
      })
      expect(payload.alerts?.items.map((alert) => alert.kind)).toContain("running-silent")
      expectNoAgentCalls(host)

      host.emit(
        "form.created",
        { form: { id: "form-uncovered", sessionID: CALLER_SESSION_ID, title: "T", fields: [] } },
        host.now(),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.observation?.waits.some((wait) => wait.source === "form")).toBe(true)
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("an event gap resets the baseline and cannot turn old silence into a candidate", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.endEvents()
      await host.advance(10_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("reload starts a new baseline and does not reuse the old quiet period", async () => {
    const state = stateDirectory()
    const first = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    const at = first.host.now()
    settle(first.host, at)
    await enroll(first.host)
    await first.host.advance(1_000)
    await first.unload()

    const second = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      await second.host.advance(1_000)
      const payload = await show(second.host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items ?? []).toEqual([])
      expectNoAgentCalls(second.host)
    } finally {
      await second.unload()
    }
  })
})

describeWatch("alert persistence and availability", () => {
  test("alerts are durable, reconnect without toast state, and ack only changes read state", async () => {
    const state = stateDirectory()
    const first = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    const at = first.host.now()
    settle(first.host, at)
    await enroll(first.host)
    await first.host.advance(2_000)
    const before = await show(first.host)
    const alertID = before.alerts?.items[0]?.alertID
    expect(alertID).toBeString()
    await first.unload()

    const second = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      const reconnected = await show(second.host)
      expect(reconnected.alerts?.items[0]).toMatchObject({ alertID, state: "unread" })
      expect(reconnected.alerts?.unread).toBe(1)
      const rpc = second.host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      const acked = readWatchPayload(
        await rpc.call("watch", { operation: "ack", sessionID: CALLER_SESSION_ID, alertID }),
      )
      expect(acked?.alerts?.items[0]).toMatchObject({ alertID, state: "read" })
      expect(acked?.alerts?.unread).toBe(0)
      expectNoAgentCalls(second.host)
    } finally {
      await second.unload()
    }
  })

  test("pausing stops new alerts but leaves the old alert queryable", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      settle(host, at)
      const taskID = await enroll(host)
      await host.advance(2_000)
      const before = await show(host)
      expect(before.alerts?.items).toHaveLength(1)
      const paused = await host.call("peers", {
        action: "watch",
        watch: { operation: "pause", taskID, expectedVersion: before.task?.version },
      })
      expect((paused.details as { watch: { task: { watchState: string } } }).watch.task.watchState).toBe("paused")
      await host.advance(10_000)
      const after = await show(host)
      expect(after.task?.watchState).toBe("paused")
      expect(after.alerts?.items).toHaveLength(1)
      expect(after.observation?.state).toBe("unavailable")
      expect(after.alerts?.items[0]?.escalatedAt).toBeNull()
      const rpc = host.rpcs[0]
      if (rpc === undefined) throw new Error("no RPC surface")
      const acked = readWatchPayload(
        await rpc.call("watch", {
          operation: "ack",
          sessionID: CALLER_SESSION_ID,
          alertID: after.alerts?.items[0]?.alertID,
        }),
      )
      expect(acked?.alerts?.items[0]).toMatchObject({ state: "read" })
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a missing terminal produces an unknown alert, not an idle alert", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["observation-unknown"])
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a rejected approval becomes blocked evidence and is never treated as permission", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissions: {
        [CALLER_SESSION_ID]: [{ id: "perm-reject", action: "bash", resources: ["rm -rf /tmp/x"] }],
      },
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      expect((await show(host)).observation?.state).toBe("normal-waiting")
      host.setPermissions(CALLER_SESSION_ID, [])
      host.emit(
        "permission.replied",
        { sessionID: CALLER_SESSION_ID, requestID: "perm-reject", reply: "reject" },
        host.now(),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("blocked")
      expect(payload.observation?.waits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            waitID: "permission:perm-reject",
            status: "denied",
            denyEvidence: "permission reply: reject",
          }),
        ]),
      )
      expect(payload.alerts?.items.map((alert) => alert.kind)).toContain("approval-rejected")
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a stored peer ask is a normal wait and its expiry is an overdue notification", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      const ask: AskRecord = {
        askID: "ask-1",
        askerSessionID: CALLER_SESSION_ID,
        askerInstanceID: "instance-caller",
        askerTitle: "caller",
        targetSessionID: "ses_target",
        question: "Please approve",
        createdAt: at,
        expiresAt: at + 5_000,
      }
      await host.storage.set(askKey(ask.askID), ask)
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      expect((await show(host)).observation?.state).toBe("normal-waiting")
      await host.advance(5_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("normal-waiting")
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["wait-overdue"])
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("an unavailable ledger is reported by the alert view, not as an empty successful list", async () => {
    const state = stateDirectory()
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "watch-ledger.sqlite3"), "not sqlite")
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      const payload = await show(host)
      expect(payload.alerts).toMatchObject({ available: false, items: [], reason: expect.any(String) })
      expect(payload.observation).toBeNull()
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("pausing while a slow sample is in flight cannot create a new alert", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissions: {
        [CALLER_SESSION_ID]: [{ id: "perm-slow", action: "bash", resources: ["echo"] }],
      },
      permissionDelayMs: 30,
    })
    try {
      const at = host.now()
      settle(host, at)
      const taskID = await enroll(host)
      const before = await show(host)
      const advance = host.advance(1_000)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await host.call("peers", {
        action: "watch",
        watch: { operation: "pause", taskID, expectedVersion: before.task?.version },
      })
      await advance
      const after = await show(host)
      expect(after.task?.watchState).toBe("paused")
      expect(after.alerts?.items ?? []).toEqual([])
      expect(after.observation?.state).toBe("unavailable")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("overflowed unknown waits keep the observation conservative after visible waits are answered", async () => {
    const permissions = {
      [CALLER_SESSION_ID]: Array.from({ length: 7 }, (_, index) => ({
        id: `perm-overflow-${index}`,
        action: "bash",
        resources: [`echo ${index}`],
      })),
    }
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS }, permissions })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.setPermissions(CALLER_SESSION_ID, [])
      await host.advance(1_000)
      await host.advance(1_000)
      const overflowed = await show(host)
      expect(overflowed.observation?.state).toBe("unknown")
      expect(overflowed.observation?.waitsPartial).toBe(true)
      expect(overflowed.observation?.waits).toHaveLength(6)
      const visibleIDs = (overflowed.observation?.waits ?? []).map((wait) => wait.waitID)
      for (const waitID of visibleIDs) {
        const requestID = waitID.replace("permission:", "")
        host.emit(
          "permission.replied",
          { sessionID: CALLER_SESSION_ID, requestID, reply: "once" },
          host.now(),
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(1_000)
      const afterReplies = await show(host)
      expect(afterReplies.observation?.state).toBe("unknown")
      expect(afterReplies.observation?.trusted).toBe(false)
      expect(afterReplies.observation?.waitsPartial).toBe(true)
      expect(afterReplies.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a denied wait survives more than the cleared-history bound", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissions: {
        [CALLER_SESSION_ID]: [{ id: "perm-sticky", action: "bash", resources: ["echo"] }],
      },
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.setPermissions(CALLER_SESSION_ID, [])
      host.emit(
        "permission.replied",
        { sessionID: CALLER_SESSION_ID, requestID: "perm-sticky", reply: "reject" },
        host.now(),
      )
      for (let index = 0; index < 8; index += 1) {
        host.emit(
          "form.created",
          { form: { id: `unrelated-${index}`, sessionID: CALLER_SESSION_ID, title: "x", fields: [] } },
          host.now(),
        )
        host.emit(
          "form.replied",
          { id: `unrelated-${index}`, sessionID: CALLER_SESSION_ID, answer: {} },
          host.now(),
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      await host.advance(10_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("blocked")
      expect(payload.observation?.waits.some((wait) => wait.waitID === "permission:perm-sticky" && wait.status === "denied")).toBe(true)
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a permission disappearing without a matching reply is unknown, not approved", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissions: {
        [CALLER_SESSION_ID]: [{ id: "perm-vanish", action: "bash", resources: ["echo"] }],
      },
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(1_000)
      host.setPermissions(CALLER_SESSION_ID, [])
      await host.advance(1_000)
      const payload = await show(host)
      expect(payload.observation?.state).toBe("unknown")
      expect(payload.observation?.waits.some((wait) => wait.status === "unknown")).toBe(true)
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a repeated reply for the same ask produces one cleared wait DTO", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      const ask: AskRecord = {
        askID: "ask-repeat",
        askerSessionID: CALLER_SESSION_ID,
        askerInstanceID: "instance-caller",
        askerTitle: "caller",
        targetSessionID: "ses_target",
        question: "q",
        createdAt: at,
        expiresAt: at + 60_000,
      }
      await host.storage.set(askKey(ask.askID), ask)
      await host.storage.set("v1/replies/ask-repeat", {
        askID: "ask-repeat",
        fromSessionID: "ses_target",
        fromTitle: "target",
        text: "answer",
      })
      settle(host, at)
      await enroll(host)
      await host.advance(10_000)
      const payload = await show(host)
      expect(payload.observation?.waits.filter((wait) => wait.waitID === "ask:ask-repeat")).toHaveLength(1)
      expect(payload.observation?.waits[0]?.status).toBe("cleared")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })

  test("a permission snapshot failure is partial/unknown, never an empty wait list", async () => {
    const { host, unload } = await loaded({
      options: { watch: WATCH_OPTIONS },
      permissionsError: true,
    })
    try {
      const at = host.now()
      settle(host, at)
      await enroll(host)
      await host.advance(3_000)
      const payload = await show(host)
      expect(payload.observation).toMatchObject({ state: "unknown", waitsPartial: true, trusted: false })
      expect(payload.alerts?.items.map((alert) => alert.kind)).not.toContain("idle")
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})
