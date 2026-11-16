/**
 * The delegated executor seam: fresh authority before reserve and again before
 * claim, with the real ledger and the application's own authority.
 *
 * These are controlled-fact tests; the production runtime tuple is not
 * modified. They prove a revoke during an async authority lookup cannot let a
 * stale observation or a reserved attempt reach the queue.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { WatchObservationView } from "../src/domain/watch.ts"
import type { SessionLookup, SessionRecord } from "../src/host/session.ts"
import { openWatchLedger, type WatchLedger } from "../src/watch/ledger.ts"
import { createDelegationAuthority, type ScopeFact } from "../src/watch/delegation-authority.ts"
import { createWatchApplication, type WatchApplication } from "../src/watch/service.ts"
import { createCorrectionExecutor } from "../src/watch/executor.ts"
import { correctionGateWithVerifiedTuples } from "../src/watch/correction.ts"
import type { CorrectionDeliveryRequest } from "../src/watch/executor.ts"

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
const describeExecutor = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DIRECTORY = "/tmp/opencode/delegation-executor"
const SCOPE = "project-a"
const OWNER = "act-parent"

interface Harness {
  readonly app: WatchApplication
  readonly ledger: WatchLedger
  readonly sessions: Map<string, SessionRecord>
  readonly scopes: Map<string, ScopeFact | null>
  readonly clock: { value: number }
  readonly close: () => void
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-delegation-executor-"))
  scratch.push(directory)
  const path = join(directory, "watch-ledger.sqlite3")
  const clock = { value: 1_000 }
  const opened = openWatchLedger({ path, busyTimeoutMs: 2_000, openAttempts: 20, now: () => clock.value })
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.detail}`)
  const ledger = opened.ledger
  const sessions = new Map<string, SessionRecord>([
    [PARENT, { id: PARENT, directory: DIRECTORY, projectID: "proj" }],
    [CHILD, { id: CHILD, parentID: PARENT, directory: DIRECTORY, projectID: "proj" }],
  ])
  const scopes = new Map<string, ScopeFact | null>([
    [PARENT, { scope: SCOPE, source: "recorded" }],
    [CHILD, { scope: SCOPE, source: "recorded" }],
  ])
  const lookup: SessionLookup = {
    async get(sessionID) {
      const session = sessions.get(sessionID)
      if (session === undefined) throw new Error("Session.NotFoundError")
      return session
    },
    async prompt() {
      throw new Error("the watch application must not prompt")
    },
    async toolCalls() {
      throw new Error("the watch application must not read a transcript")
    },
  }
  const app = createWatchApplication({
    ledgerPath: path,
    activationID: OWNER,
    runtime: { appName: "opencode", appVersion: "2.3.0", platform: "linux", arch: "x64" },
    now: () => clock.value,
    delegation: createDelegationAuthority({
      ledger,
      sessions: lookup,
      scopeOf: async (sessionID) => scopes.get(sessionID) ?? null,
      activationID: OWNER,
      closing: () => false,
      now: () => clock.value,
    }),
  })
  return {
    app,
    ledger,
    sessions,
    scopes,
    clock,
    close() {
      app.dispose()
      ledger.close()
    },
  }
}

async function seed(h: Harness): Promise<{ parentTaskID: string; childTaskID: string }> {
  const parent = h.app.enroll({
    callerSessionID: PARENT,
    requestID: "executor-parent",
    goal: "Ship the parent",
  })
  if (!parent.ok || parent.task === null) throw new Error("parent enroll failed")
  const prepared = await h.app.prepareDelegationGrant({
    callerSessionID: PARENT,
    parentTaskID: parent.task.taskID,
    expectedVersion: parent.task.version,
    targetSessionID: CHILD,
    mode: "limited-correction",
    deployment: "single-host-same-location",
  })
  if (!prepared.ok || prepared.challenge === null) throw new Error("prepare failed")
  const confirmed = await h.app.confirmDelegationGrant({
    callerSessionID: PARENT,
    parentTaskID: parent.task.taskID,
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
  if (!confirmed.ok) throw new Error("confirm failed")
  const child = await h.app.delegate({
    callerSessionID: PARENT,
    parentTaskID: parent.task.taskID,
    targetSessionID: CHILD,
    requestID: "executor-child",
    goal: "Deliver the child work",
    mode: "limited-correction",
    expectedVersion: parent.task.version,
  })
  if (!child.ok || child.task === null) throw new Error("delegate failed")
  const began = h.app.report({
    callerSessionID: CHILD,
    taskID: child.task.taskID,
    expectedVersion: child.task.version,
    reportID: "executor-begin",
    kind: "begin",
    evidence: {},
  })
  if (!began.ok) throw new Error("begin failed")
  return { parentTaskID: parent.task.taskID, childTaskID: child.task.taskID }
}

function observation(at = 2_000): WatchObservationView {
  return {
    state: "idle-candidate",
    reason: null,
    observedAt: at,
    baselineAt: 1_000,
    idleSince: 1_000,
    trusted: true,
    waits: [],
    waitsPartial: false,
    waitsTruncated: false,
    effective: { idleMs: 1_000, runningSilentMs: 5_000, waitOverdueMs: 60_000 },
  }
}

const runtime = {
  appVersion: "2.3.0",
  platform: "linux",
  arch: "x64",
  sqliteVersion: "3.53.4",
  journalMode: "wal",
  synchronous: 2,
  busyTimeoutMs: 500,
  filesystem: "tmpfs",
} as const

function executor(
  h: Harness,
  sent: CorrectionDeliveryRequest[],
  check: (taskID: string) => Promise<{ required: boolean; allowed: boolean }>,
  delivery: "accepted" | "unknown" = "accepted",
) {
  const authority = h.app.correctionAuthority()
  if (authority === undefined) throw new Error("no correction authority")
  return createCorrectionExecutor({
    authority,
    observationFor: () => observation(h.clock.value),
    refreshObservation: async () => observation(h.clock.value),
    sameLocation: async () => true,
    runtime: () => runtime,
    gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
    delivery: {
      async send(request) {
        sent.push(request)
        return delivery === "accepted"
          ? { kind: "accepted" as const, admissionID: "delegation-admission" }
          : { kind: "unknown" as const, reason: "ambiguous queue" }
      },
    },
    activationID: OWNER,
    now: () => h.clock.value,
    checkDelegatedAuthority: check,
    warn: () => {},
  })
}

describeExecutor("delegated executor guard", () => {
  test("a source revoke during the pre-reserve authority await sends nothing", async () => {
    const h = harness()
    try {
      const { parentTaskID, childTaskID } = await seed(h)
      const sent: CorrectionDeliveryRequest[] = []
      let calls = 0
      const run = executor(h, sent, async (taskID) => {
        calls += 1
        if (calls === 1) {
          await h.app.revokeDelegationGrant({
            callerSessionID: PARENT,
            parentTaskID,
            targetSessionID: CHILD,
            expectedVersion: 1,
          })
        }
        return h.app.checkDelegatedAuthority(taskID)
      })
      run.kick(childTaskID)
      await run.settle()
      expect(sent).toHaveLength(0)
      const correction = h.ledger.correction(childTaskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts).toHaveLength(0)
      await run.close()
    } finally {
      h.close()
    }
  })

  test("a child scope change during the authority await sends nothing", async () => {
    const h = harness()
    try {
      const { childTaskID } = await seed(h)
      const sent: CorrectionDeliveryRequest[] = []
      let calls = 0
      const run = executor(h, sent, async (taskID) => {
        calls += 1
        if (calls === 1) h.scopes.set(CHILD, { scope: "project-b", source: "recorded" })
        return h.app.checkDelegatedAuthority(taskID)
      })
      run.kick(childTaskID)
      await run.settle()
      expect(sent).toHaveLength(0)
      const correction = h.ledger.correction(childTaskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts).toHaveLength(0)
      await run.close()
    } finally {
      h.close()
    }
  })

  test("a source revoke after reserve aborts before claim and sends nothing", async () => {
    const h = harness()
    try {
      const { parentTaskID, childTaskID } = await seed(h)
      const sent: CorrectionDeliveryRequest[] = []
      let calls = 0
      const run = executor(h, sent, async (taskID) => {
        calls += 1
        if (calls === 2) {
          await h.app.revokeDelegationGrant({
            callerSessionID: PARENT,
            parentTaskID,
            targetSessionID: CHILD,
            expectedVersion: 1,
          })
        }
        return h.app.checkDelegatedAuthority(taskID)
      })
      run.kick(childTaskID)
      await run.settle()
      expect(sent).toHaveLength(0)
      const correction = h.ledger.correction(childTaskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts).toHaveLength(1)
      expect(correction.value.attempts[0]).toMatchObject({ phase: "aborted" })
      await run.close()
    } finally {
      h.close()
    }
  })

  test("an unknown delivery is retained and never replayed, even after revoke", async () => {
    const h = harness()
    try {
      const { parentTaskID, childTaskID } = await seed(h)
      const sent: CorrectionDeliveryRequest[] = []
      const run = executor(h, sent, async (taskID) => h.app.checkDelegatedAuthority(taskID), "unknown")
      run.kick(childTaskID)
      await run.settle()
      expect(sent).toHaveLength(1)
      let correction = h.ledger.correction(childTaskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts[0]).toMatchObject({ phase: "unknown" })

      await h.app.revokeDelegationGrant({
        callerSessionID: PARENT,
        parentTaskID,
        targetSessionID: CHILD,
        expectedVersion: 1,
      })
      run.kick(childTaskID)
      await run.settle()
      expect(sent).toHaveLength(1)
      correction = h.ledger.correction(childTaskID)
      expect(correction.ok).toBe(true)
      if (!correction.ok) return
      expect(correction.value.attempts).toHaveLength(1)
      expect(correction.value.attempts[0]).toMatchObject({ phase: "unknown" })
      await run.close()
    } finally {
      h.close()
    }
  })
})
