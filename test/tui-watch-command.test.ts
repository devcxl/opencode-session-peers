/**
 * The `/peers-watch` command and panel, driven through the TuiPort seam.
 *
 * The test does not call private helpers: it registers the command the way the
 * plugin does, runs the user's input, mounts the dialog the host was handed,
 * and asserts the RPC requests and the words on screen. Opening is one read;
 * enrollment, pause and end are explicit; no business session is touched.
 */

import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"

import { installWatch } from "../src/tui/watch-command.tsx"
import {
  SELF,
  commandOf,
  control,
  controls,
  fakePort,
  payload,
  task,
  tick,
} from "./tui-watch-fake.ts"

describe("opening /peers-watch", () => {
  test("takes one read-only snapshot and opens the panel", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    const command = commandOf(fake)

    expect(command.id).toBe("session-peers.watch")
    expect(command.title).toBe("Session watch")
    command.run()
    await tick(0)

    expect(fake.reads).toEqual([{ sessionID: SELF }])
    expect(fake.calls).toEqual([])
    expect(fake.rosterReads()).toBe(0)
    expect(fake.toasts).toEqual([])
    expect(fake.shown()).toBeDefined()
    expect(fake.dialogSets).toEqual([{ size: "xlarge", centered: true }])

    dispose()
    expect(fake.subscribed()).toBe(false)
  })

  test("says there is no session instead of reading another location", async () => {
    const fake = fakePort({ sessionID: undefined })
    const dispose = installWatch(fake.port)
    commandOf(fake).run()
    await tick(0)

    expect(fake.reads).toEqual([])
    expect(fake.shown()).toBeUndefined()
    expect(fake.toasts).toEqual([
      { message: "Peers watch: no session is open here.", variant: "warning" },
    ])
    dispose()
  })

  test("a watch change takes another snapshot while the panel is open", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run()
    await tick(0)
    expect(fake.reads).toHaveLength(1)

    fake.announce()
    await tick(0)
    expect(fake.reads).toHaveLength(2)
    dispose()
  })
})

describe("explicit enrollment", () => {
  test("enrolls the current session with the goal and a fresh request id", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run("enroll finish the migration")
    await tick(0)

    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.operation).toBe("enroll")
    expect(call.sessionID).toBe(SELF)
    expect(call.goal).toBe("finish the migration")
    expect(call.requestId).toMatch(/^ui-/)
    expect(call.targetSessionID).toBe(SELF)
    expect(call.mode).toBe("alert")
    expect(call.taskID).toBeUndefined()
    expect(call.expectedVersion).toBeUndefined()
    // The panel is opened after the answer, so it takes its own snapshot.
    expect(fake.reads).toEqual([{ sessionID: SELF }])
    expect(fake.toasts).toEqual([
      { message: "Watch enrolled. No prompt was sent.", variant: "success" },
    ])
    dispose()
  })

  test("a refused enrollment says why and opens the panel to show the truth", async () => {
    const fake = fakePort({
      call: async () =>
        payload({
          task: null,
          controls: controls({
            pause: control(false, "no watched task is enrolled for this session"),
            end: control(false, "no watched task is enrolled for this session"),
          }),
          failure: {
            code: "E_WATCH_SESSION_BUSY",
            reason: "That session already has a live watched task.",
            detail: null,
          },
        }),
    })
    const dispose = installWatch(fake.port)
    commandOf(fake).run("enroll another goal")
    await tick(0)

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain(
      "Could not enroll the watch: That session already has a live watched task.",
    )
    expect(fake.reads).toHaveLength(1)
    expect(fake.shown()).toBeDefined()
    dispose()
  })

  test("an empty goal is a usage error, not an enrollment", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run("enroll")
    await tick(0)
    expect(fake.calls).toEqual([])
    expect(fake.toasts[0]?.message).toContain("usage: /peers-watch")
    dispose()
  })
})

describe("explicit control from the command line", () => {
  test("pause carries the task id and the version the reader saw", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run("pause task_0001 3")
    await tick(0)

    expect(fake.calls).toEqual([
      { operation: "pause", sessionID: SELF, taskID: "task_0001", expectedVersion: 3 },
    ])
    expect(fake.toasts).toEqual([
      { message: "Watch paused. The session keeps running.", variant: "success" },
    ])
    dispose()
  })

  test("end does not claim success for an unfinished task", async () => {
    const fake = fakePort({
      call: async () => payload({ task: task({ watchState: "ended" }) }),
    })
    const dispose = installWatch(fake.port)
    commandOf(fake).run("end task_0001 3")
    await tick(0)

    expect(fake.calls[0]).toMatchObject({ operation: "end", taskID: "task_0001", expectedVersion: 3 })
    expect(fake.toasts).toEqual([
      { message: "Watch ended. This is not a business success.", variant: "success" },
    ])
    dispose()
  })

  test("a missing version is usage, not a control call", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run("pause task_0001")
    await tick(0)
    expect(fake.calls).toEqual([])
    expect(fake.toasts[0]?.message).toContain("usage: /peers-watch")
    dispose()
  })
})

