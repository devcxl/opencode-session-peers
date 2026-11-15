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
import plugin from "../src/index.ts"
import { WATCH_STATE_DIR_ENV } from "../src/host/watch.ts"
import { readWatchPayload, type WatchPayload } from "../src/rpc.ts"
import { CALLER_SESSION_ID, fakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.ts"

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

async function enroll(host: FakeHost, requestId = "observe-req") {
  const result = await host.call("peers", {
    action: "watch",
    watch: { operation: "enroll", requestId, goal: "Observe this task" },
  })
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

function settle(host: FakeHost, at: number) {
  host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
  host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
  host.setIdle(CALLER_SESSION_ID, at)
}

function expectNoAgentCalls(host: FakeHost): void {
  expect(host.prompts).toEqual([])
  expect(host.generations).toEqual([])
  expect(host.interrupts).toEqual([])
}

describe("trusted idle and running observation", () => {
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
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
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

describe("normal waits", () => {
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

  test("a form response clears only the matching form wait", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
      const at = host.now()
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
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

describe("reported waits and control capability", () => {
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
      expect(payload.observation?.waits.some((wait) => wait.waitID === "wait-1")).toBe(false)
      const overdue = payload.alerts?.items.find((alert) => alert.kind === "wait-overdue")
      expect(overdue?.resolvedAt).toBeNumber()
      expectNoAgentCalls(host)
    } finally {
      await unload()
    }
  })
})

describe("unknown observation and reloads", () => {
  test("missing execution evidence is unknown, not idle, and does not create an idle alert", async () => {
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } })
    try {
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

describe("alert persistence and availability", () => {
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
      expect(payload.alerts?.items.map((alert) => alert.kind)).toEqual(["approval-rejected"])
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
        askerSessionID: "ses_asker",
        askerInstanceID: "instance-asker",
        askerTitle: "asker",
        targetSessionID: CALLER_SESSION_ID,
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
