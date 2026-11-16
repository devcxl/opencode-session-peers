/**
 * The complete delegation flow through the real plugin entry.
 *
 * The controlled sibling RPCs are driven as the panel would call them, the
 * model tool is driven as a child/parent would, and the fake host records any
 * prompt, generation or interrupt. The ledger is a real SQLite file.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.ts"
import { WATCH_STATE_DIR_ENV } from "../src/host/watch.ts"
import { readWatchDelegationGrantPayload, readWatchDelegationViewPayload } from "../src/rpc.ts"
import { fakeHost, type FakeHost } from "./fake-host.ts"

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
const describeEntry = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DIRECTORY = "/tmp/opencode/delegation-entry"

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-delegation-entry-"))
  scratch.push(directory)
  return directory
}

interface Loaded {
  readonly host: FakeHost
  readonly rpc: NonNullable<FakeHost["rpcs"][number]>
  readonly unload: () => Promise<void>
}

async function loaded(): Promise<Loaded> {
  const host = fakeHost({
    options: {
      watch: {
        idleMs: 1_000,
        runningSilentMs: 5_000,
        waitOverdueMs: 60_000,
        tickMs: 250,
        correctionObservationMs: 300_000,
        correctionWindowMs: 1_200_000,
      },
    },
    caller: PARENT,
    location: DIRECTORY,
    appVersion: "2.3.0-watchdog-location.1",
    sessions: [
      { id: PARENT, directory: DIRECTORY },
      { id: CHILD, parentID: PARENT, directory: DIRECTORY },
    ],
  })
  const state = stateDirectory()
  const previous = process.env[WATCH_STATE_DIR_ENV]
  process.env[WATCH_STATE_DIR_ENV] = state
  let dispose: (() => Promise<void> | void) | undefined
  try {
    dispose = await plugin.setup(host.context)
  } finally {
    if (previous === undefined) delete process.env[WATCH_STATE_DIR_ENV]
    else process.env[WATCH_STATE_DIR_ENV] = previous
  }
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("the plugin registered no RPC surface")
  return { host, rpc, async unload() { await dispose?.() } }
}

function watchDetails(result: Awaited<ReturnType<FakeHost["call"]>>): Record<string, unknown> {
  return (result.details as Record<string, unknown>).watch as Record<string, unknown>
}

function toolWatch(host: FakeHost, input: unknown, sessionID = PARENT) {
  return host.call("peers", { action: "watch", watch: input }, sessionID)
}

async function enrollParent(host: FakeHost): Promise<{ taskID: string; version: number }> {
  const result = await toolWatch(host, { operation: "enroll", requestId: "parent-1", goal: "Ship the parent" })
  const task = watchDetails(result).task as Record<string, unknown> | null
  if (task === null) throw new Error("parent enrollment failed")
  return { taskID: task["taskID"] as string, version: task["version"] as number }
}

async function grantAndDelegate(host: FakeHost, rpc: NonNullable<FakeHost["rpcs"][number]>, parentTaskID: string, version: number) {
  const preparedRaw = await rpc.call("watchDelegation", {
    operation: "prepare",
    sessionID: PARENT,
    parentTaskID,
    expectedVersion: version,
    targetSessionID: CHILD,
    mode: "limited-correction",
    deployment: "single-host-same-location",
  })
  const prepared = readWatchDelegationGrantPayload(preparedRaw)
  if (prepared === undefined || prepared.challenge === null) throw new Error("prepare failed")
  expect(prepared.review).toMatchObject({ derivesCorrectionGrant: true, deploymentRequired: true })

  const confirmedRaw = await rpc.call("watchDelegation", {
    operation: "confirm",
    sessionID: PARENT,
    parentTaskID,
    expectedVersion: prepared.challenge.expectedVersion,
    generation: prepared.challenge.generation,
    targetSessionID: CHILD,
    mode: prepared.challenge.mode,
    scopeDirectory: prepared.challenge.scopeDirectory,
    scopePeerScope: prepared.challenge.scopePeerScope,
    termsDigest: prepared.challenge.termsDigest,
    challenge: prepared.challenge.challenge,
    deployment: "single-host-same-location",
  })
  const confirmed = readWatchDelegationGrantPayload(confirmedRaw)
  expect(confirmed?.ok).toBe(true)

  const delegated = await toolWatch(host, {
    operation: "delegate",
    taskID: parentTaskID,
    targetSessionID: CHILD,
    requestId: "child-1",
    goal: "Deliver the child work",
    mode: "limited-correction",
    expectedVersion: version,
  })
  const task = watchDetails(delegated).task as Record<string, unknown> | null
  if (task === null) throw new Error(`delegate failed: ${JSON.stringify(watchDetails(delegated).failure)}`)
  return {
    challenge: prepared.challenge,
    childTaskID: task["taskID"] as string,
    childVersion: task["version"] as number,
  }
}

describeEntry("delegation plugin entry", () => {
  test("grant, delegate, child report, parent view, revoke; no agent calls", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      const { childTaskID, childVersion } = await grantAndDelegate(host, rpc, parent.taskID, parent.version)

      const began = await toolWatch(
        host,
        {
          operation: "report",
          taskID: childTaskID,
          expectedVersion: childVersion,
          reportId: "child-begin",
          kind: "begin",
          evidence: {},
        },
        CHILD,
      )
      expect(watchDetails(began).ok).toBe(true)
      const begunVersion = (watchDetails(began).task as Record<string, unknown>)["version"] as number

      const waiting = await toolWatch(
        host,
        {
          operation: "report",
          taskID: childTaskID,
          expectedVersion: begunVersion,
          reportId: "child-waiting",
          kind: "waiting",
          evidence: {
            waitKind: "peer",
            waitFor: "parent review",
            reason: "review required",
            reference: "wait-ref",
          },
        },
        CHILD,
      )
      expect(watchDetails(waiting).ok).toBe(true)

      const viewRaw = await rpc.call("watchDelegationView", {
        sessionID: PARENT,
        parentTaskID: parent.taskID,
      })
      const view = readWatchDelegationViewPayload(viewRaw)
      expect(view?.ok).toBe(true)
      expect(view?.children).toHaveLength(1)
      expect(view?.children[0]).toMatchObject({
        taskID: childTaskID,
        targetSessionID: CHILD,
        authorized: true,
        task: { taskState: "waiting", goal: "Deliver the child work" },
      })

      expect(host.prompts).toEqual([])
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("only the child can report or receipt; the model cannot confirm a grant", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      const { challenge, childTaskID } = await grantAndDelegate(host, rpc, parent.taskID, parent.version)

      const parentReport = await toolWatch(
        host,
        {
          operation: "report",
          taskID: childTaskID,
          expectedVersion: 1,
          reportId: "parent-as-child",
          kind: "begin",
          evidence: {},
        },
        PARENT,
      )
      expect(watchDetails(parentReport)).toMatchObject({
        ok: false,
        failure: { code: "E_WATCH_CALLER_MISMATCH" },
      })

      const parentReceipt = await toolWatch(
        host,
        {
          operation: "receipt",
          taskID: childTaskID,
          attemptID: "missing",
          correlation: "missing",
        },
        PARENT,
      )
      expect(watchDetails(parentReceipt)).toMatchObject({
        ok: false,
        failure: { code: "E_WATCH_CALLER_MISMATCH" },
      })

      const grant = await toolWatch(host, { operation: "grant", taskID: parent.taskID, expectedVersion: parent.version })
      expect(watchDetails(grant)).toMatchObject({ ok: false, failure: { code: "E_WATCH_UNSUPPORTED" } })
      expect(challenge.challenge.length).toBeGreaterThan(0)
      expect(JSON.stringify(watchDetails(grant))).not.toContain(challenge.challenge)
      expect(host.prompts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("revoke makes the child unreadable and stops another delegate without prompting", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      await grantAndDelegate(host, rpc, parent.taskID, parent.version)
      const revokedRaw = await rpc.call("watchDelegation", {
        operation: "revoke",
        sessionID: PARENT,
        parentTaskID: parent.taskID,
        expectedVersion: parent.version,
        targetSessionID: CHILD,
      })
      const revoked = readWatchDelegationGrantPayload(revokedRaw)
      expect(revoked?.ok).toBe(true)
      expect(revoked?.grant).toMatchObject({ state: "revoked" })

      const viewRaw = await rpc.call("watchDelegationView", { sessionID: PARENT, parentTaskID: parent.taskID })
      const view = readWatchDelegationViewPayload(viewRaw)
      expect(view?.children[0]).toMatchObject({ authorized: false, task: null, alerts: null })
      expect(JSON.stringify(view)).not.toContain("Deliver the child work")

      const again = await toolWatch(host, {
        operation: "delegate",
        taskID: parent.taskID,
        targetSessionID: CHILD,
        requestId: "child-after-revoke",
        goal: "Must not enroll",
        mode: "alert",
        expectedVersion: parent.version,
      })
      expect(watchDetails(again)).toMatchObject({ ok: false })
      expect(host.prompts).toEqual([])
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("the delegated child reaches one real queue and its own receipt permit", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      const { childTaskID, childVersion } = await grantAndDelegate(host, rpc, parent.taskID, parent.version)
      const at = host.now()
      host.emit("session.created", { sessionID: CHILD }, at)
      host.emit("session.execution.started", { sessionID: CHILD }, at)
      host.emit("session.execution.succeeded", { sessionID: CHILD }, at)
      host.setBusy(CHILD, at)
      host.setIdle(CHILD, at)
      const began = await toolWatch(
        host,
        {
          operation: "report",
          taskID: childTaskID,
          expectedVersion: childVersion,
          reportId: "executor-begin",
          kind: "begin",
          evidence: {},
        },
        CHILD,
      )
      expect(watchDetails(began).ok).toBe(true)

      for (let tick = 0; tick < 6 && host.prompts.length === 0; tick += 1) {
        await host.advance(1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(host.prompts).toHaveLength(1)
      expect(host.prompts[0]?.delivery).toBe("queue")
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])

      const prompt = host.prompts[0]?.text ?? ""
      const parsed = JSON.parse(/peers\((\{.*\})\)/.exec(prompt)?.[1] ?? "{}") as {
        watch?: { taskID?: string; attemptID?: string; correlation?: string }
      }
      expect(parsed.watch?.taskID).toBe(childTaskID)
      const receipt = await toolWatch(
        host,
        {
          operation: "receipt",
          taskID: parsed.watch?.taskID,
          attemptID: parsed.watch?.attemptID,
          correlation: parsed.watch?.correlation,
        },
        CHILD,
      )
      expect(watchDetails(receipt)).toMatchObject({ ok: true, continuePermit: true, seen: true })
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("a source revoke before receipt records seen without a permit", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      const { childTaskID, childVersion } = await grantAndDelegate(host, rpc, parent.taskID, parent.version)
      const at = host.now()
      host.emit("session.created", { sessionID: CHILD }, at)
      host.emit("session.execution.started", { sessionID: CHILD }, at)
      host.emit("session.execution.succeeded", { sessionID: CHILD }, at)
      host.setBusy(CHILD, at)
      host.setIdle(CHILD, at)
      const began = await toolWatch(
        host,
        {
          operation: "report",
          taskID: childTaskID,
          expectedVersion: childVersion,
          reportId: "revoke-before-receipt-begin",
          kind: "begin",
          evidence: {},
        },
        CHILD,
      )
      expect(watchDetails(began).ok).toBe(true)
      for (let tick = 0; tick < 6 && host.prompts.length === 0; tick += 1) {
        await host.advance(1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(host.prompts).toHaveLength(1)
      const prompt = host.prompts[0]?.text ?? ""
      const parsed = JSON.parse(/peers\((\{.*\})\)/.exec(prompt)?.[1] ?? "{}") as {
        watch?: { taskID?: string; attemptID?: string; correlation?: string }
      }

      await rpc.call("watchDelegation", {
        operation: "revoke",
        sessionID: PARENT,
        parentTaskID: parent.taskID,
        expectedVersion: parent.version,
        targetSessionID: CHILD,
      })
      const receipt = await toolWatch(
        host,
        {
          operation: "receipt",
          taskID: parsed.watch?.taskID,
          attemptID: parsed.watch?.attemptID,
          correlation: parsed.watch?.correlation,
        },
        CHILD,
      )
      expect(watchDetails(receipt)).toMatchObject({ ok: true, continuePermit: false, seen: true })
      expect(String(watchDetails(receipt).refusalReason)).toContain("delegation-")
      expect(host.generations).toEqual([])
      expect(host.interrupts).toEqual([])
    } finally {
      await unload()
    }
  })

  test("a non-self enroll uses the reserved delegate fields", async () => {
    const { host, rpc, unload } = await loaded()
    try {
      const parent = await enrollParent(host)
      await grantAndDelegate(host, rpc, parent.taskID, parent.version)
      // A second target is not granted; the public non-self path must go
      // through the same delegation refusal, not the old unsupported text.
      const other = "ses_other"
      const result = await toolWatch(host, {
        operation: "enroll",
        taskID: parent.taskID,
        targetSessionID: other,
        requestId: "other-1",
        goal: "Other child",
        mode: "alert",
        expectedVersion: parent.version,
      })
      expect(watchDetails(result)).toMatchObject({ ok: false })
      expect((watchDetails(result).failure as Record<string, unknown>)["code"]).not.toBe("E_WATCH_INVALID")
      expect(host.prompts).toEqual([])
    } finally {
      await unload()
    }
  })
})
