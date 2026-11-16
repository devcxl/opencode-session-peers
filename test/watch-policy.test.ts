/**
 * The bounded automatic-attempt policy through the plugin entry and the real
 * ledger. The configured policy is fixed at the first reserve; a reload with a
 * different configuration must not extend the persisted episode.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import plugin from "../src/index.ts"
import { openWatchLedger } from "../src/watch/ledger.ts"
import { WATCH_STATE_DIR_ENV } from "../src/host/watch.ts"
import { readWatchGrantPayload, readWatchPayload, type WatchPayload } from "../src/rpc.ts"
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
const describePolicy = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const WATCH_OPTIONS = {
  idleMs: 2_000,
  runningSilentMs: 10_000,
  waitOverdueMs: 60_000,
  tickMs: 1_000,
}

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-policy-"))
  scratch.push(directory)
  return directory
}

async function loaded(options: FakeHostOptions, state: string) {
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
  return { host, async unload() { await dispose?.() } }
}

async function currentTask(host: FakeHost, requestID: string): Promise<{
  readonly taskID: string
  readonly version: number
}> {
  const enrolled = (await host.call("peers", {
    action: "watch",
    watch: { operation: "enroll", requestId: requestID, goal: "policy task" },
  }, CALLER_SESSION_ID)).details as { watch: { task: { taskID: string; version: number } } }
  const task = enrolled.watch.task
  const began = await host.call("peers", {
    action: "watch",
    watch: {
      operation: "report",
      taskID: task.taskID,
      expectedVersion: task.version,
      reportId: `${requestID}-begin`,
      kind: "begin",
      evidence: {},
    },
  }, CALLER_SESSION_ID)
  const beganTask = (began.details as { watch: { task: { version: number } } }).watch.task
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("no RPC surface")
  const prepared = readWatchGrantPayload(
    await rpc.call("watchGrant", {
      operation: "prepare",
      sessionID: CALLER_SESSION_ID,
      taskID: task.taskID,
      expectedVersion: beganTask.version,
      deployment: "single-host-same-location",
    }),
  )
  if (prepared?.challenge === null || prepared?.challenge === undefined) throw new Error("no grant challenge")
  const confirmed = readWatchGrantPayload(
    await rpc.call("watchGrant", {
      operation: "confirm",
      sessionID: CALLER_SESSION_ID,
      taskID: task.taskID,
      expectedVersion: prepared.challenge.expectedVersion,
      generation: prepared.challenge.generation,
      termsDigest: prepared.challenge.termsDigest,
      challenge: prepared.challenge.challenge,
      deployment: "single-host-same-location",
    }),
  )
  expect(confirmed?.ok).toBe(true)
  return { taskID: task.taskID, version: beganTask.version }
}

async function show(host: FakeHost, taskID: string): Promise<WatchPayload> {
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("no RPC surface")
  const payload = readWatchPayload(
    await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID, taskID }),
  )
  if (payload === undefined) throw new Error("show payload was not understood")
  return payload
}

describePolicy("bounded policy through the plugin entry", () => {
  test("the first reserve fixes the episode; a reload with a longer config does not extend it", async () => {
    const state = stateDirectory()
    const firstOptions = {
      watch: {
        ...WATCH_OPTIONS,
        correctionObservationMs: 600_000,
        correctionWindowMs: 2_400_000,
      },
    }
    const first = await loaded({ options: firstOptions }, state)
    let taskID = ""
    let startedAt = 0
    let deadlineAt = 0
    let abortedAt = 0
    try {
      const task = await currentTask(first.host, "policy-fixed")
      taskID = task.taskID
      const opened = openWatchLedger({
        path: join(state, "watch-ledger.sqlite3"),
        busyTimeoutMs: 2_000,
        openAttempts: 20,
        now: () => first.host.now(),
      })
      if (!opened.ok) throw new Error(opened.code)
      try {
        const shown = opened.ledger.show({ taskID: task.taskID, sessionID: CALLER_SESSION_ID })
        if (!shown.ok || shown.value === null) throw new Error("task missing")
        const reserved = opened.ledger.reserveCorrection({
          taskId: task.taskID,
          callerSessionId: CALLER_SESSION_ID,
          ownerActivation: shown.value.ownerActivation,
          expectedVersion: shown.value.version,
          generation: shown.value.generation,
          reservationId: "policy-first",
          at: first.host.now(),
          policy: { observationMs: 600_000, windowMs: 2_400_000 },
        })
        if (!reserved.ok) throw new Error(`${reserved.code}: ${reserved.detail}`)
        startedAt = first.host.now()
        deadlineAt = startedAt + 2_400_000
        const aborted = opened.ledger.abortCorrection({
          taskId: task.taskID,
          reservationId: "policy-first",
          ownerActivation: shown.value.ownerActivation,
          expectedVersion: reserved.value.task.version,
          generation: shown.value.generation,
          at: first.host.now(),
        })
        expect(aborted.ok).toBe(true)
        abortedAt = first.host.now()
      } finally {
        opened.ledger.close()
      }

      const shown = await show(first.host, task.taskID)
      expect(shown.task?.correction).toMatchObject({
        executionPolicy: "bounded-three-attempt",
        attempts: { used: 1, limit: 3 },
        policy: {
          observationMs: 600_000,
          windowMs: 2_400_000,
          windowStartedAt: startedAt,
          windowEndsAt: deadlineAt,
          nextAttemptAt: abortedAt + 600_000,
        },
      })
      expect(shown.task?.correction.history[0]).toMatchObject({ phase: "aborted" })
    } finally {
      await first.unload()
    }

    const second = await loaded(
      {
        options: {
          watch: {
            ...WATCH_OPTIONS,
            correctionObservationMs: 300_000,
            correctionWindowMs: 3_600_000,
          },
        },
      },
      state,
    )
    try {
      const reloaded = await show(second.host, taskID)
      expect(reloaded.task?.correction).toMatchObject({
        executionPolicy: "bounded-three-attempt",
        attempts: { used: 1, limit: 3 },
        policy: {
          observationMs: 600_000,
          windowMs: 2_400_000,
          windowStartedAt: startedAt,
          windowEndsAt: deadlineAt,
          nextAttemptAt: abortedAt + 600_000,
        },
      })
    } finally {
      await second.unload()
    }
  })
})
