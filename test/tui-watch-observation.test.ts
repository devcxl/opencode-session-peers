/**
 * Observation rows: coarse state, activity, waits and the not-judged progress
 * line. These tests use the shared contract fixtures, so a payload is first
 * validated by `readWatchPayload` in the contract test.
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import { watchContent, type WatchContent } from "../src/tui/watch-view.ts"
import { SELF, activity, observation, payload, task, wait } from "./tui-watch-fake.ts"

function state(overrides: Partial<WatchPayload> = {}): {
  readonly kind: "payload"
  readonly payload: WatchPayload
} {
  return { kind: "payload", payload: payload(overrides) }
}

function content(current: ReturnType<typeof state>, sessionID = SELF): WatchContent {
  return watchContent({ state: current, sessionID })
}

function valueOf(blocks: WatchContent, field: string): string | undefined {
  return blocks.rows.find((row) => row[0]?.text === field)?.[1]?.text
}

describe("the observation rows", () => {
  test("shows a sustained-idle candidate with its own threshold and no progress claim", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "idle-candidate",
          idleSince: Date.UTC(2026, 10, 16, 4, 31, 0),
          effective: { idleMs: 120_000, runningSilentMs: 600_000, waitOverdueMs: 1_800_000 },
        }),
        activity: activity({
          lastAt: Date.UTC(2026, 10, 16, 4, 32, 0),
          kind: "tool",
        }),
      }),
    )
    expect(valueOf(blocks, "Observation")).toBe("sustained idle — candidate · idle threshold 2m")
    expect(valueOf(blocks, "Activity")).toBe("2026-11-16 04:32:00Z · tool")
    expect(valueOf(blocks, "Progress")).toBe("not judged — activity is not goal progress")
    expect(valueOf(blocks, "Snapshot")).toBe(
      "observed 2026-11-16 04:34:00Z · baseline 2026-11-16 04:30:00Z · idle since 2026-11-16 04:31:00Z · trusted",
    )
    expect(valueOf(blocks, "Wait state")).toBe("none observed")
    expect(blocks.notes.join("\n")).toContain("Sustained idle is a candidate only")
  })

  test("shows running silence as a reminder, not as stalled or unfinished", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "running-silence",
          effective: { idleMs: 120_000, runningSilentMs: 600_000, waitOverdueMs: 1_800_000 },
        }),
      }),
    )
    expect(valueOf(blocks, "Observation")).toBe(
      "running, no new activity — reminder only · silence threshold 10m",
    )
    expect(blocks.notes.join("\n")).toContain("The task is still running")
    expect(blocks.notes.join("\n")).not.toContain("stalled")
  })

  test("does not turn missing evidence into idle or no-wait", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "unknown",
          reason: "the execution signal is missing",
          observedAt: null,
          baselineAt: null,
          idleSince: null,
          trusted: false,
        }),
        activity: null,
      }),
    )
    expect(valueOf(blocks, "Observation")).toBe("unknown — the execution signal is missing")
    expect(valueOf(blocks, "Activity")).toBe("unknown — no activity snapshot")
    expect(valueOf(blocks, "Snapshot")).toBe("not trusted — the execution signal is missing")
    expect(valueOf(blocks, "Wait state")).toBe("unknown — no reliable wait evidence")
    expect(blocks.notes.join("\n")).toContain("no idle or no-wait conclusion")
    expect(blocks.rows.map((row) => row[0]?.text)).not.toContain("idle")
  })

  test("shows a null observation sample as unknown, never as idle", () => {
    const blocks = content(state({ task: task(), observation: null, activity: null }))
    expect(valueOf(blocks, "Observation")).toBe("unknown — no observation sample")
    expect(valueOf(blocks, "Snapshot")).toBe("not observed")
    expect(valueOf(blocks, "Progress")).toBe("not judged — activity is not goal progress")
    expect(blocks.notes.join("\n")).toContain("not evidence of idle")
  })

  test("shows unavailable observation as a capability gap, not as a wait", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "unavailable",
          reason: "the local execution surface is unavailable",
          trusted: false,
        }),
      }),
    )
    expect(valueOf(blocks, "Observation")).toBe(
      "unavailable — the local execution surface is unavailable",
    )
    expect(blocks.notes.join("\n")).toContain("Observation is unavailable here")
  })

  test("shows waits, deadlines and partial/truncated evidence without clearing them", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "normal-waiting",
          waitsPartial: true,
          waitsTruncated: true,
          waits: [
            wait({
              waitID: "wait_1",
              source: "permission",
              object: "the reviewer",
              reason: "approval is required",
              reference: "GH-60",
              deadline: Date.UTC(2026, 10, 16, 4, 40, 0),
              status: "overdue",
            }),
            wait({
              waitID: "wait_2",
              source: "reported",
              object: "CI",
              reason: "waiting for a build",
              reference: null,
              deadline: null,
              status: "cleared",
              clearEvidence: "the matching reply arrived",
            }),
            wait({
              waitID: "wait_3",
              source: "permission",
              object: "the deployer",
              reason: "deployment approval",
              reference: null,
              deadline: null,
              status: "denied",
              denyEvidence: "the request was refused",
            }),
          ],
        }),
      }),
    )
    expect(valueOf(blocks, "Wait state")).toBe("1 overdue · 1 cleared · 1 denied · partial · truncated")
    expect(valueOf(blocks, "Wait 1")).toBe(
      "permission: the reviewer · approval is required · due 2026-11-16 04:40:00Z · overdue · ref GH-60",
    )
    expect(valueOf(blocks, "Wait 2")).toBe(
      "reported: CI · waiting for a build · no deadline · cleared — the matching reply arrived",
    )
    expect(valueOf(blocks, "Wait 3")).toBe(
      "permission: the deployer · deployment approval · no deadline · denied — the request was refused",
    )
    const notes = blocks.notes.join("\n")
    expect(notes).toContain("A wait is overdue")
    expect(notes).toContain("Wait evidence is partial")
    expect(notes).toContain("The wait list is truncated")
  })

  test("uses the effective wait threshold supplied by the server", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({
          state: "normal-waiting",
          effective: { idleMs: 90_000, runningSilentMs: 300_000, waitOverdueMs: 900_000 },
        }),
      }),
    )
    expect(valueOf(blocks, "Observation")).toBe("normal waiting · overdue threshold 15m")
  })
})

describe("blocked and partial observation", () => {
  test("shows blocked as blocked, not as a normal wait", () => {
    const blocks = content(
      state({
        task: task({ taskState: "blocked" }),
        observation: observation({
          state: "blocked",
          reason: "an approval was rejected",
          waits: [
            wait({
              status: "denied",
              denyEvidence: "the approval was refused",
              deadline: null,
            }),
          ],
        }),
      }),
    )
    expect(valueOf(blocks, "Task state")).toBe("blocked")
    expect(valueOf(blocks, "Observation")).toBe("blocked")
    expect(valueOf(blocks, "Wait 1")).toContain("denied — the approval was refused")
    expect(blocks.notes.join("\n")).toContain("The task is blocked")
    expect(blocks.notes.join("\n")).not.toContain("normal wait")
  })

  test("partial wait evidence with no rows never claims that nothing is waiting", () => {
    const blocks = content(
      state({
        task: task(),
        observation: observation({ state: "unknown", waitsPartial: true, waits: [] }),
      }),
    )
    expect(valueOf(blocks, "Wait state")).toBe("incomplete — absence is not proof")
    expect(blocks.notes.join("\n")).toContain("Wait evidence is partial")
  })
})
