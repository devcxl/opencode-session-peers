/**
 * What the watch panel says, cell by cell.
 *
 * The panel only draws these cells and notes, so everything a person would
 * read is asserted here. The promises are the ticket's: task state, supervision,
 * authorization, actual capability, owner generation and protocol participation
 * stay separate; an unreported session is not called ready; completion is not
 * confused with ending supervision; and a ledger failure never reads as "no
 * task".
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import { WATCH_COLUMNS, watchContent, type WatchContent, type WatchState } from "../src/tui/watch-view.ts"

const SELF = "ses_self0000"

type Task = NonNullable<WatchPayload["task"]>
type Control = WatchPayload["controls"]["pause"]

function control(enabled = true, reason: string | null = null): Control {
  return { enabled, reason }
}

function capability(
  overrides: Partial<WatchPayload["capability"]> = {},
): WatchPayload["capability"] {
  return {
    mode: "alert",
    monitoring: "participant-reports-only",
    automaticDetection: "unavailable",
    automaticDetectionReason: "No supported execution signal is available in this build.",
    correction: "unavailable",
    correctionReason:
      "Finite correction is not implemented in this build; this watch can only record reports.",
    delegation: "unavailable",
    delegationReason: "Child-task delegation is not open in this build; enroll the calling session itself.",
    transfer: "unavailable",
    transferReason: "Watch ownership transfer is not implemented in this build.",
    recovery: "unavailable",
    recoveryReason: "Resume and recovery confirmation are not implemented in this build.",
    safetyPause: "unavailable",
    safetyPauseReason:
      "Watch safety pause is not implemented in this build; only a manual pause can occur.",
    ...overrides,
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
    attempts: { used: 0, limit: 3 },
    pause: null,
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
    task: null,
    capability: capability(),
    controls: controls(),
    failure: null,
    ...overrides,
  }
}

function state(overrides: Partial<WatchPayload> = {}): WatchState {
  return { kind: "payload", payload: payload(overrides) }
}

function content(current: WatchState, sessionID = SELF): WatchContent {
  return watchContent({ state: current, sessionID })
}

function valueOf(blocks: WatchContent, field: string): string | undefined {
  return blocks.rows.find((row) => row[0]?.text === field)?.[1]?.text
}

describe("the watch header", () => {
  test("names the view and the session it is about", () => {
    const blocks = content(state({ task: task() }))
    expect(blocks.title).toBe("Session watch")
    expect(blocks.contextLines).toEqual([
      "target: this session (…0000)",
      "task: task_0001 · version 3",
    ])
    expect(blocks.columns).toEqual(WATCH_COLUMNS)
  })

  test("says it is reading before the first answer", () => {
    const blocks = content({ kind: "loading" })
    expect(blocks.title).toBe("Session watch")
    expect(blocks.contextLines).toEqual(["reading the watch…"])
    expect(blocks.rows).toEqual([])
  })
})

describe("a watched task", () => {
  test("keeps task, supervision, authorization, capability, owner and protocol separate", () => {
    const blocks = content(state({ task: task() }))
    expect(valueOf(blocks, "Task state")).toBe("in progress")
    expect(valueOf(blocks, "Supervision")).toBe("active")
    expect(valueOf(blocks, "Authorization")).toBe("alert-only (the only mode this build offers)")
    expect(valueOf(blocks, "Actual capability")).toBe(
      "participant reports only; no automatic stall detection",
    )
    expect(valueOf(blocks, "Owner")).toBe("this plugin instance · generation 1")
    expect(valueOf(blocks, "Attempts")).toBe("0 of 3 used")
    expect(valueOf(blocks, "Protocol")).toBe("seen — a report has been recorded")
    expect(blocks.rows.map((row) => row[0]?.text)).not.toContain("idle")
  })

  test("shows a progress result without turning it into completion", () => {
    const blocks = content(state({ task: task() }))
    expect(valueOf(blocks, "Last report")).toBe(
      "progress · 2026-11-16 04:32:00Z · tests pass · src/auth.test.ts",
    )
    expect(valueOf(blocks, "Result")).toBe("not reported")
    expect(blocks.notes.join("\n")).not.toContain("business success")
  })

  test("shows a wait as a wait, with what it waits for", () => {
    const blocks = content(
      state({
        task: task({
          taskState: "waiting",
          lastReport: {
            reportID: "report_wait",
            kind: "waiting",
            evidence: {
              waitKind: "human",
              waitFor: "the reviewer",
              reason: "approval is required",
              reference: "GH-59",
            },
            at: Date.UTC(2026, 10, 16, 4, 35, 0),
            version: 3,
          },
        }),
      }),
    )
    expect(valueOf(blocks, "Task state")).toBe("waiting")
    expect(valueOf(blocks, "Last report")).toBe(
      "waiting · 2026-11-16 04:35:00Z · for human: the reviewer · approval is required · GH-59",
    )
    expect(blocks.rows.map((row) => row[1]?.text).join(" ")).not.toContain("blocked")
  })

  test("shows a block with its reason", () => {
    const blocks = content(
      state({
        task: task({
          taskState: "blocked",
          lastReport: {
            reportID: "report_blocked",
            kind: "blocked",
            evidence: { reason: "the dependency is unavailable" },
            at: Date.UTC(2026, 10, 16, 4, 36, 0),
            version: 3,
          },
        }),
      }),
    )
    expect(valueOf(blocks, "Task state")).toBe("blocked")
    expect(valueOf(blocks, "Last report")).toBe(
      "blocked · 2026-11-16 04:36:00Z · the dependency is unavailable",
    )
  })

  test("completion keeps the result and ends supervision without the unfinished warning", () => {
    const completedAt = Date.UTC(2026, 10, 16, 5, 10, 0)
    const blocks = content(
      state({
        task: task({
          taskState: "completed",
          watchState: "ended",
          completedAt,
          endedAt: completedAt,
          lastReport: {
            reportID: "report_done",
            kind: "completed",
            evidence: { summary: "migration finished", reference: "PR 65" },
            at: completedAt,
            version: 4,
          },
        }),
        controls: controls({
          pause: control(false, "the watch has ended"),
          end: control(false, "the watch has ended"),
        }),
      }),
    )
    expect(valueOf(blocks, "Task state")).toBe("completed")
    expect(valueOf(blocks, "Supervision")).toBe("ended (task completed)")
    expect(valueOf(blocks, "Result")).toBe(
      "migration finished · PR 65 · 2026-11-16 05:10:00Z",
    )
    const notes = blocks.notes.join("\n")
    expect(notes).toContain("Completion is recorded; supervision ended.")
    expect(notes).not.toContain("not a business success")
    expect(notes).not.toContain("not reported complete")
  })

  test("warns that an unfinished watch ended without a business success", () => {
    const blocks = content(
      state({
        task: task({ watchState: "ended", endedAt: Date.UTC(2026, 10, 16, 5, 10, 0) }),
        controls: controls({
          pause: control(false, "the watch has ended"),
          end: control(false, "the watch has ended"),
        }),
      }),
    )
    expect(valueOf(blocks, "Task state")).toBe("in progress")
    expect(valueOf(blocks, "Supervision")).toBe("ended")
    expect(valueOf(blocks, "Result")).toBe("not reported")
    expect(blocks.notes.join("\n")).toContain(
      "Supervision ended; this is not a business success. The business task was not reported complete.",
    )
  })

  test("does not call a task ready before its session reports", () => {
    const blocks = content(
      state({
        task: task({ participation: "not-seen", lastReport: null, taskState: "not-started" }),
      }),
    )
    expect(valueOf(blocks, "Protocol")).toBe(
      "not seen — no report yet; enrollment is not readiness",
    )
    expect(blocks.notes.join("\n")).toContain(
      "The executing session has not reported yet; enrollment is not readiness.",
    )
  })

  test("names another activation as the owner instead of claiming it", () => {
    const blocks = content(
      state({
        task: task({ ownership: "another-activation", generation: 2 }),
      }),
    )
    expect(valueOf(blocks, "Owner")).toBe("another activation · generation 2")
    expect(blocks.notes.join("\n")).toContain(
      "This activation is observation-only for automatic supervision; no takeover. It does not infer that the previous owner stopped.",
    )
  })

  test("shows pause without pretending the business session paused", () => {
    const blocks = content(
      state({
        task: task({
          watchState: "paused",
          pause: { kind: "manual", reason: "paused by the user" },
        }),
        controls: controls({ pause: control(false, "the watch is already paused") }),
      }),
    )
    expect(valueOf(blocks, "Supervision")).toBe("paused (manual)")
    const notes = blocks.notes.join("\n")
    expect(notes).toContain(
      "Supervision is paused (manual): paused by the user. The business session is not paused; pausing stops new reminders.",
    )
    expect(notes).toContain("Resume is unavailable:")
    expect(notes).not.toContain("not a business success")
  })

  test("advertises only the controls that are enabled", () => {
    const active = content(state({ task: task() }))
    expect(active.notes.join("\n")).toContain("p: pause watch · x: end watch · esc: close")

    const paused = content(
      state({
        task: task({
          watchState: "paused",
          pause: { kind: "manual", reason: "paused by the user" },
        }),
        controls: controls({ pause: control(false, "the watch is already paused") }),
      }),
    )
    expect(paused.notes.join("\n")).toContain(
      "x: end watch · resume unavailable in this build · esc: close",
    )
    expect(paused.notes.join("\n")).not.toContain("p: pause watch")

    const ended = content(
      state({
        task: task({ watchState: "ended", endedAt: Date.UTC(2026, 10, 16, 5, 0, 0) }),
        controls: controls({
          pause: control(false, "the watch has ended"),
          end: control(false, "the watch has ended"),
        }),
      }),
    )
    expect(ended.notes.join("\n")).toContain("this watch has ended · esc: close")
  })

  test("shows a safety pause with its reason, separate from a manual pause", () => {
    const blocks = content(
      state({
        task: task({
          watchState: "paused",
          pause: { kind: "safety", reason: "the previous plugin activation stopped" },
        }),
      }),
    )
    expect(valueOf(blocks, "Supervision")).toBe("paused (safety pause)")
    expect(blocks.notes.join("\n")).toContain(
      "Supervision is paused (safety pause): the previous plugin activation stopped. The business session is not paused; pausing stops new reminders.",
    )
  })

  test("shows the attempt count the answer carries, not a local constant", () => {
    const blocks = content(
      state({ task: task({ attempts: { used: 2, limit: 3 } }) }),
    )
    expect(valueOf(blocks, "Attempts")).toBe("2 of 3 used")
  })

  test("uses the capability reasons rather than one generic unavailable line", () => {
    const notes = content(state({ task: task() })).notes.join("\n")
    expect(notes).toContain(
      "Automatic detection: unavailable — No supported execution signal is available in this build.",
    )
    expect(notes).toContain(
      "Correction: unavailable — Finite correction is not implemented in this build; this watch can only record reports.",
    )
    expect(notes).toContain(
      "Child-task enrollment: unavailable — Child-task delegation is not open in this build; enroll the calling session itself.",
    )
    expect(notes).toContain(
      "Ownership transfer and recovery: unavailable — Watch ownership transfer is not implemented in this build. / Resume and recovery confirmation are not implemented in this build.",
    )
    expect(notes).toContain(
      "Safety pause: unavailable — Watch safety pause is not implemented in this build; only a manual pause can occur.",
    )
  })

  test("shortens a long goal and says so", () => {
    const long = "a".repeat(300)
    const blocks = content(state({ task: task({ goal: long }) }))
    const shown = valueOf(blocks, "Goal") ?? ""
    expect(shown.length).toBeLessThan(long.length)
    expect(shown).toContain("shortened in this panel; the enrolled goal is unchanged")
  })
})

describe("no task", () => {
  test("names the enrollment command instead of claiming readiness", () => {
    const blocks = content(state())
    expect(blocks.title).toBe("Session watch")
    expect(valueOf(blocks, "Task state")).toBe("none enrolled")
    expect(valueOf(blocks, "Attempts")).toBe("—")
    const notes = blocks.notes.join("\n")
    expect(notes).toContain("No watched task is enrolled for this session.")
    expect(notes).toContain(
      "enroll: /peers-watch enroll <goal> · esc: close",
    )
    expect(notes).toContain("The target is this session; the mode is alert-only.")
  })
})

describe("unavailable states", () => {
  test("renders a disabled plugin as off, not as an empty task", () => {
    const blocks = content(state({ enabled: false }))
    expect(blocks.title).toBe("Session watch")
    expect(blocks.rows).toEqual([])
    expect(blocks.notes).toContain("off here: enabled is false, so no watch is shown")
  })

  test("a failed ledger never reads as no task", () => {
    const blocks = content(state({ ledger: { available: false, reason: "the ledger is locked" } }))
    expect(blocks.title).toBe("Session watch is unavailable")
    expect(blocks.notes.join("\n")).toContain(
      "Watch ledger unavailable: the ledger is locked. No watched task was created or changed.",
    )
    expect(blocks.notes.join("\n")).not.toContain("No watched task is enrolled")
    expect(blocks.noteTone).toBe("error")
  })

  test("a domain failure carries its code and reason", () => {
    const blocks = content(
      state({
        failure: {
          code: "E_WATCH_STALE",
          reason: "the watch state changed since it was read",
          detail: "version 4",
        },
      }),
    )
    expect(blocks.title).toBe("Session watch is unavailable")
    expect(blocks.notes.join("\n")).toContain(
      "E_WATCH_STALE: the watch state changed since it was read",
    )
    expect(blocks.notes.join("\n")).toContain("detail: version 4")
    expect(blocks.noteTone).toBe("error")
  })

  test("a failed call and an unreadable answer are different states", () => {
    const failed = content({ kind: "failed", reason: "RPC is unavailable: session-peers.v1" })
    expect(failed.title).toBe("Session watch is unavailable")
    expect(failed.notes).toEqual(["RPC is unavailable: session-peers.v1"])
    expect(failed.noteTone).toBe("error")

    const unreadable = content({ kind: "unreadable" })
    expect(unreadable.notes).toEqual(["the answer was not a watch state this view understands"])
    expect(unreadable.noteTone).toBe("error")
  })
})
