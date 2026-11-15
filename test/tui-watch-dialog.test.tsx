import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

import { WatchDialog } from "../src/tui/watch-dialog.tsx"
import type { WatchState } from "../src/tui/watch-view.ts"
import {
  SELF,
  alert,
  alertsView,
  attempt,
  control,
  controls,
  correction,
  gate,
  observation,
  palette,
  payload,
  task,
  wait,
} from "./tui-watch-fake.ts"

async function rendered(
  initial: WatchState,
  options: {
    readonly height?: number
    readonly onPause?: (taskID: string, version: number) => Promise<void>
    readonly onEnd?: (taskID: string, version: number) => Promise<void>
    readonly onAck?: (alertID: string) => Promise<void>
    readonly onGrantPrepare?: () => Promise<
      { readonly reviewSummary: string; readonly expiresAt: number } | undefined
    >
    readonly onGrantConfirm?: () => Promise<void>
    readonly onGrantCancel?: () => void
    readonly onDowngrade?: () => Promise<void>
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
        onAck={options.onAck ?? (async () => {})}
        onGrantPrepare={options.onGrantPrepare ?? (async () => undefined)}
        onGrantConfirm={options.onGrantConfirm ?? (async () => {})}
        onGrantCancel={options.onGrantCancel ?? (() => {})}
        onDowngrade={options.onDowngrade ?? (async () => {})}
      />
    ),
    { width: 100, height: options.height ?? 60 },
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
    expect(text()).toContain("0 of 3 used")
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
    expect(text()).toContain("ended (task completed)")
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
        task: task({
          watchState: "paused",
          version: 4,
          pause: { kind: "manual", reason: "paused by the user" },
        }),
        controls: controls({ pause: control(false, "the watch is already paused") }),
      }),
    })
    await setup.flush()
    expect(text()).not.toContain("Pause supervision?")
    expect(text()).toContain("paused (manual)")
    expect(text()).toContain("paused by the user")

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(calls).toEqual([])
  })
})

describe("the alert pane", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    alert({
      alertID: `alert_${String(index + 1).padStart(4, "0")}`,
      summary: `Problem ${index + 1}`,
      state: index === 1 ? "read" : "unread",
    }),
  )

  test("v switches to alerts, shows unread/read/resolved and pages by identity", async () => {
    const { setup, text } = await rendered({
      kind: "payload",
      payload: payload({
        alerts: alertsView([
          alert({ alertID: "alert_0001", summary: "Idle problem" }),
          alert({
            alertID: "alert_0002",
            state: "read",
            readAt: Date.UTC(2026, 10, 16, 4, 35, 0),
            resolvedAt: Date.UTC(2026, 10, 16, 4, 36, 0),
          }),
        ]),
      }),
    })

    setup.mockInput.pressKey("v")
    await setup.flush()
    expect(text()).toContain("Session watch — alerts")
    expect(text()).toContain("…0001")
    expect(text()).toContain("sustained idle")
    expect(text()).toContain("unread")
    expect(text()).toContain("…0002")
    expect(text()).toContain("read · resolved")
    expect(text()).toContain("Next:")

    setup.mockInput.pressKey("v")
    await setup.flush()
    expect(text()).toContain("Session watch")
    expect(text()).not.toContain("Session watch — alerts")
  })

  test("a marks only the selected unread alert read", async () => {
    const acks: string[] = []
    const { setup } = await rendered(
      {
        kind: "payload",
        payload: payload({
          alerts: alertsView([
            alert({ alertID: "alert_0001" }),
            alert({ alertID: "alert_0002" }),
          ]),
        }),
      },
      {
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )

    setup.mockInput.pressKey("v")
    await setup.flush()
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual(["alert_0001"])

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual(["alert_0001", "alert_0002"])
  })

  test("a read alert is not acknowledged again, and a disabled control explains why", async () => {
    const acks: string[] = []
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          alerts: alertsView([
            alert({ alertID: "alert_0001", state: "read", readAt: Date.UTC(2026, 10, 16, 4, 35, 0) }),
          ]),
        }),
      },
      {
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )
    setup.mockInput.pressKey("v")
    await setup.flush()
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual([])
    expect(text()).toContain("already read")
  })

  test("a disabled acknowledge control shows the server reason and performs nothing", async () => {
    const acks: string[] = []
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          alerts: alertsView([alert({ alertID: "alert_0001" })]),
          controls: controls({ acknowledge: control(false, "only the initiator may acknowledge") }),
        }),
      },
      {
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )
    setup.mockInput.pressKey("v")
    await setup.flush()
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual([])
    expect(text()).toContain("Mark read unavailable: only the initiator may acknowledge")
  })

  test("pages alerts and keeps selection on a visible alert id", async () => {
    const acks: string[] = []
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload({ alerts: alertsView(many) }) },
      {
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )
    setup.mockInput.pressKey("v")
    await setup.flush()
    expect(text()).toContain("…0001")
    expect(text()).not.toContain("…0009")
    expect(text()).toContain("page 1 of 2")

    setup.mockInput.pressArrow("right")
    await setup.flush()
    expect(text()).toContain("…0009")
    expect(text()).toContain("page 2 of 2")

    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual(["alert_0009"])
  })

  test("a paused task still shows its alert history and can acknowledge it", async () => {
    const acks: string[] = []
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            watchState: "paused",
            pause: { kind: "manual", reason: "paused by the user" },
          }),
          alerts: alertsView([alert({ alertID: "alert_0001" })]),
        }),
      },
      {
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )
    setup.mockInput.pressKey("v")
    await setup.flush()
    expect(text()).toContain("…0001")
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual(["alert_0001"])
  })

  test("p and x do not arm task controls in the alert pane", async () => {
    const pauses: string[] = []
    const { setup } = await rendered(
      { kind: "payload", payload: payload({ alerts: alertsView([alert()]) }) },
      {
        onPause: async (taskID) => {
          pauses.push(taskID)
        },
      },
    )
    setup.mockInput.pressKey("v")
    await setup.flush()
    setup.mockInput.pressKey("p")
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(pauses).toEqual([])
  })
})

