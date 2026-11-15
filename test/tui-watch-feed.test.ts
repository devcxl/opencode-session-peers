/**
 * The watch feed's liveness: one snapshot, events on top, and a refresh floor
 * under both. A control answer is applied at once and must not be replaced by
 * a read that was already in flight when it arrived.
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import type { WatchReadRequest, WatchSource } from "../src/host/tui.ts"
import { createWatchFeed } from "../src/tui/watch-feed.ts"

const SELF = "ses_self0000"

function capability(): WatchPayload["capability"] {
  return {
    mode: "alert",
    monitoring: "observer-alerts",
    automaticDetection: "partial",
    automaticDetectionReason:
      "Observes local execution lifecycle, target activity and same-location waits.",
    correction: "unavailable",
    correctionReason: "Finite correction is not implemented in this build.",
    delegation: "unavailable",
    delegationReason: "Child-task delegation is not open in this build.",
    transfer: "unavailable",
    transferReason: "Watch ownership transfer is not implemented in this build.",
    recovery: "unavailable",
    recoveryReason: "Resume and recovery confirmation are not implemented in this build.",
    safetyPause: "unavailable",
    safetyPauseReason:
      "Watch safety pause is not implemented in this build; only a manual pause can occur.",
  }
}

function control(enabled = true, reason: string | null = null) {
  return { enabled, reason }
}

function controls(): WatchPayload["controls"] {
  return {
    pause: control(),
    end: control(),
    acknowledge: control(),
    resume: control(false, "Resume is not implemented in this build."),
    correction: control(false, "Correction is not implemented in this build."),
    transfer: control(false, "Transfer is not implemented in this build."),
  }
}

function payload(watchState: "active" | "paused" | "ended" = "active"): WatchPayload {
  return {
    enabled: true,
    ledger: { available: true, reason: null },
    task: {
      taskID: "task_0001",
      initiatorSessionID: SELF,
      targetSessionID: SELF,
      goal: "finish the migration",
      mode: "alert",
      watchState,
      taskState: "in-progress",
      version: watchState === "active" ? 3 : 4,
      generation: 1,
      ownership: "this-instance",
      participation: "seen",
      attempts: { used: 0, limit: 3 },
      pause: watchState === "paused" ? { kind: "manual", reason: "paused by the user" } : null,
      lastReport: null,
      createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
      updatedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
      completedAt: null,
      endedAt: null,
    },
    capability: capability(),
    controls: controls(),
    observation: {
      state: "active",
      reason: null,
      observedAt: Date.UTC(2026, 10, 16, 4, 34, 0),
      baselineAt: Date.UTC(2026, 10, 16, 4, 30, 0),
      idleSince: null,
      trusted: true,
      waits: [],
      waitsPartial: false,
      waitsTruncated: false,
      effective: { idleMs: 120_000, runningSilentMs: 600_000, waitOverdueMs: 1_800_000 },
    },
    activity: {
      lastAt: Date.UTC(2026, 10, 16, 4, 32, 0),
      kind: "text",
      judgement: "not-judged",
    },
    alerts: {
      items: [],
      unread: 0,
      total: 0,
      active: 0,
      truncated: false,
      available: true,
      reason: null,
    },
    failure: null,
  }
}

function source(
  read: (request: WatchReadRequest) => Promise<unknown> = () => Promise.resolve(payload()),
): WatchSource & {
  readonly requests: () => readonly WatchReadRequest[]
  readonly subscribed: () => boolean
  announce(): void
} {
  const requests: WatchReadRequest[] = []
  let listener: (() => void) | undefined
  return {
    read: (request) => {
      requests.push(request)
      return read(request)
    },
    call: () => Promise.resolve({}),
    onChange: (on) => {
      listener = on
      return () => {
        listener = undefined
      }
    },
    requests: () => requests,
    subscribed: () => listener !== undefined,
    announce: () => listener?.(),
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function payloadOf(feed: ReturnType<typeof createWatchFeed>): WatchPayload {
  const current = feed.state()
  if (current.kind !== "payload") throw new Error(`expected a payload state, got ${current.kind}`)
  return current.payload
}

describe("the watch refresh floor", () => {
  test("reads on open, on an event, and under the events until it closes", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 10 })
    expect(src.subscribed()).toBe(true)

    feed.open(SELF)
    await tick(0)
    expect(src.requests()).toEqual([{ sessionID: SELF }])

    src.announce()
    await tick(0)
    expect(src.requests()).toHaveLength(2)

    await tick(35)
    const whileOpen = src.requests().length
    expect(whileOpen).toBeGreaterThan(2)

    feed.close()
    // The subscription stays live so a reopen can still hear events, but a
    // closed panel must not read them.
    expect(src.subscribed()).toBe(true)
    await tick(20)
    const afterClose = src.requests().length
    src.announce()
    await tick(0)
    expect(src.requests().length).toBe(afterClose)

    feed.dispose()
    await tick(20)
    const afterDispose = src.requests().length
    src.announce()
    await tick(0)
    expect(src.requests().length).toBe(afterDispose)
    expect(src.subscribed()).toBe(false)
  })
})

describe("a control answer", () => {
  test("is visible at once and an older read cannot overwrite it", async () => {
    const first = deferred<unknown>()
    const src = source(() => first.promise)
    const feed = createWatchFeed(src, { refreshMs: 60_000 })

    feed.open(SELF)
    await tick(0)
    expect(feed.state().kind).toBe("loading")

    feed.apply(payload("paused"))
    expect(payloadOf(feed).task?.watchState).toBe("paused")

    // The read that started before the control answers late with active.
    first.resolve(payload("active"))
    await tick(0)
    expect(payloadOf(feed).task?.watchState).toBe("paused")
    feed.dispose()
  })

  test("a refresh after a control reads the committed state without doubling a same-epoch read", async () => {
    const first = deferred<unknown>()
    let calls = 0
    const src = source(() => {
      calls += 1
      return calls === 1 ? first.promise : Promise.resolve(payload("paused"))
    })
    const feed = createWatchFeed(src, { refreshMs: 60_000 })

    feed.open(SELF)
    await tick(0)
    feed.apply(payload("paused"))
    feed.refresh()
    await tick(0)
    // The control invalidated the old read, so the refresh may start at once;
    // the old answer is still ineligible.
    expect(src.requests()).toHaveLength(2)

    first.resolve(payload("active"))
    await tick(0)
    expect(src.requests()).toHaveLength(2)
    expect(payloadOf(feed).task?.watchState).toBe("paused")
    feed.dispose()
  })

  test("closing during a read ignores its late answer and reads nothing new", async () => {
    const first = deferred<unknown>()
    const src = source(() => first.promise)
    const feed = createWatchFeed(src, { refreshMs: 60_000 })

    feed.open(SELF)
    await tick(0)
    expect(feed.state().kind).toBe("loading")

    feed.close()
    src.announce()
    await tick(0)
    expect(src.requests()).toHaveLength(1)

    first.resolve(payload("active"))
    await tick(0)
    expect(feed.state()).toEqual({ kind: "loading" })
    expect(src.requests()).toHaveLength(1)
    feed.dispose()
  })

  test("a closed panel ignores a control answer and a direct refresh", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 60_000 })
    feed.open(SELF)
    await tick(0)
    const before = payloadOf(feed)

    feed.close()
    feed.apply(payload("paused"))
    feed.refresh()
    await tick(0)
    expect(src.requests()).toHaveLength(1)
    expect(payloadOf(feed)).toBe(before)
    feed.dispose()
  })

  test("reopening takes a fresh snapshot and a late answer from the old open cannot replace it", async () => {
    const first = deferred<unknown>()
    const src = source((request) =>
      request.sessionID === "ses_old" ? first.promise : Promise.resolve(payload("paused")),
    )
    const feed = createWatchFeed(src, { refreshMs: 60_000 })

    feed.open("ses_old")
    await tick(0)
    feed.close()
    feed.open("ses_new")
    await tick(0)
    expect(src.requests()).toEqual([{ sessionID: "ses_old" }, { sessionID: "ses_new" }])
    expect(payloadOf(feed).task?.watchState).toBe("paused")

    first.resolve(payload("active"))
    await tick(0)
    expect(payloadOf(feed).task?.watchState).toBe("paused")
    expect(src.requests()).toHaveLength(2)
    feed.dispose()
  })

  test("dispose makes open, apply and refresh no-ops and never restarts the floor", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 10 })
    feed.open(SELF)
    await tick(0)
    const before = payloadOf(feed)
    feed.dispose()
    expect(src.subscribed()).toBe(false)

    feed.open("ses_new")
    feed.apply(payload("paused"))
    feed.refresh()
    await tick(35)
    expect(src.requests()).toHaveLength(1)
    expect(payloadOf(feed)).toBe(before)
  })
})

describe("claims the feed will not make", () => {
  test("an unreadable answer is its own state", async () => {
    const feed = createWatchFeed(source(() => Promise.resolve({})), { refreshMs: 60_000 })
    feed.open(SELF)
    await tick(0)
    expect(feed.state()).toEqual({ kind: "unreadable" })
    feed.dispose()
  })

  test("a rejected read says why", async () => {
    const feed = createWatchFeed(
      source(() => Promise.reject({ message: "RPC is unavailable: session-peers.v1" })),
      { refreshMs: 60_000 },
    )
    feed.open(SELF)
    await tick(0)
    expect(feed.state()).toEqual({
      kind: "failed",
      reason: "RPC is unavailable: session-peers.v1",
    })
    feed.dispose()
  })

  test("a read already in flight when disposed changes nothing", async () => {
    const first = deferred<unknown>()
    const feed = createWatchFeed(source(() => first.promise), { refreshMs: 60_000 })
    feed.open(SELF)
    await tick(0)
    feed.dispose()
    first.resolve(payload())
    await tick(0)
    expect(feed.state()).toEqual({ kind: "loading" })
  })
})

describe("the snapshot callback", () => {
  test("marks the opening snapshot initial, then reports changes as non-initial", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 60_000 })
    const seen: boolean[] = []
    feed.onSnapshot((_payload, initial) => seen.push(initial))

    feed.open(SELF)
    await tick(0)
    expect(seen).toEqual([true])

    src.announce()
    await tick(0)
    expect(seen).toEqual([true, false])

    feed.close()
    src.announce()
    await tick(0)
    expect(seen).toEqual([true, false])

    feed.open(SELF)
    await tick(0)
    expect(seen).toEqual([true, false, true])
    feed.dispose()
  })

  test("a committed control answer is a non-initial snapshot", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 60_000 })
    const seen: boolean[] = []
    feed.onSnapshot((_payload, initial) => seen.push(initial))
    feed.open(SELF)
    await tick(0)

    feed.apply(payload("paused"))
    expect(seen).toEqual([true, false])
    feed.dispose()
  })

  test("dispose stops the callback and removes it", async () => {
    const src = source()
    const feed = createWatchFeed(src, { refreshMs: 60_000 })
    let calls = 0
    feed.onSnapshot(() => {
      calls += 1
    })
    feed.open(SELF)
    await tick(0)
    expect(calls).toBe(1)
    feed.dispose()
    feed.open(SELF)
    src.announce()
    await tick(0)
    expect(calls).toBe(1)
  })
})
