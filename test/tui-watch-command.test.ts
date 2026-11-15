/**
 * The `/peers-watch` command and panel, driven through the TuiPort seam.
 *
 * The test does not call private helpers: it registers the command the way the
 * plugin does, runs the user's input, mounts the dialog the host was handed,
 * and asserts the RPC requests and the words on screen. Opening is one read;
 * enrollment, pause and end are explicit; no business session is touched.
 */

import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"

import type { WatchPayload } from "../src/rpc.ts"
import type {
  TuiCommand,
  TuiPalette,
  TuiPort,
  WatchCallRequest,
  WatchReadRequest,
  ToastVariant,
} from "../src/host/tui.ts"
import { installWatch } from "../src/tui/watch-command.tsx"

const SELF = "ses_self0000"
const palette: TuiPalette = {
  base: RGBA.fromHex("#cdd6f4"),
  muted: RGBA.fromHex("#7f849c"),
  error: RGBA.fromHex("#f38ba8"),
}

type Task = NonNullable<WatchPayload["task"]>

function control(enabled = true, reason: string | null = null) {
  return { enabled, reason }
}

function capability(): WatchPayload["capability"] {
  return {
    mode: "alert",
    monitoring: "participant-reports-only",
    automaticDetection: "unavailable",
    automaticDetectionReason: "No supported execution signal is available in this build.",
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

function controls(overrides: Partial<WatchPayload["controls"]> = {}): WatchPayload["controls"] {
  return {
    pause: control(),
    end: control(),
    resume: control(false, "Resume is not implemented in this build."),
    correction: control(false, "Correction is not implemented in this build."),
    transfer: control(false, "Transfer is not implemented in this build."),
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    taskID: "task_0001",
    initiatorSessionID: SELF,
    targetSessionID: SELF,
    goal: "finish the migration",
    mode: "alert",
    watchState: "active",
    taskState: "in-progress",
    version: 3,
    generation: 1,
    ownership: "this-instance",
    participation: "seen",
    attempts: { used: 0, limit: 3 },
    pause: null,
    lastReport: null,
    createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
    updatedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
    completedAt: null,
    endedAt: null,
    ...overrides,
  }
}

function payload(overrides: Partial<WatchPayload> = {}): WatchPayload {
  return {
    enabled: true,
    ledger: { available: true, reason: null },
    task: task(),
    capability: capability(),
    controls: controls(),
    failure: null,
    ...overrides,
  }
}

interface FakeOptions {
  readonly sessionID?: string | undefined
  readonly read?: () => Promise<unknown>
  readonly call?: (request: WatchCallRequest) => Promise<unknown>
}

function fakePort(options: FakeOptions = {}) {
  const reads: WatchReadRequest[] = []
  const calls: WatchCallRequest[] = []
  const toasts: { message: string; variant: ToastVariant | undefined }[] = []
  const commands: TuiCommand[] = []
  const dialogSets: { size: string; centered: boolean }[] = []
  let shown: Parameters<TuiPort["dialog"]["show"]>[0] | undefined
  let onClose: (() => void) | undefined
  let listener: (() => void) | undefined
  let rosterReads = 0

  const port: TuiPort = {
    palette: () => palette,
    roster: {
      read: async () => {
        rosterReads += 1
        return {}
      },
      onChange: () => () => {},
    },
    watch: {
      read: (request) => {
        reads.push(request)
        return options.read?.() ?? Promise.resolve(payload())
      },
      call: (request) => {
        calls.push(request)
        return options.call?.(request) ?? Promise.resolve(payload())
      },
      onChange: (on) => {
        listener = on
        return () => {
          listener = undefined
        }
      },
    },
    setScope: async () => ({}),
    toast: (message, variant) => {
      toasts.push({ message, variant })
    },
    currentSession: () => ({
      sessionID: Object.prototype.hasOwnProperty.call(options, "sessionID")
        ? options.sessionID
        : SELF,
      directory: "/work/alpha",
    }),
    command: (command) => {
      commands.push(command)
    },
    dialog: {
      show: (render, close) => {
        shown = render
        onClose = close
      },
      set: (presentation) => {
        dialogSets.push(presentation)
      },
    },
  }

  return {
    port,
    reads,
    calls,
    toasts,
    commands,
    dialogSets,
    shown: () => shown,
    rosterReads: () => rosterReads,
    close: () => onClose?.(),
    announce: () => listener?.(),
    subscribed: () => listener !== undefined,
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function commandOf(fake: ReturnType<typeof fakePort>): TuiCommand {
  const command = fake.commands.find((candidate) => candidate.slash === "peers-watch")
  if (command === undefined) throw new Error("the watch command was not registered")
  return command
}

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