describe("a short terminal", () => {
  test("keeps the title, observation and pause question visible", async () => {
    const { setup, text } = await rendered({ kind: "payload", payload: payload() }, { height: 40 })
    expect(text()).toContain("Session watch")
    expect(text()).toContain("Observation")
    expect(text()).toContain("Progress")
    expect(text()).toContain("observer alerts")

    setup.mockInput.pressKey("p")
    await setup.flush()
    expect(text()).toContain("Pause supervision?")
    expect(text()).toContain("the business session keeps running")
  })

  test("keeps the title and alert entry visible when an alert exists", async () => {
    const { text } = await rendered(
      {
        kind: "payload",
        payload: payload({ alerts: alertsView([alert({ alertID: "alert_0001" })]) }),
      },
      { height: 40 },
    )
    expect(text()).toContain("Session watch")
    expect(text()).toContain("v: alerts")
  })

  test("keeps an unavailable alert store visible on a short terminal", async () => {
    const acks: string[] = []
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          alerts: alertsView([], {
            available: false,
            reason: "the alert store is locked",
            unread: 0,
            total: 0,
            active: 0,
          }),
        }),
      },
      {
        height: 40,
        onAck: async (alertID) => {
          acks.push(alertID)
        },
      },
    )
    expect(text()).toContain("Session watch")
    expect(text()).toContain("Alerts")
    expect(text()).toContain("unavailable — the alert store is locked")
    expect(text()).not.toContain("none recorded")
    setup.mockInput.pressKey("v")
    setup.mockInput.pressKey("a")
    await setup.flush()
    expect(acks).toEqual([])
  })

  test("keeps a trusted-false running-silence readable on a short terminal", async () => {
    const { text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task(),
          observation: {
            ...requireObservation(),
            state: "running-silence",
            trusted: false,
            waitsPartial: true,
            reason: "a form wait may have been missed after a gap",
          },
        }),
      },
      { height: 40 },
    )
    expect(text()).toContain("Session watch")
    expect(text()).toContain("running, no new activity")
    expect(text()).toContain("not trusted")
    expect(text()).toContain("absence is not proof")
  })

  function requireObservation() {
    const view = payload().observation
    if (view === null) throw new Error("fixture has no observation")
    return view
  }
})

