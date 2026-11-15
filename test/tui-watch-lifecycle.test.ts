/**
 * A control or enrollment answer belongs to the panel that asked for it.
 *
 * The backend write is never cancelled here; the test only proves that a late
 * answer cannot apply to another panel, reopen a closed one, or touch a plugin
 * that has already been disposed.
 */

import { describe, expect, test } from "bun:test"

import { installWatch } from "../src/tui/watch-command.tsx"
import {
  SELF,
  commandOf,
  deferred,
  fakePort,
  mountPanel,
  panelPayload,
  tick,
} from "./tui-watch-fake.ts"

describe("late answers belong to the panel that asked", () => {
  test("a slow pause on A does not overwrite or switch back from B", async () => {
    const other = "ses_other9999"
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async (request) =>
        request.sessionID === SELF
          ? panelPayload(SELF, "task_a")
          : panelPayload(other, "task_b"),
      call: () => slow.promise,
    })
    const dispose = installWatch(fake.port)

    commandOf(fake).run()
    await tick(0)
    const panelA = await mountPanel(fake)
    panelA.mockInput.pressKey("p")
    panelA.mockInput.pressKey("y")
    await panelA.flush()
    expect(fake.calls).toHaveLength(1)

    fake.setSession(other)
    commandOf(fake).run()
    await tick(0)
    expect(fake.dialogShows()).toBe(2)
    expect(fake.reads).toEqual([{ sessionID: SELF }, { sessionID: other }])

    slow.resolve(panelPayload(SELF, "task_a", "paused"))
    await tick(0)

    // The answer cannot be applied to B, nor reopen A, nor claim B paused.
    expect(fake.reads).toHaveLength(2)
    expect(fake.dialogShows()).toBe(2)
    expect(fake.toasts).toEqual([])
    const panelB = await mountPanel(fake)
    const text = panelB.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("…9999")
    expect(text).not.toContain("…0000")

    dispose()
    panelA.renderer.destroy()
    panelB.renderer.destroy()
  })

  test("a slow enroll does not switch away from a panel opened meanwhile", async () => {
    const other = "ses_other9999"
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async (request) => panelPayload(request.sessionID, "task_b"),
      call: () => slow.promise,
    })
    const dispose = installWatch(fake.port)

    commandOf(fake).run("enroll the old goal")
    await tick(0)
    expect(fake.calls).toHaveLength(1)

    fake.setSession(other)
    commandOf(fake).run()
    await tick(0)
    expect(fake.dialogShows()).toBe(1)
    expect(fake.reads).toEqual([{ sessionID: other }])

    slow.resolve(panelPayload(SELF, "task_a"))
    await tick(0)

    expect(fake.dialogShows()).toBe(1)
    expect(fake.reads).toEqual([{ sessionID: other }])
    expect(fake.toasts).toEqual([])

    const panel = await mountPanel(fake)
    const text = panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("…9999")
    expect(text).not.toContain("…0000")

    dispose()
    panel.renderer.destroy()
  })
})

describe("a disposed plugin ignores late answers", () => {
  test("a slow enroll after dispose opens nothing, reads nothing and says nothing", async () => {
    const slow = deferred<unknown>()
    const fake = fakePort({ call: () => slow.promise })
    const dispose = installWatch(fake.port)

    commandOf(fake).run("enroll the goal")
    await tick(0)
    expect(fake.calls).toHaveLength(1)

    dispose()
    slow.resolve(panelPayload(SELF, "task_a"))
    await tick(0)

    expect(fake.dialogShows()).toBe(0)
    expect(fake.reads).toEqual([])
    expect(fake.toasts).toEqual([])
    expect(fake.subscribed()).toBe(false)
  })

  test("a slow pause after dispose does not toast, read or reopen", async () => {
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async () => panelPayload(SELF, "task_a"),
      call: () => slow.promise,
    })
    const dispose = installWatch(fake.port)

    commandOf(fake).run()
    await tick(0)
    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("p")
    panel.mockInput.pressKey("y")
    await panel.flush()
    expect(fake.calls).toHaveLength(1)

    dispose()
    slow.resolve(panelPayload(SELF, "task_a", "paused"))
    await tick(0)

    expect(fake.dialogShows()).toBe(1)
    expect(fake.reads).toHaveLength(1)
    expect(fake.toasts).toEqual([])
    expect(fake.subscribed()).toBe(false)
    panel.renderer.destroy()
  })
})

describe("a closed panel no longer owns a slow answer", () => {
  test("closing A while its pause is pending drops the answer", async () => {
    const slow = deferred<unknown>()
    const fake = fakePort({
      read: async () => panelPayload(SELF, "task_a"),
      call: () => slow.promise,
    })
    const dispose = installWatch(fake.port)

    commandOf(fake).run()
    await tick(0)
    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("p")
    panel.mockInput.pressKey("y")
    await panel.flush()
    expect(fake.calls).toHaveLength(1)

    fake.close()
    slow.resolve(panelPayload(SELF, "task_a", "paused"))
    await tick(0)

    expect(fake.reads).toHaveLength(1)
    expect(fake.toasts).toEqual([])
    expect(fake.dialogShows()).toBe(1)

    dispose()
    panel.renderer.destroy()
  })
})
