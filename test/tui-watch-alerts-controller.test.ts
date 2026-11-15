/**
 * Alert acknowledgement and the one non-intrusive reminder, driven through the
 * TuiPort seam. The reminder is a local toast for a durable escalation fact; it
 * is never sent on opening/reconnect, from a pure nudge, or for a paused task.
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import { installWatch } from "../src/tui/watch-command.tsx"
import {
  SELF,
  alert,
  alertsView,
  commandOf,
  control,
  controls,
  fakePort,
  mountPanel,
  payload,
  task,
  tick,
} from "./tui-watch-fake.ts"

const OPENED_AT = 1_000
const OLD_ESCALATION = 900
const NEW_ESCALATION = 2_000

function withAlert(
  item: ReturnType<typeof alert>,
  overrides: Partial<WatchPayload> = {},
): WatchPayload {
  return payload({ alerts: alertsView([item]), ...overrides })
}

describe("the one non-intrusive reminder", () => {
  test("opening or reconnecting seeds escalated alerts without a toast", async () => {
    const fake = fakePort({
      read: async () =>
        withAlert(alert({ escalatedAt: NEW_ESCALATION })),
    })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    expect(fake.reads).toHaveLength(1)
    expect(fake.toasts).toEqual([])
    dispose()
  })

  test("closing the panel does not read or toast a later escalation; reopening seeds it", async () => {
    const escalatedAt = NEW_ESCALATION
    let current = payload()
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)
    const reads = fake.reads.length

    fake.close()
    current = withAlert(alert({ escalatedAt }))
    fake.announce()
    await tick(0)
    expect(fake.reads).toHaveLength(reads)
    expect(fake.toasts).toEqual([])

    commandOf(fake).run()
    await tick(0)
    expect(fake.reads).toHaveLength(reads + 1)
    expect(fake.toasts).toEqual([])
    dispose()
  })

  test("a later durable escalation produces one toast, never a nudge-only one", async () => {
    const escalatedAt = NEW_ESCALATION
    let current = payload()
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = withAlert(alert({ escalatedAt }))
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.message).toContain("Watch alert")
    expect(fake.toasts[0]?.variant).toBe("warning")

    // A pure nudge, updatedAt change or same escalation is not a new reminder.
    current = withAlert(
      alert({ escalatedAt, updatedAt: NEW_ESCALATION }),
    )
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    dispose()
  })

  test("an alert that appears without an escalation waits for the durable fact", async () => {
    const escalatedAt = NEW_ESCALATION
    let current = payload()
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    current = withAlert(alert())
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = withAlert(alert({ escalatedAt }))
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)

    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    dispose()
  })

  test("ended tasks do not toast", async () => {
    const escalatedAt = NEW_ESCALATION
    let current = payload()
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    current = withAlert(alert({ escalatedAt }), {
      task: task({
        watchState: "ended",
        endedAt: Date.UTC(2026, 10, 16, 4, 40, 0),
      }),
    })
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])
    dispose()
  })

  test("paused and ended tasks do not toast, but their alert rows remain", async () => {
    const escalatedAt = NEW_ESCALATION
    let current = payload()
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    current = withAlert(alert({ escalatedAt }), {
      task: task({
        watchState: "paused",
        pause: { kind: "manual", reason: "paused by the user" },
      }),
    })
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("v")
    await panel.flush()
    const text = panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("Session watch — alerts")
    expect(text).toContain("…0001")
    dispose()
    panel.renderer.destroy()
  })
})

describe("alert acknowledgement", () => {
  test("a marks read through the RPC with the alert id only", async () => {
    let current = withAlert(alert({ alertID: "alert_0001" }))
    const fake = fakePort({
      read: async () => current,
      call: async (request) => {
        if (request.operation === "ack") {
          current = withAlert(
            alert({
              alertID: "alert_0001",
              state: "read",
              readAt: Date.UTC(2026, 10, 16, 4, 45, 0),
            }),
          )
          return current
        }
        return current
      },
    })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("v")
    await panel.flush()
    panel.mockInput.pressKey("a")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      operation: "ack",
      sessionID: SELF,
      alertID: "alert_0001",
    })
    expect(fake.calls[0]?.taskID).toBeUndefined()
    expect(fake.calls[0]?.expectedVersion).toBeUndefined()
    expect(fake.reads).toHaveLength(2)
    expect(fake.toasts).toContainEqual({
      message: "Alert marked read. This does not resume, retry or reset the watch.",
      variant: "success",
    })
    expect(
      panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " "),
    ).toContain("read")
    panel.mockInput.pressKey("v")
    await panel.flush()
    const taskText = panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(taskText).toContain("0 of 3 used")
    expect(taskText).toContain("Supervision active")
    dispose()
    panel.renderer.destroy()
  })

  test("a failed ack is reported and refreshed, never retried", async () => {
    const fake = fakePort({
      read: async () => withAlert(alert()),
      call: async () => ({
        ...withAlert(alert()),
        task: null,
        failure: {
          code: "E_WATCH_UNAVAILABLE",
          reason: "the alert store is locked",
          detail: null,
        },
      }),
    })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("v")
    await panel.flush()
    panel.mockInput.pressKey("a")
    await panel.flush()
    await tick(0)
    await panel.flush()

    expect(fake.calls).toHaveLength(1)
    expect(fake.reads).toHaveLength(2)
    expect(fake.toasts[0]?.variant).toBe("error")
    expect(fake.toasts[0]?.message).toContain("E_WATCH_UNAVAILABLE")
    const text = panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
    expect(text).toContain("…0001")
    dispose()
    panel.renderer.destroy()
  })

  test("a disabled acknowledge control performs no RPC", async () => {
    const fake = fakePort({
      read: async () =>
        withAlert(alert(), {
          controls: controls({
            acknowledge: control(false, "only the initiator may acknowledge"),
          }),
        }),
    })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    panel.mockInput.pressKey("v")
    await panel.flush()
    panel.mockInput.pressKey("a")
    await panel.flush()

    expect(fake.calls).toEqual([])
    dispose()
    panel.renderer.destroy()
  })
})

describe("a truncated first trusted snapshot", () => {
  test("does not toast an old escalation that enters the window later", async () => {
    let current = payload({
      alerts: alertsView([], {
        truncated: true,
        total: 20,
        unread: 20,
        active: 20,
      }),
    })
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = payload({
      alerts: alertsView([alert({ alertID: "alert_old", escalatedAt: OLD_ESCALATION })], {
        truncated: true,
        total: 20,
        unread: 20,
        active: 20,
      }),
    })
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = payload({
      alerts: alertsView(
        [
          alert({ alertID: "alert_old", escalatedAt: OLD_ESCALATION }),
          alert({
            alertID: "alert_new",
            summary: "A genuinely new escalation.",
            escalatedAt: NEW_ESCALATION,
          }),
        ],
        { truncated: true, total: 20, unread: 20, active: 20 },
      ),
    })
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.message).toContain("A genuinely new escalation.")
    dispose()
  })
})

describe("notification seeding survives an untrustworthy first snapshot", () => {
  test("a failed first payload does not consume the seed", async () => {
    let current: WatchPayload = payload({
      task: null,
      observation: null,
      activity: null,
      alerts: alertsView([]),
      failure: {
        code: "E_WATCH_UNAVAILABLE",
        reason: "the watch store is locked",
        detail: null,
      },
    })
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    expect(
      panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " "),
    ).toContain("Session watch is unavailable")

    current = withAlert(
      alert({ alertID: "alert_old", escalatedAt: OLD_ESCALATION }),
    )
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = payload({
      alerts: alertsView([
        alert({ alertID: "alert_old", escalatedAt: OLD_ESCALATION }),
        alert({
          alertID: "alert_new",
          summary: "A new escalation appeared.",
          escalatedAt: NEW_ESCALATION,
        }),
      ]),
    })
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.message).toContain("A new escalation appeared.")
    dispose()
    panel.renderer.destroy()
  })

  test("an unavailable alert list does not consume the seed", async () => {
    let current = payload({
      alerts: alertsView([], {
        available: false,
        reason: "the alert store is locked",
        unread: 0,
        total: 0,
        active: 0,
      }),
    })
    const fake = fakePort({ read: async () => current })
    const dispose = installWatch(fake.port, { now: () => OPENED_AT })
    commandOf(fake).run()
    await tick(0)

    const panel = await mountPanel(fake)
    expect(
      panel.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " "),
    ).toContain("unavailable")

    current = withAlert(
      alert({ alertID: "alert_old", escalatedAt: OLD_ESCALATION }),
    )
    fake.announce()
    await tick(0)
    expect(fake.toasts).toEqual([])

    current = withAlert(
      alert({ alertID: "alert_new", escalatedAt: NEW_ESCALATION }),
    )
    fake.announce()
    await tick(0)
    expect(fake.toasts).toHaveLength(1)
    dispose()
    panel.renderer.destroy()
  })
})
