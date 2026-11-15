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
    monitoring: "participant-reports-only",
    automaticDetection: "unavailable",
    correction: "unavailable",
    correctionReason: "Finite correction is not implemented in this build.",
    delegation: "unavailable",
    transfer: "unavailable",
    recovery: "unavailable",
  }
}

function control(enabled = true, reason: string | null = null) {
  return { enabled, reason }
}

function controls(): WatchPayload["controls"] {
  return {
    pause: control(),
    end: control(),
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
      lastReport: null,
      createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
      updatedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
      completedAt: null,
      endedAt: null,
    },
    capability: capability(),
    controls: controls(),
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
    await tick(20)
    const afterClose = src.requests().length
    src.announce()
    await tick(0)
    expect(src.requests().length).toBe(afterClose + 1)

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

  test("a refresh asked for during that read happens after it settles", async () => {
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
    // The first read is still in flight; refresh waits rather than stacking.
    expect(src.requests()).toHaveLength(1)

    first.resolve(payload("active"))
    await tick(0)
    expect(src.requests()).toHaveLength(2)
    expect(payloadOf(feed).task?.watchState).toBe("paused")
    feed.dispose()
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
