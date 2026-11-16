/**
 * The full observer + executor path with the real SQLite ledger and the same
 * fresh-sampling implementation production uses. The gate is the only test
 * seam: the static tuple is supplied here instead of the verified production
 * whitelist. The observer, ledger, executor, clock and events are real.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { createHost } from "../src/host/index.ts"
import { createWatchApplication } from "../src/watch/service.ts"
import { createWatchObserver } from "../src/watch/observe.ts"
import { createCorrectionExecutor, type CorrectionDeliveryRequest, type CorrectionExecutor } from "../src/watch/executor.ts"
import { correctionGateWithVerifiedTuples } from "../src/watch/correction.ts"
import { sessionAtLocation } from "../src/watch/access.ts"
import { CALLER_SESSION_ID, fakeHost, type FakeHost } from "./fake-host.ts"
import type { WatchObserver } from "../src/watch/observe.ts"

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
const describeObserver = safeRuntime ? describe : describe.skip

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

function setup(
  host: FakeHost,
  state: string,
  onLocation?: (count: number) => Promise<void> | void,
): {
  readonly app: ReturnType<typeof createWatchApplication>
  readonly observer: WatchObserver
  readonly executor: CorrectionExecutor
  readonly sent: CorrectionDeliveryRequest[]
} {
  const sent: CorrectionDeliveryRequest[] = []
  let locationCalls = 0
  const ports = createHost(host.context)
  const location = ports.location.directory
  let observer: WatchObserver | undefined
  const app = createWatchApplication({
    ledgerPath: join(state, "watch-ledger.sqlite3"),
    activationID: "activation-a",
    runtime: { appName: "opencode", appVersion: "2.3.0", platform: "linux", arch: "x64" },
    now: () => ports.scheduler.now(),
    sessionAtLocation: (sessionID) => sessionAtLocation(ports.sessions, sessionID, location),
    observationFor: (taskID) => observer?.observationFor(taskID) ?? null,
  })
  const authority = app.correctionAuthority()
  if (authority === undefined) throw new Error(`no correction authority: ${app.status().reason ?? "unknown"}`)
  const executor = createCorrectionExecutor({
    authority,
    observationFor: (taskID) => observer?.observationFor(taskID) ?? null,
    refreshObservation: async (taskID) => (await observer?.refresh(taskID)) ?? null,
    markOwnReservation: (taskID, fromVersion, toVersion) =>
      observer?.markOwnReservation(taskID, fromVersion, toVersion),
    sameLocation: async (sessionID) => {
      locationCalls += 1
      await onLocation?.(locationCalls)
      return sessionAtLocation(ports.sessions, sessionID, location)
    },
    runtime: () => ({
      appVersion: "2.3.0",
      platform: "linux",
      arch: "x64",
      sqliteVersion: "3.53.4",
      journalMode: "wal",
      synchronous: 2,
      busyTimeoutMs: 500,
      filesystem: "tmpfs",
    }),
    gate: correctionGateWithVerifiedTuples(["2.3.0/linux/x64"]),
    delivery: {
      async send(request) {
        sent.push(request)
        return { kind: "accepted", admissionID: "observer-admission" }
      },
    },
    activationID: "activation-a",
    now: () => ports.scheduler.now(),
    warn: () => {},
  })
  observer = createWatchObserver({
    config: WATCH_OPTIONS,
    directory: location,
    sessions: ports.sessions,
    permissions: ports.permissions,
    events: ports.events,
    scheduler: ports.scheduler,
    store: app,
    asks: ports.storage.asks,
    replies: ports.storage.replies,
    onSample: (taskID) => executor.kick(taskID),
    warn: () => {},
  })
  observer.start()
  return { app, observer, executor, sent }
}

describeObserver("observer + executor candidate path", () => {
  test("the executor's own reserve does not reset the trusted idle baseline", async () => {
    const state = mkdtempSync(join(tmpdir(), "session-peers-observer-executor-"))
    scratch.push(state)
    const host = fakeHost()
    const { app, observer, executor, sent } = setup(host, state)
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.setIdle(CALLER_SESSION_ID, at)
      const enrolled = app.enroll({ callerSessionID: CALLER_SESSION_ID, requestID: "observer-enroll", goal: "observer path" })
      expect(enrolled.ok).toBe(true)
      if (!enrolled.ok) return
      if (enrolled.task === null) throw new Error("enroll returned no task")
      const taskID = enrolled.task.taskID
      const began = app.report({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: enrolled.task.version,
        reportID: "observer-begin",
        kind: "begin",
        evidence: {},
      })
      expect(began.ok).toBe(true)
      if (!began.ok) return
      if (began.task === null) throw new Error("begin returned no task")
      expect(app.show({ sessionID: CALLER_SESSION_ID }).task?.version).toBe(began.task.version)
      const prepared = app.prepareGrant({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: began.task.version,
        deployment: "single-host-same-location",
      })
      expect(prepared.ok).toBe(true)
      if (!prepared.ok || prepared.challenge === null) return
      const confirmed = app.confirmGrant({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: prepared.challenge.expectedVersion,
        generation: prepared.challenge.generation,
        termsDigest: prepared.challenge.termsDigest,
        challenge: prepared.challenge.challenge,
        deployment: "single-host-same-location",
      })
      expect(confirmed.ok).toBe(true)

      for (let tick = 0; tick < 6; tick += 1) {
        await host.advance(1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const final = app.show({ sessionID: CALLER_SESSION_ID })
      expect(sent).toHaveLength(1)
      expect(final.task?.correction.history.map((item) => item.phase)).toEqual(["accepted"])
    } finally {
      await executor.close()
      observer.dispose()
      app.dispose()
    }
  })

  test("an event during the final location lookup invalidates the stale observation", async () => {
    const state = mkdtempSync(join(tmpdir(), "session-peers-observer-final-"))
    scratch.push(state)
    const host = fakeHost()
    const { app, observer, executor, sent } = setup(host, state, async (count) => {
      if (count === 2) {
        host.emit("session.text.started", { sessionID: CALLER_SESSION_ID }, host.now())
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })
    try {
      const at = host.now()
      host.emit("session.created", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.started", { sessionID: CALLER_SESSION_ID }, at)
      host.emit("session.execution.succeeded", { sessionID: CALLER_SESSION_ID }, at)
      host.setBusy(CALLER_SESSION_ID, at)
      host.setIdle(CALLER_SESSION_ID, at)
      const enrolled = app.enroll({ callerSessionID: CALLER_SESSION_ID, requestID: "final-event", goal: "final event" })
      if (!enrolled.ok || enrolled.task === null) throw new Error("enroll failed")
      const taskID = enrolled.task.taskID
      const began = app.report({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: enrolled.task.version,
        reportID: "final-begin",
        kind: "begin",
        evidence: {},
      })
      if (!began.ok || began.task === null) throw new Error("begin failed")
      const prepared = app.prepareGrant({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: began.task.version,
        deployment: "single-host-same-location",
      })
      if (!prepared.ok || prepared.challenge === null) throw new Error("prepare failed")
      const confirmed = app.confirmGrant({
        callerSessionID: CALLER_SESSION_ID,
        taskID,
        expectedVersion: prepared.challenge.expectedVersion,
        generation: prepared.challenge.generation,
        termsDigest: prepared.challenge.termsDigest,
        challenge: prepared.challenge.challenge,
        deployment: "single-host-same-location",
      })
      expect(confirmed.ok).toBe(true)
      for (let tick = 0; tick < 6; tick += 1) {
        await host.advance(1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const final = app.show({ sessionID: CALLER_SESSION_ID })
      expect(sent).toHaveLength(0)
      expect(final.task?.correction.history.map((item) => item.phase)).toEqual(["aborted"])
    } finally {
      await executor.close()
      observer.dispose()
      app.dispose()
    }
  })
})