describe("the panel's own controls", () => {
  test("p then y pauses once, applies the answer and refreshes", async () => {
    let current = payload()
    const fake = fakePort({
      read: async () => current,
      call: async () => {
        current = payload({
          task: task({
            watchState: "paused",
            version: 4,
            pause: { kind: "manual", reason: "paused by the user" },
          }),
        })
        return current
      },
    })
    const dispose = installWatch(fake.port)
    commandOf(fake).run()
    await tick(0)

    const setup = await testRender(() => {
      const render = fake.shown()
      if (render === undefined) throw new Error("the panel was not opened")
      return render()
    }, { width: 100, height: 40 })
    await setup.flush()

    setup.mockInput.pressKey("p")
    await setup.flush()
    setup.mockInput.pressKey("y")
    await setup.flush()
    await tick(0)
    await setup.flush()

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      operation: "pause",
      sessionID: SELF,
      taskID: "task_0001",
      expectedVersion: 3,
    })
    // One read on open and one after the committed control.
    expect(fake.reads).toHaveLength(2)
    expect(fake.toasts).toContainEqual({
      message: "Watch paused. The session keeps running.",
      variant: "success",
    })
    const text = setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("paused (manual)")
    expect(text).toContain("paused by the user")
    dispose()
    setup.renderer.destroy()
  })

  test("a failed control is reported and refreshed, not retried", async () => {
    const fake = fakePort({
      call: async () =>
        payload({
          task: null,
          failure: {
            code: "E_WATCH_STALE",
            reason: "The watch state changed since it was read.",
            detail: "version 4",
          },
        }),
    })
    const dispose = installWatch(fake.port)
    commandOf(fake).run()
    await tick(0)

    const setup = await testRender(() => {
      const render = fake.shown()
      if (render === undefined) throw new Error("the panel was not opened")
      return render()
    }, { width: 100, height: 40 })
    await setup.flush()

    setup.mockInput.pressKey("x")
    setup.mockInput.pressKey("y")
    await setup.flush()
    await tick(0)
    await setup.flush()

    // The write was attempted once; the follow-up is a read, not a second end.
    expect(fake.calls).toHaveLength(1)
    expect(fake.reads).toHaveLength(2)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("E_WATCH_STALE")
    const text = setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Task state")
    expect(text).not.toContain("Session watch is unavailable")
    dispose()
    setup.renderer.destroy()
  })
})

describe("peers-watch children command", () => {
  test("children opens delegation panel with 1 read and 0 writes", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    // Run /peers-watch children
    commandOf(fake).run("children")
    await tick(0)

    expect(fake.dialogShows()).toBeGreaterThan(0)
    expect(fake.delegationReads).toHaveLength(1)
    expect(fake.delegationCalls).toHaveLength(0)
    expect(fake.calls).toHaveLength(0)

    const setup = await testRender(() => {
      const render = fake.shown()
      if (render === undefined) throw new Error("the delegation panel was not opened")
      return render()
    }, { width: 100, height: 40 })
    await setup.flush()

    const text = setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Session watch — delegation")
    expect(text).toContain("g: grant delegation")
    dispose()
    setup.renderer.destroy()
  })

  test("children with childID and mode opens review stage without writing", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    // Run /peers-watch children ses_child_prefill limited
    commandOf(fake).run("children ses_child_prefill limited")
    await tick(0)

    expect(fake.delegationCalls).toHaveLength(0)
    const setup = await testRender(() => {
      const render = fake.shown()
      if (render === undefined) throw new Error("the delegation panel was not opened")
      return render()
    }, { width: 100, height: 40 })
    await setup.flush()

    const text = setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Session watch — delegation review")
    expect(text).toContain("Target child session: ses_child_prefill")
    expect(text).toContain("Delegation mode: limited-correction")
    expect(text).toContain("y: declare + prepare challenge · n: cancel")
    // Absolutely no prepare/confirm/grant write RPC was issued
    expect(fake.delegationCalls).toHaveLength(0)
    dispose()
    setup.renderer.destroy()
  })

  test("pressing k in watch dialog opens delegation panel", async () => {
    const fake = fakePort()
    const dispose = installWatch(fake.port)
    commandOf(fake).run()
    await tick(0)

    const setup = await testRender(() => {
      const render = fake.shown()
      return render ? render() : null
    }, { width: 100, height: 40 })
    await setup.flush()

    // Press k from task watch view
    setup.mockInput.pressKey("k")
    await setup.flush()
    await tick(10)
    await setup.flush()

    expect(fake.dialogShows()).toBe(2)
    const delegationSetup = await testRender(() => {
      const render = fake.shown()
      if (render === undefined) throw new Error("the delegation panel was not opened")
      return render()
    }, { width: 100, height: 40 })
    await delegationSetup.flush()

    const text = delegationSetup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Session watch — delegation")
    dispose()
    setup.renderer.destroy()
    delegationSetup.renderer.destroy()
  })
})
