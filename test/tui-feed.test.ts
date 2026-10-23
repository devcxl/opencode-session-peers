/**
 * The feed's liveness: a snapshot, events on top, and a refresh floor under
 * both — the floor is the feed's own mechanism (`src/tui/feed.ts`), so it is
 * asserted here rather than through the dialog.
 */

import { describe, expect, test } from "bun:test"

import type { RosterSource } from "../src/host/tui.ts"
import { createRosterFeed } from "../src/tui/feed.ts"

function source(): RosterSource & { readonly reads: () => number; announce(): void } {
  let reads = 0
  let listener: (() => void) | undefined
  return {
    read: () => {
      reads += 1
      return Promise.resolve({})
    },
    onChange: (on) => {
      listener = on
      return () => {
        listener = undefined
      }
    },
    reads: () => reads,
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
