/**
 * The model-facing receipt entry through the real plugin tool.
 *
 * The caller is the host tool context, the correlation is the value carried by
 * the correction prompt, and the ledger remains authoritative. No prompt or
 * generation is caused by receiving a receipt.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import plugin from "../src/index.ts"
import { openWatchLedger } from "../src/watch/ledger.ts"
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
const describeReceipt = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-receipt-"))
  scratch.push(directory)
  return directory
}

const WATCH_OPTIONS = {
  idleMs: 2_000,
  runningSilentMs: 10_000,
  waitOverdueMs: 60_000,
  tickMs: 1_000,
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

interface Seeded {
  readonly taskID: string
  readonly attemptID: string
  readonly correlation: string
}

function seed(state: string, downgrade = false): Seeded {
  const clock = { value: 1_000 }
  const opened = openWatchLedger({
    path: join(state, "watch-ledger.sqlite3"),
    busyTimeoutMs: 2_000,
    openAttempts: 20,
    now: () => clock.value,
  })
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.detail}`)
  const ledger = opened.ledger
  try {
    const enrolled = ledger.enroll({
      requestId: "receipt-task",
      initiatorSessionId: CALLER_SESSION_ID,
      targetSessionId: CALLER_SESSION_ID,
      goal: "receipt seam",
      mode: "alert",
      ownerActivation: "seed-activation",
    })
    if (!enrolled.ok) throw new Error(enrolled.code)
    const taskID = enrolled.value.task.taskID
    const began = ledger.report({
      taskId: taskID,
      callerSessionId: CALLER_SESSION_ID,
      expectedVersion: enrolled.value.task.version,
      reportId: "receipt-begin",
      kind: "begin",
      evidence: {},
    })
    if (!began.ok) throw new Error(began.code)
    const prepared = ledger.prepareCorrectionGrant({
      taskId: taskID,
      callerSessionId: CALLER_SESSION_ID,
      ownerActivation: "seed-activation",
      expectedVersion: began.value.task.version,
      reviewSummary: "receipt test grant",
      deployment: "single-host-same-location",
      at: clock.value,
    })
    if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.detail}`)
    const confirmed = ledger.confirmCorrectionGrant({
      challenge: prepared.value.challenge,
      taskId: taskID,
      callerSessionId: CALLER_SESSION_ID,
      ownerActivation: "seed-activation",
      expectedVersion: prepared.value.expectedVersion,
      generation: prepared.value.generation,
      termsDigest: prepared.value.termsDigest,
      deployment: "single-host-same-location",
      at: clock.value,
    })
    if (!confirmed.ok) throw new Error(`${confirmed.code}: ${confirmed.detail}`)
    const reserved = ledger.reserveCorrection({
      taskId: taskID,
      callerSessionId: CALLER_SESSION_ID,
      ownerActivation: "seed-activation",
      expectedVersion: confirmed.value.task.version,
      generation: confirmed.value.task.generation,
      reservationId: "receipt-attempt",
      at: clock.value,
    })
    if (!reserved.ok) throw new Error(`${reserved.code}: ${reserved.detail}`)
    const claimed = ledger.claimCorrection({
      taskId: taskID,
      reservationId: "receipt-attempt",
      ownerActivation: "seed-activation",
      expectedVersion: reserved.value.task.version,
      generation: confirmed.value.task.generation,
      at: clock.value,
    })
    if (!claimed.ok) throw new Error(`${claimed.code}: ${claimed.detail}`)
    if (downgrade) {
      const shown = ledger.show({ taskID, sessionID: CALLER_SESSION_ID })
      if (!shown.ok || shown.value === null) throw new Error("task missing")
      const downgraded = ledger.downgradeCorrection({
        taskId: taskID,
        callerSessionId: CALLER_SESSION_ID,
        ownerActivation: "seed-activation",
        expectedVersion: shown.value.version,
        at: clock.value,
      })
      if (!downgraded.ok) throw new Error(`${downgraded.code}: ${downgraded.detail}`)
    }
    return { taskID, attemptID: "receipt-attempt", correlation: claimed.value.correlation }
  } finally {
    ledger.close()
  }
}

async function show(host: FakeHost): Promise<WatchPayload> {
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("no RPC surface")
  const payload = readWatchPayload(await rpc.call("watch", { operation: "show", sessionID: CALLER_SESSION_ID }))
  if (payload === undefined) throw new Error("the watch answer is not understood")
  return payload
}

function receipt(host: FakeHost, seeded: Seeded, sessionID = CALLER_SESSION_ID, overrides: Record<string, unknown> = {}) {
  return host.call(
    "peers",
    {
      action: "watch",
      watch: {
        operation: "receipt",
        taskID: seeded.taskID,
        attemptID: seeded.attemptID,
        correlation: seeded.correlation,
        ...overrides,
      },
    },
    sessionID,
  )
}

describeReceipt("correction receipt surface", () => {
  test("the real caller receives one permit, duplicates get none and recovery needs new progress", async () => {
    const state = stateDirectory()
    const seeded = seed(state)
    const { host, unload } = await loaded(
      { options: { watch: WATCH_OPTIONS }, sessions: [CALLER_SESSION_ID, "ses_other"] },
      state,
    )
    try {
      const first = await receipt(host, seeded)
      const firstWatch = (first.details as { watch: Record<string, unknown> }).watch
      expect(firstWatch).toMatchObject({
        ok: true,
        continuePermit: true,
        duplicate: false,
        seen: true,
        refusalReason: null,
      })
      expect(firstWatch["correlation"]).toBeUndefined()
      expect(first.text).toContain("One continue permit")
      expect(first.text).not.toContain(seeded.correlation)
      expect((await show(host)).task?.correction.history[0]).toMatchObject({
        phase: "receipted",
        receipt: { continuePermitIssuedAt: expect.any(Number) },
      })

      const duplicate = await receipt(host, seeded)
      expect((duplicate.details as { watch: Record<string, unknown> }).watch).toMatchObject({
        continuePermit: false,
        duplicate: true,
      })
      expect(duplicate.text).toContain("already recorded")

      const wrongToken = await receipt(host, seeded, CALLER_SESSION_ID, { correlation: "forged" })
      expect((wrongToken.details as { watch: { failure: { code: string } } }).watch.failure.code).toBe(
        "E_WATCH_REPORT_CONFLICT",
      )
      const wrongCaller = await receipt(host, seeded, "ses_other")
      expect((wrongCaller.details as { watch: { failure: { code: string } } }).watch.failure.code).toBe(
        "E_WATCH_CALLER_MISMATCH",
      )

      const task = (await show(host)).task
      await host.advance(1_000)
      const progress = await host.call("peers", {
        action: "watch",
        watch: {
          operation: "report",
          taskID: seeded.taskID,
          expectedVersion: task?.version,
          reportId: "receipt-progress",
          kind: "progress",
          evidence: { summary: "new checkpoint", reference: "receipt-new-result" },
        },
      })
      expect((progress.details as { watch: { ok: boolean } }).watch.ok).toBe(true)
      expect((await show(host)).task?.correction.history[0]).toMatchObject({
        phase: "recovered",
        recovery: { resultReference: "receipt-new-result" },
      })
      expect(host.prompts).toEqual([])
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("a downgraded grant records seen but issues no permit", async () => {
    const state = stateDirectory()
    const seeded = seed(state, true)
    const { host, unload } = await loaded({ options: { watch: WATCH_OPTIONS } }, state)
    try {
      const result = await receipt(host, seeded)
      const watch = (result.details as { watch: Record<string, unknown> }).watch
      expect(watch).toMatchObject({
        ok: true,
        continuePermit: false,
        duplicate: false,
        seen: true,
        refusalReason: "grant-changed",
      })
      expect(result.text).toContain("no continue permit")
      expect(host.prompts).toEqual([])
    } finally {
      await unload()
    }
  })
})
