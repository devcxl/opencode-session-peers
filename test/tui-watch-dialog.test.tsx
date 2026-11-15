/** @jsxImportSource @opentui/solid */

/**
 * The watch dialog, driven through the host's headless renderer.
 *
 * `watch-view.ts` is asserted cell by cell in `tui-watch-view.test.ts`; this
 * file asserts what only the screen can: the facts reach a table, the two-step
 * pause/end confirmation asks before it acts, and a state change swaps the
 * content of the elements already there.
 */

import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

import type { WatchPayload } from "../src/rpc.ts"
import type { TuiPalette } from "../src/host/tui.ts"
import { WatchDialog } from "../src/tui/watch-dialog.tsx"
import type { WatchState } from "../src/tui/watch-view.ts"

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
    correction: "unavailable",
    correctionReason:
      "Finite correction is not implemented in this build; this watch can only record reports.",
    delegation: "unavailable",
    transfer: "unavailable",
    recovery: "unavailable",
  }
}

function controls(overrides: Partial<WatchPayload["controls"]> = {}): WatchPayload["controls"] {
  return {
    pause: control(),
    end: control(),
    resume: control(false, "Resume and recovery confirmation are not implemented in this build."),
    correction: control(false, "Finite correction is not implemented in this build."),
    transfer: control(false, "Watch ownership transfer is not implemented in this build."),
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
    lastReport: {
      reportID: "report_1",
      kind: "progress",
      evidence: { summary: "tests pass", reference: "src/auth.test.ts" },
      at: Date.UTC(2026, 10, 16, 4, 32, 0),
      version: 3,
    },
    createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
    updatedAt: Date.UTC(2026, 10, 16, 4, 32, 0),
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

async function rendered(
  initial: WatchState,
  options: {
    readonly height?: number
    readonly onPause?: (taskID: string, version: number) => Promise<void>
    readonly onEnd?: (taskID: string, version: number) => Promise<void>
  } = {},
) {
  const [state, setState] = createSignal<WatchState>(initial)
  const setup = await testRender(
    () => (
      <WatchDialog
        state={state}
        sessionID={SELF}
        palette={() => palette}
        onPause={options.onPause ?? (async () => {})}
        onEnd={options.onEnd ?? (async () => {})}
      />
    ),
    { width: 100, height: options.height ?? 40 },
  )
  await setup.flush()
  const frame = () => setup.captureCharFrame()
  const text = () => frame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
  return { setup, frame, text, setState }
}

describe("the watch dialog draws the panel", () => {
  test("the facts reach a table, with the state rows still separate", async () => {
    const { frame, text } = await rendered({
      kind: "payload",
      payload: payload(),
    })
    expect(text()).toContain("Session watch")
    expect(text()).toContain("target: this session (…0000)")
    expect(text()).toContain("task: task_0001 · version 3")
    expect(frame()).toContain("┌")
    expect(text()).toContain("Field")
    expect(text()).toContain("Value")
    expect(text()).toContain("Task state")
    expect(text()).toContain("in progress")
    expect(text()).toContain("Supervision")
    expect(text()).toContain("active")
    expect(text()).toContain("alert-only")
    expect(text()).toContain("this plugin instance · generation 1")
    expect(text()).toContain("Protocol")
    expect(text()).not.toContain("idle")
  })

  test("a state change swaps the rows without rebuilding the panel", async () => {
    const { setup, frame, text, setState } = await rendered({ kind: "loading" })
    expect(text()).toContain("reading the watch…")

    setState({
      kind: "payload",
      payload: payload({
        task: task({
          taskState: "completed",
          watchState: "ended",
          completedAt: Date.UTC(2026, 10, 16, 5, 10, 0),
          endedAt: Date.UTC(2026, 10, 16, 5, 10, 0),
          lastReport: {
            reportID: "report_done",
            kind: "completed",
            evidence: { summary: "migration finished", reference: "PR 65" },
            at: Date.UTC(2026, 10, 16, 5, 10, 0),
            version: 4,
          },
        }),
        controls: controls({
          pause: control(false, "the watch has ended"),
          end: control(false, "the watch has ended"),
        }),
      }),
    })
    await setup.flush()
    expect(text()).not.toContain("reading the watch…")
    expect(text()).toContain("completed")
    expect(text()).toContain("migration finished")
    expect(text()).toContain("Completion is recorded; supervision ended.")
    expect(text()).not.toContain("not a business success")
    expect(frame()).toContain("┌")
  })
})

describe("the two-step controls", () => {
  test("pause asks first and only y calls the port", async () => {
    const calls: [string, number][] = []
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onPause: async (taskID, version) => {
          calls.push([taskID, version])
        },
      },
    )

    setup.mockInput.pressKey("p")
    await setup.flush()
    expect(text()).toContain("Pause supervision? y: yes · n: cancel")
    expect(text()).toContain("the business session keeps running")
    expect(calls).toEqual([])

    setup.mockInput.pressKey("n")
    await setup.flush()
    expect(text()).not.toContain("Pause supervision?")
    expect(calls).toEqual([])

    setup.mockInput.pressKey("p")
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(calls).toEqual([["task_0001", 3]])
  })

  test("end asks first and only y calls the port", async () => {
    const calls: [string, number][] = []
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onEnd: async (taskID, version) => {
          calls.push([taskID, version])
        },
      },
    )

    setup.mockInput.pressKey("x")
    await setup.flush()
    expect(text()).toContain("End supervision? y: yes · n: cancel")
    expect(text()).toContain("this is not a business success")
    expect(calls).toEqual([])

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(calls).toEqual([["task_0001", 3]])
  })

  test("a disabled control advertises and performs nothing", async () => {
    const calls: string[] = []
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({ watchState: "ended", endedAt: Date.UTC(2026, 10, 16, 5, 0, 0) }),
          controls: controls({
            pause: control(false, "the watch has ended"),
            end: control(false, "the watch has ended"),
          }),
        }),
      },
      {
        onPause: async () => {
          calls.push("pause")
        },
        onEnd: async () => {
          calls.push("end")
        },
      },
    )
    expect(text()).toContain("this watch has ended")
    expect(text()).not.toContain("p: pause watch")
    expect(text()).not.toContain("x: end watch")

    setup.mockInput.pressKey("p")
    setup.mockInput.pressKey("x")
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(calls).toEqual([])
    expect(text()).not.toContain("Pause supervision?")
    expect(text()).not.toContain("End supervision?")
  })

  test("a state refresh clears a confirmation rather than applying an old one", async () => {
    const calls: string[] = []
    const { setup, text, setState } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onPause: async () => {
          calls.push("pause")
        },
      },
    )
    setup.mockInput.pressKey("p")
    await setup.flush()
    expect(text()).toContain("Pause supervision?")

    setState({
      kind: "payload",
      payload: payload({
        task: task({ watchState: "paused", version: 4 }),
        controls: controls({ pause: control(false, "the watch is already paused") }),
      }),
    })
    await setup.flush()
    expect(text()).not.toContain("Pause supervision?")

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(calls).toEqual([])
  })
})
