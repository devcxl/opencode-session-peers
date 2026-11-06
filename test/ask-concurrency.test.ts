/** Document the non-atomic check/write window without claiming a cross-process lock. */
import { expect, test } from "bun:test"

import plugin from "../src/index.ts"
import { fakeHost } from "./fake-host.ts"
import { fakeStorage, type FakeStorage } from "./fake-storage.ts"

const A = { id: "ses_aaaa1111", title: "A" }
const B = { id: "ses_bbbb2222", title: "B" }

function synchronizedScans() {
  const raw = fakeStorage()
  let enabled = false
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const storage: FakeStorage = {
    ...raw,
    async scan(options) {
      const snapshot = await raw.scan(options)
      if (enabled && options.prefix === "v1/asks/" && arrivals < 2) {
        arrivals += 1
        if (arrivals === 2) release()
        await barrier
      }
      return snapshot
    },
  }
  return { storage, enable: () => { enabled = true }, release }
}

async function waitForPrompts(count: () => number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (count() === 2) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("the two concurrent asks did not both reach the host")
}

test.each(["same sender", "mutual"])("concurrent asks can pass the existing check: %s", async (kind) => {
  const synced = synchronizedScans()
  const a = fakeHost({ location: "/work/a", caller: A.id, sessions: [A], storage: synced.storage })
  const b = fakeHost({ location: "/work/b", caller: B.id, sessions: [B], storage: synced.storage })
  const stopA = await plugin.setup(a.context)
  const stopB = await plugin.setup(b.context)
  const abortA = new AbortController()
  const abortB = new AbortController()
  try {
    await a.call("peers", { action: "list" })
    await b.call("peers", { action: "list" })
    synced.enable()
    const first = a.call("peers", { action: "ask", to: B.id, message: "first" }, A.id, abortA.signal)
    const second = kind === "mutual"
      ? b.call("peers", { action: "ask", to: A.id, message: "second" }, B.id, abortB.signal)
      : a.call("peers", { action: "ask", to: B.id, message: "second" }, A.id, abortB.signal)
    try {
      await waitForPrompts(() => a.prompts.length + b.prompts.length)
      expect(a.prompts.length + b.prompts.length).toBe(2)
    } finally {
      abortA.abort()
      abortB.abort()
      synced.release()
      await Promise.all([first, second])
    }
  } finally {
    if (typeof stopA === "function") await stopA()
    if (typeof stopB === "function") await stopB()
  }
})

test("a reply selected before cancellation can be stored after the waiter stops", async () => {
  const raw = fakeStorage()
  let writing = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const storage: FakeStorage = {
    ...raw,
    async set(key, value) {
      if (key.startsWith("v1/replies/")) {
        writing = true
        await gate
      }
      await raw.set(key, value)
    },
  }
  const a = fakeHost({ location: "/work/a", caller: A.id, sessions: [A], storage })
  const b = fakeHost({ location: "/work/b", caller: B.id, sessions: [B], storage })
  const stopA = await plugin.setup(a.context)
  const stopB = await plugin.setup(b.context)
  try {
    await a.call("peers", { action: "list" })
    await b.call("peers", { action: "list" })
    const asking = a.call("peers", { action: "ask", to: B.id, message: "question" })
    for (let i = 0; i < 200 && a.prompts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(a.prompts).toHaveLength(1)
    const replying = b.call("peers", { action: "reply", message: "answer" })
    try {
      for (let i = 0; i < 200 && !writing; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(writing).toBe(true)
      expect((await a.call("peers", { action: "cancel" })).details).toMatchObject({ requested: true })
      expect((await asking).details).toMatchObject({ code: "E_ASK_CANCELLED" })
    } finally {
      release()
    }
    expect((await replying).details).toMatchObject({ outcome: "stored" })
    const replies = await storage.scan({ prefix: "v1/replies/" })
    expect(replies.entries).toHaveLength(1)
  } finally {
    release()
    if (typeof stopA === "function") await stopA()
    if (typeof stopB === "function") await stopB()
  }
})
