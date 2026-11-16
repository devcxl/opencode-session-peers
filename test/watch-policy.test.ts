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

const PATCHED_APP_VERSION = "2.3.0-watchdog-location.1"
const CORRECTION_PREFIX = "[session-peers correction]"

async function pump(host: FakeHost, ms: number): Promise<void> {
  const step = ms >= 60_000 ? 60_000 : 1_000
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await host.advance(step)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function correctionIDs(text: string): { readonly attemptID: string; readonly correlation: string } {
  const match = /attemptID ([^;]+); correlation ([^.\s]+)\./.exec(text)
  const attemptID = match?.[1]
  const correlation = match?.[2]
  if (attemptID === undefined || correlation === undefined) throw new Error("missing correction ids")
  return { attemptID, correlation }
}

describePolicy("public automatic correction through the plugin entry", () => {
  test("the real queue is used three times and never a fourth", async () => {
    const state = stateDirectory()
    const { host, unload } = await loaded(
      {
        appVersion: PATCHED_APP_VERSION,
        options: { watch: { ...WATCH_OPTIONS } },
      },
      state,
    )
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.setIdle(CALLER_SESSION_ID, at)
      const task = await currentTask(host, "public-policy")
      const corrections = () => host.prompts.filter((prompt) => prompt.text.startsWith(CORRECTION_PREFIX))
      expect(corrections()).toHaveLength(0)

      await pump(host, 6_000)
      expect(corrections()).toHaveLength(1)
      expect(corrections()[0]?.delivery).toBe("queue")

      for (let round = 1; round <= 3; round += 1) {
        const prompt = corrections().at(-1)
        if (prompt === undefined) throw new Error("missing correction prompt")
        const { attemptID, correlation } = correctionIDs(prompt.text)
        const receipt = await host.call("peers", {
          action: "watch",
          watch: { operation: "receipt", taskID: task.taskID, attemptID, correlation },
        }, CALLER_SESSION_ID)
        expect((receipt.details as { watch: { ok: boolean; continuePermit: boolean } }).watch).toMatchObject({
          ok: true,
          continuePermit: true,
        })

        const shown = await show(host, task.taskID)
        const version = shown.task?.version
        if (version === undefined) throw new Error("missing task version")
        const progress = await host.call("peers", {
          action: "watch",
          watch: {
            operation: "report",
            taskID: task.taskID,
            expectedVersion: version,
            reportId: `public-progress-${round}`,
            kind: "progress",
            evidence: { summary: `real public result ${round}`, reference: `public-result-${round}` },
          },
        }, CALLER_SESSION_ID)
        expect((progress.details as { watch: { ok: boolean } }).watch.ok).toBe(true)
        const recovered = await show(host, task.taskID)
        expect(recovered.task?.correction.last).toMatchObject({
          phase: "recovered",
          recovery: { resultReference: `public-result-${round}` },
        })

        host.setIdle(CALLER_SESSION_ID, host.now())
        await pump(host, 300_000)
        if (round < 3) {
          expect(corrections()).toHaveLength(round + 1)
        } else {
          expect(corrections()).toHaveLength(3)
        }
      }

      const final = await show(host, task.taskID)
      expect(final.task?.correction.attempts).toMatchObject({ used: 3, limit: 3 })
      expect(final.task?.correction.stop?.reason).toBe("attempt-limit")
      expect(final.task?.correction.history.map((attempt) => attempt.phase)).toEqual([
        "recovered",
        "recovered",
        "recovered",
      ])
      host.setIdle(CALLER_SESSION_ID, host.now())
      await pump(host, 300_000)
      expect(corrections()).toHaveLength(3)
      expect(corrections().every((prompt) => prompt.delivery === "queue")).toBe(true)
      expect(host.generations).toHaveLength(0)
      expect(host.interrupts).toHaveLength(0)
    } finally {
      await unload()
    }
  })
})