describe("the bounded wait capacity on a short terminal", () => {
  test("pages twelve waits without losing trust, partial, result or controls", async () => {
    const waits = Array.from({ length: 12 }, (_, index) =>
      wait({
        waitID: `wait_${String(index + 1).padStart(2, "0")}`,
        source: index === 0 ? "reported" : "permission",
        object: `object ${index + 1}`,
        reason:
          index === 0
            ? "a deliberately long reason that explains why this wait is still active and what response is missing"
            : `reason ${index + 1}`,
        status: index === 11 ? "denied" : "active",
        denyEvidence: index === 11 ? "the approval was refused" : null,
        deadline: null,
      }),
    )
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            lastReport: {
              reportID: "report_progress",
              kind: "progress",
              evidence: { summary: "tests pass", reference: "src/auth.test.ts" },
              at: Date.UTC(2026, 10, 16, 4, 32, 0),
              version: 3,
            },
          }),
          observation: observation({
            state: "normal-waiting",
            waits,
            waitsPartial: true,
          }),
          alerts: alertsView([alert({ alertID: "alert_0001" })]),
        }),
      },
      { height: 40 },
    )

    expect(text()).toContain("Session watch")
    expect(text()).toContain("Observation")
    expect(text()).toContain("normal waiting")
    expect(text()).toContain("trusted")
    expect(text()).toContain("partial")
    expect(text()).toContain("Result")
    expect(text()).toContain("showing waits 1–2 of 12")
    expect(text()).toContain("p: pause watch")
    expect(text()).toContain("x: end watch")
    expect(text()).toContain("v: alerts (1 unread)")

    setup.mockInput.pressArrow("right")
    await setup.flush()
    expect(text()).toContain("showing waits 3–4 of 12")

    for (let index = 0; index < 4; index += 1) setup.mockInput.pressArrow("right")
    await setup.flush()
    expect(text()).toContain("showing waits 11–12 of 12")
    expect(text()).toContain("denied — the approval was refused")
  })
})

describe("the correction pane and controlled grant review", () => {
  test("c opens correction read-only and shows authorization separately from actual capability", async () => {
    let prepares = 0
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            correction: correction({
              authorization: {
                ...payload().task!.correction.authorization,
                deployment: "single-host-same-location",
              },
            }),
          }),
        }),
      },
      {
        onGrantPrepare: async () => {
          prepares += 1
          return undefined
        },
      },
    )
    setup.mockInput.pressKey("c")
    await setup.flush()
    expect(text()).toContain("Session watch — correction")
    expect(text()).toContain("Authorization")
    expect(text()).toContain("Actual capability")
    expect(text()).toContain("declaration, not proof")
    expect(text()).toContain("g: review correction grant")
    expect(prepares).toBe(0)
    expect(text()).not.toContain("challenge-once")
  })

  test("g shows the terms before preparing; n cancels without a write", async () => {
    let prepares = 0
    let cancels = 0
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onGrantPrepare: async () => {
          prepares += 1
          return { reviewSummary: "Reviewed terms.", expiresAt: 10_000 }
        },
        onGrantCancel: () => {
          cancels += 1
        },
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("g")
    await setup.flush()
    const review = text()
    expect(review).toContain("3 permanent attempts")
    expect(review).toContain("only the first attempt")
    expect(review).toContain("same OS user and location")
    expect(review).toContain("controlled panel confirmation channel")
    expect(review).toContain("not same-OS-user authentication")
    expect(review).toContain("not proof that no other service is running")
    expect(review).toContain("does not stop business work or reset used attempts")
    expect(prepares).toBe(0)

    setup.mockInput.pressKey("n")
    await setup.flush()
    expect(prepares).toBe(0)
    expect(cancels).toBeGreaterThan(0)
    expect(text()).not.toContain("3 permanent attempts")
  })

  test("y prepares a challenge, y confirms it, and the nonce never reaches the screen", async () => {
    let prepares = 0
    let confirms = 0
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onGrantPrepare: async () => {
          prepares += 1
          return { reviewSummary: "Reviewed terms.", expiresAt: 10_000 }
        },
        onGrantConfirm: async () => {
          confirms += 1
        },
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("g")
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(prepares).toBe(1)
    expect(text()).toContain("Challenge prepared")
    expect(text()).toContain("Reviewed terms.")
    expect(text()).not.toContain("challenge-once")

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(confirms).toBe(1)
  })

  test("a server-disabled grant is not armed, even when global detection is partial", async () => {
    let prepares = 0
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            correction: {
              ...payload().task!.correction,
              controls: {
                grant: control(false, "the current activation does not own this task"),
                downgrade: control(false, "no grant is active"),
              },
            },
          }),
        }),
      },
      {
        onGrantPrepare: async () => {
          prepares += 1
          return undefined
        },
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("g")
    await setup.flush()
    expect(prepares).toBe(0)
    expect(text()).toContain("Correction grant unavailable: the current activation does not own this task")
    expect(text()).not.toContain("3 permanent attempts")
  })

  test("downgrade asks first and only y calls the server", async () => {
    let downgrades = 0
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            correction: {
              ...payload().task!.correction,
              controls: {
                grant: control(false, "grant is recorded"),
                downgrade: control(true),
              },
            },
          }),
        }),
      },
      {
        onDowngrade: async () => {
          downgrades += 1
        },
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("d")
    await setup.flush()
    expect(text()).toContain("Downgrade to alert-only?")
    expect(downgrades).toBe(0)

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(downgrades).toBe(1)
  })

  test("a state refresh discards a prepared grant challenge", async () => {
    let cancels = 0
    const { setup, text, setState } = await rendered(
      { kind: "payload", payload: payload() },
      {
        onGrantPrepare: async () => ({ reviewSummary: "Reviewed terms.", expiresAt: 10_000 }),
        onGrantConfirm: async () => {},
        onGrantCancel: () => {
          cancels += 1
        },
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("g")
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(text()).toContain("Challenge prepared")

    setState({ kind: "payload", payload: payload({ task: task({ version: 4 }) }) })
    await setup.flush()
    expect(text()).not.toContain("Challenge prepared")
    expect(cancels).toBeGreaterThan(0)
  })
})

