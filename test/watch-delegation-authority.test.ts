/**
 * Fresh delegated-authority checks against a real ledger and a fake host.
 *
 * The important cases are the ones with no panel read in between: a revoke, a
 * parent pause, a scope change or a disappearing host parent must stop the
 * authority check on its own. The check returns facts, not a model-supplied
 * boolean, and a different database version is irrelevant here.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionLookup, SessionRecord } from "../src/host/session.ts"
import { openWatchLedger, type WatchLedger } from "../src/watch/ledger.ts"
import {
  createDelegationAuthority,
  createScopeFactReader,
  type ScopeFact,
} from "../src/watch/delegation-authority.ts"
import type { WatchTaskRecord } from "../src/domain/watch.ts"
import { fakePluginStorage, fakeStorage } from "./fake-storage.ts"

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
const describeAuthority = safeRuntime ? describe : describe.skip

const scratch: string[] = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PARENT = "ses_parent"
const CHILD = "ses_child"
const DIRECTORY = "/tmp/opencode/delegation-authority"
const SCOPE = "project-a"
const OWNER = "act-parent"

function open(clock: { value: number }): WatchLedger {
  const directory = mkdtempSync(join(tmpdir(), "session-peers-delegation-authority-"))
  scratch.push(directory)
  const opened = openWatchLedger({
    path: join(directory, "watch-ledger.sqlite3"),
    busyTimeoutMs: 2_000,
    openAttempts: 20,
    now: () => clock.value,
  })
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.detail}`)
  return opened.ledger
}

function seed(ledger: WatchLedger, clock: { value: number }): { parent: WatchTaskRecord; child: WatchTaskRecord } {
  const parentEnrolled = ledger.enroll({
    requestId: "authority-parent",
    initiatorSessionId: PARENT,
    targetSessionId: PARENT,
    goal: "Ship the parent task",
    mode: "alert",
    ownerActivation: OWNER,
  })
  if (!parentEnrolled.ok) throw new Error(parentEnrolled.code)
  const parent = parentEnrolled.value.task
  const prepared = ledger.prepareDelegationGrant({
    taskId: parent.taskID,
    callerSessionId: PARENT,
    ownerActivation: OWNER,
    expectedVersion: parent.version,
    targetSessionId: CHILD,
    mode: "limited-correction",
    scopeDirectory: DIRECTORY,
    scopePeerScope: SCOPE,
    deployment: "single-host-same-location",
    at: clock.value,
  })
  if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.detail}`)
  const confirmed = ledger.confirmDelegationGrant({
    challenge: prepared.value.challenge,
    taskId: parent.taskID,
    callerSessionId: PARENT,
    ownerActivation: OWNER,
    expectedVersion: prepared.value.expectedVersion,
    generation: prepared.value.generation,
    targetSessionId: CHILD,
    mode: prepared.value.mode,
    scopeDirectory: prepared.value.scopeDirectory,
    scopePeerScope: prepared.value.scopePeerScope,
    termsDigest: prepared.value.termsDigest,
    deployment: "single-host-same-location",
    at: clock.value + 1,
  })
  if (!confirmed.ok) throw new Error(`${confirmed.code}: ${confirmed.detail}`)
  const child = ledger.delegatedEnroll({
    requestId: "authority-child",
    initiatorSessionId: PARENT,
    targetSessionId: CHILD,
    parentTaskId: parent.taskID,
    goal: "Deliver the child work",
    mode: "limited-correction",
    ownerActivation: OWNER,
    expectedVersion: parent.version,
    grantId: confirmed.value.grant.grantID,
    grantVersion: confirmed.value.grant.version,
    verifiedParentId: PARENT,
    verifiedDirectory: DIRECTORY,
    verifiedScope: SCOPE,
    verifiedScopeSource: "recorded",
  })
  if (!child.ok) throw new Error(`${child.code}: ${child.detail}`)
  return { parent, child: child.value.task }
}

interface HostState {
  readonly sessions: Map<string, SessionRecord>
  readonly scopes: Map<string, ScopeFact | null>
}

function hostState(): HostState {
  return {
    sessions: new Map([
      [PARENT, { id: PARENT, directory: DIRECTORY, projectID: "proj" }],
      [CHILD, { id: CHILD, parentID: PARENT, directory: DIRECTORY, projectID: "proj" }],
    ]),
    scopes: new Map([
      [PARENT, { scope: SCOPE, source: "recorded" }],
      [CHILD, { scope: SCOPE, source: "recorded" }],
    ]),
  }
}

function lookup(state: HostState): SessionLookup {
  return {
    async get(sessionID) {
      const session = state.sessions.get(sessionID)
      if (session === undefined) throw new Error("Session.NotFoundError")
      return session
    },
    async prompt() {
      throw new Error("the authority check must not prompt")
    },
    async toolCalls() {
      throw new Error("the authority check must not read a transcript")
    },
  }
}

function scopeReader(state: HostState) {
  return async (sessionID: string): Promise<ScopeFact | null> => state.scopes.get(sessionID) ?? null
}

describeAuthority("delegated authority", () => {
  test("a self-enrolled task requires no delegation check", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const parent = ledger.enroll({
        requestId: "self",
        initiatorSessionId: PARENT,
        targetSessionId: PARENT,
        goal: "Self task",
        mode: "alert",
        ownerActivation: OWNER,
      })
      if (!parent.ok) throw new Error(parent.code)
      const state = hostState()
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const checked = await authority.check(parent.value.task.taskID)
      expect(checked).toMatchObject({ required: false, allowed: true, stopReason: null })
    } finally {
      ledger.close()
    }
  })

  test("fresh host facts allow a direct, same-location, same-scope child", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { child } = seed(ledger, clock)
      const state = hostState()
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const checked = await authority.check(child.taskID)
      expect(checked).toMatchObject({
        required: true,
        allowed: true,
        stopReason: null,
        targetSessionID: CHILD,
      })
      expect(checked.grantID).toBeDefined()
      expect(checked.scopeSource).toBe("recorded")
    } finally {
      ledger.close()
    }
  })

  test("a revoke with no panel read stops the next check", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { parent, child } = seed(ledger, clock)
      const state = hostState()
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const revoked = ledger.revokeDelegationGrant({
        parentTaskId: parent.taskID,
        targetSessionId: CHILD,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        at: clock.value + 10,
      })
      expect(revoked.ok).toBe(true)
      const checked = await authority.check(child.taskID)
      expect(checked.allowed).toBe(false)
      expect(checked.stopReason).toBe("grant-revoked")
    } finally {
      ledger.close()
    }
  })

  test("a parent pause with no panel read stops the next check", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { parent, child } = seed(ledger, clock)
      const state = hostState()
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const paused = ledger.control({
        taskId: parent.taskID,
        callerSessionId: PARENT,
        expectedVersion: parent.version,
        operation: "pause",
      })
      expect(paused.ok).toBe(true)
      const checked = await authority.check(child.taskID)
      expect(checked.allowed).toBe(false)
      expect(checked.stopReason).toBe("parent-task-inactive")
    } finally {
      ledger.close()
    }
  })

  test("a changed scope or parentID stops the check", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { child } = seed(ledger, clock)
      const state = hostState()
      state.scopes.set(CHILD, { scope: "project-b", source: "recorded" })
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const checked = await authority.check(child.taskID)
      expect(checked.allowed).toBe(false)
      expect(checked.stopReason).toBe("scope-mismatch")

      state.scopes.set(CHILD, { scope: SCOPE, source: "recorded" })
      const childSession = state.sessions.get(CHILD)
      if (childSession !== undefined) state.sessions.set(CHILD, { ...childSession, parentID: "ses_other" })
      const wrongParent = await authority.check(child.taskID)
      expect(wrongParent.allowed).toBe(false)
      expect(wrongParent.stopReason).toBe("parent-not-direct")
    } finally {
      ledger.close()
    }
  })

  test("a disappearing child session or an unknown scope is refused", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { child } = seed(ledger, clock)
      const state = hostState()
      state.sessions.delete(CHILD)
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: scopeReader(state),
        activationID: OWNER,
        closing: () => false,
      })
      const missing = await authority.check(child.taskID)
      expect(missing.allowed).toBe(false)
      expect(missing.stopReason).toBe("child-unknown")

      state.sessions.set(CHILD, { id: CHILD, parentID: PARENT, directory: DIRECTORY, projectID: "proj" })
      state.scopes.set(CHILD, null)
      const unknownScope = await authority.check(child.taskID)
      expect(unknownScope.allowed).toBe(false)
      expect(unknownScope.stopReason).toBe("scope-mismatch")
    } finally {
      ledger.close()
    }
  })

  test("the configured scope is used only for a session this instance serves", async () => {
    const storage = fakeStorage()
    const state = hostState()
    state.scopes.clear()
    const sessions = lookup(state)
    const reader = createScopeFactReader({
      configScope: SCOPE,
      directory: DIRECTORY,
      sessions,
      peers: fakePluginStorage(storage).peers,
    })
    const sameLocation = await reader(PARENT)
    expect(sameLocation).toEqual({ scope: SCOPE, source: "configured" })

    state.sessions.set(PARENT, { id: PARENT, directory: "/tmp/opencode/other", projectID: "proj" })
    const elsewhere = await reader(PARENT)
    expect(elsewhere).toBeNull()
  })

  test("a revoke during the host reads is not overwritten by the older snapshot", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { parent, child } = seed(ledger, clock)
      const state = hostState()
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: async (sessionID) => {
          if (sessionID === CHILD) await gate
          return state.scopes.get(sessionID) ?? null
        },
        activationID: OWNER,
        closing: () => false,
      })
      const pending = authority.check(child.taskID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const revoked = ledger.revokeDelegationGrant({
        parentTaskId: parent.taskID,
        targetSessionId: CHILD,
        callerSessionId: PARENT,
        ownerActivation: OWNER,
        expectedVersion: parent.version,
        at: clock.value + 10,
      })
      expect(revoked.ok).toBe(true)
      release?.()
      const checked = await pending
      expect(checked.allowed).toBe(false)
      expect(checked.stopReason).toBe("grant-stale")
    } finally {
      ledger.close()
    }
  })

  test("closing during the host reads refuses instead of returning the old answer", async () => {
    const clock = { value: 1_000 }
    const ledger = open(clock)
    try {
      const { child } = seed(ledger, clock)
      const state = hostState()
      let closing = false
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const authority = createDelegationAuthority({
        ledger,
        sessions: lookup(state),
        scopeOf: async (sessionID) => {
          if (sessionID === CHILD) await gate
          return state.scopes.get(sessionID) ?? null
        },
        activationID: OWNER,
        closing: () => closing,
      })
      const pending = authority.check(child.taskID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      closing = true
      release?.()
      const checked = await pending
      expect(checked.allowed).toBe(false)
      expect(checked.stopReason).toBe("closing")
    } finally {
      ledger.close()
    }
  })
})
