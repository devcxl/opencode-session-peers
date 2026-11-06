/**
 * The feed's liveness: a snapshot, events on top, and a refresh floor under
 * both — the floor is the feed's own mechanism (`src/tui/feed.ts`), so it is
 * asserted here rather than through the dialog.
 */

import { describe, expect, test } from "bun:test"

import type { RosterRequest, RosterSource } from "../src/host/tui.ts"
import { createRosterFeed } from "../src/tui/feed.ts"

function source(): RosterSource & {
  readonly reads: () => number
  readonly requests: () => readonly RosterRequest[]
  announce(): void
} {
  let reads = 0
  const requests: RosterRequest[] = []
  let listener: (() => void) | undefined
  return {
    read: (request) => {
      reads += 1
      requests.push(request)
      return Promise.resolve({})
    },
    onChange: (on) => {
      listener = on
      return () => {
        listener = undefined
      }
    },
    reads: () => reads,
    requests: () => requests,
    announce: () => listener?.(),
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("the refresh floor", () => {
  test("ticks under the events while the feed is open, and stops when it closes", async () => {
    const src = source()
    const feed = createRosterFeed(src, { refreshMs: 10 })

    feed.open()
    await tick(45)
    const whileOpen = src.reads()
    // One read on open, then the floor: several more within the window.
    expect(whileOpen).toBeGreaterThan(1)

    feed.close()
    await tick(20)
    // Still subscribed — an event is read at once — but the floor is off.
    const afterClose = src.reads()
    src.announce()
    expect(src.reads()).toBe(afterClose + 1)

    feed.dispose()
    await tick(20)
    const afterDispose = src.reads()
    src.announce()
    expect(src.reads()).toBe(afterDispose)
    expect(src.reads()).toBeLessThan(whileOpen + 20)
  })

  test("opening twice does not stack a second floor", async () => {
    const src = source()
    const feed = createRosterFeed(src, { refreshMs: 10 })
    feed.open()
    feed.open()
    await tick(45)
    // Two floors would double the cadence; one floor stays near 1 per 10ms.
    expect(src.reads()).toBeLessThan(8)
    feed.dispose()
  })
})

describe("the scope the feed reads", () => {
  test("reads the session's own scope first, and a preview only until it is dropped", async () => {
    const src = source()
    const feed = createRosterFeed(src, { refreshMs: 60_000 })

    feed.open("ses_self")
    await tick(0)
    expect(src.requests()).toEqual([{ sessionID: "ses_self" }])

    feed.showScope("default")
    await tick(0)
    expect(src.requests()[1]).toEqual({ sessionID: "ses_self", scope: "default" })

    feed.showScope(undefined)
    await tick(0)
    expect(src.requests()[2]).toEqual({ sessionID: "ses_self" })

    // Reopening starts at the session's own scope again, not at the preview.
    feed.showScope("default")
    await tick(0)
    feed.open("ses_self")
    await tick(0)
    expect(src.requests().at(-1)).toEqual({ sessionID: "ses_self" })

    feed.dispose()
  })
})