describe("the correction pane on a short terminal", () => {
  test("keeps authorization, actual capability and the back hint visible", async () => {
    const { setup, text } = await rendered(
      { kind: "payload", payload: payload() },
      { height: 40 },
    )
    setup.mockInput.pressKey("c")
    await setup.flush()
    expect(text()).toContain("Session watch — correction")
    expect(text()).toContain("Authorization")
    expect(text()).toContain("Actual capability")
    expect(text()).toContain("c: task")
  })
})

describe("the focused grant review on a short terminal", () => {
  test("keeps all terms, the declaration and y/n visible above real histories and gates", async () => {
    const attempts = Array.from({ length: 3 }, (_, index) =>
      attempt({
        attemptID: `attempt_${index + 1}`,
        ordinal: index + 1,
        phase: index === 2 ? "recovered" : "rejected",
      }),
    )
    const gates = Array.from({ length: 15 }, (_, index) =>
      gate({
        gate: index === 0 ? "executor" : "observation",
        ok: false,
        reason: `gate ${index + 1} is closed`,
      }),
    )
    const longSummary = `Reviewed terms. ${"This summary is deliberately long. ".repeat(12)}`
    const { setup, text } = await rendered(
      {
        kind: "payload",
        payload: payload({
          task: task({
            correction: correction({
              attempts: { used: 3, limit: 3 },
              phase: "recovered",
              history: attempts,
              last: attempts[2],
              gates,
              controls: { grant: control(), downgrade: control(false, "no grant") },
            }),
          }),
        }),
      },
      {
        height: 40,
        onGrantPrepare: async () => ({ reviewSummary: longSummary, expiresAt: 10_000 }),
      },
    )
    setup.mockInput.pressKey("c")
    setup.mockInput.pressKey("g")
    await setup.flush()

    const review = text()
    expect(review).toContain("Session watch — grant review")
    expect(review).toContain("3 permanent attempts")
    expect(review).toContain("only the first attempt")
    expect(review).toContain("same OS user and location")
    expect(review).toContain("controlled panel confirmation channel")
    expect(review).toContain("not proof that no other service is running")
    expect(review).toContain("does not stop business work or reset used attempts")
    expect(review).toContain("y: declare + prepare challenge")
    expect(review).toContain("n: cancel")
    // The focused review must not be buried under the normal correction table.
    expect(review).not.toContain("Gate executor")
    expect(review).not.toContain("Attempt 1")

    setup.mockInput.pressKey("y")
    await setup.flush()
    const confirmation = text()
    expect(confirmation).toContain("Session watch — grant confirmation")
    expect(confirmation).toContain("Challenge prepared")
    expect(confirmation).toContain("y: grant")
    expect(confirmation).toContain("n: cancel")
  })
})
