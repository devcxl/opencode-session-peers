/**
 * The correction pane's facts. It is inspection only: a grant is not a send,
 * a receipt is not recovery, and a stop reason is not a failure judgement.
 */

import { describe, expect, test } from "bun:test"

import type { WatchPayload } from "../src/rpc.ts"
import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import { GRANT_TERMS } from "../src/tui/watch-correction.ts"
import { watchContent, type WatchContent } from "../src/tui/watch-view.ts"
import {
  SELF,
  attempt,
  control,
  correction,
  gate,
  payload,
  task,
} from "./tui-watch-fake.ts"

function state(overrides: Partial<WatchPayload> = {}): WatchPayload {
  return payload(overrides)
}

function content(payload: WatchPayload): WatchContent {
  return watchContent({ state: { kind: "payload", payload }, sessionID: SELF, pane: "correction" })
}

function valueOf(blocks: WatchContent, field: string): string | undefined {
  return blocks.rows.find((row) => row[0]?.text === field)?.[1]?.text
}

describe("correction grant terms re-export", () => {
  test("re-exports canonical WATCH_CORRECTION_TERMS as GRANT_TERMS without duplicating string", () => {
    expect(GRANT_TERMS).toBe(WATCH_CORRECTION_TERMS)
  })
})

describe("the correction pane", () => {
  test("separates authorization, actual capability, attempts, receipt, recovery and completion", () => {
    const first = attempt({
      attemptID: "attempt_0001",
      ordinal: 1,
      phase: "receipted",
      receipt: {
        at: Date.UTC(2026, 10, 16, 4, 32, 0),
        continuePermitIssuedAt: Date.UTC(2026, 10, 16, 4, 33, 0),
        refusalReason: null,
      },
      stopReason: "receipted-awaiting-recovery",
    })
    const second = attempt({
      attemptID: "attempt_0002",
      ordinal: 2,
      phase: "recovered",
      recovery: {
        progressReportID: "report_progress",
        resultReference: "src/auth.test.ts",
        at: Date.UTC(2026, 10, 16, 4, 40, 0),
      },
    })
    const blocks = content(
      state({
        task: task({
          mode: "limited-correction",
          correction: correction({
            authorization: {
              mode: "limited-correction",
              state: "granted",
              deployment: "single-host-same-location",
              version: 2,
              reviewSummary: WATCH_CORRECTION_TERMS,
              grantedAt: Date.UTC(2026, 10, 16, 4, 20, 0),
            },
            actual: "unavailable",
            actualReason: "the automatic executor is not enabled in this build",
            attempts: { used: 2, limit: 3 },
            phase: "recovered",
            last: second,
            history: [first, second],
            stop: {
              reason: "executor-unavailable",
              missingEvidence: "the automatic executor runtime gate",
            },
            gates: [
              gate({
                gate: "executor",
                ok: false,
                reason: "automatic sending is closed",
                observed: "closed",
                required: "an enabled executor",
              }),
            ],
            businessCompleted: true,
            controls: {
              grant: control(false, "a grant is already recorded"),
              downgrade: control(true),
            },
          }),
        }),
      }),
    )

    expect(blocks.pane).toBe("correction")
    expect(blocks.title).toBe("Session watch — correction")
    expect(valueOf(blocks, "Authorization")).toContain("limited correction")
    expect(valueOf(blocks, "Authorization")).toContain("granted")
    expect(valueOf(blocks, "Deployment")).toBe(
      "single service · same host/location (declaration, not proof)",
    )
    expect(valueOf(blocks, "Actual capability")).toBe(
      "unavailable — the automatic executor is not enabled in this build",
    )
    expect(valueOf(blocks, "Policy")).toBe("up to 3 automatic attempts · observe 5m · problem 20m")
    expect(valueOf(blocks, "Attempts")).toBe("2 of 3 used · 1 remaining")
    expect(valueOf(blocks, "Phase")).toBe("recovered")
    expect(valueOf(blocks, "Business completed")).toBe("yes")
    expect(valueOf(blocks, "Stop")).toContain("executor-unavailable")
    expect(valueOf(blocks, "Stop")).toContain("the automatic executor runtime gate")
    expect(valueOf(blocks, "Gates")).toBe("0 of 1 ok")
    expect(valueOf(blocks, "Gate executor")).toContain("automatic sending is closed")
    expect(valueOf(blocks, "Attempt 1")).toContain("receipted")
    expect(valueOf(blocks, "Attempt 1")).toContain("permit")
    expect(valueOf(blocks, "Attempt 2")).toContain("recovered")
    expect(valueOf(blocks, "Attempt 2")).toContain("report_progress → src/auth.test.ts")
    expect(blocks.notes.join("\n")).toContain("Grant active; actual send remains unavailable")
    expect(blocks.notes.join("\n")).toContain("A receipt or continue permit is not recovery")
    expect(blocks.notes.join("\n")).toContain("Business completion is independent")
    expect(blocks.notes.join("\n")).toContain("Receipts are submitted only by the executing session")
    expect(blocks.notes.join("\n")).toContain("No force resume, takeover, unknown clearing")
    expect(blocks.notes.join("\n")).toContain("Correction grant unavailable: a grant is already recorded")
    expect(blocks.notes.join("\n")).toContain("d: downgrade to alert-only")
  })

  test("grant availability comes from nested controls, not global detection or busy/wait facts", () => {
    const blocks = content(
      state({
        task: task({
          correction: correction({
            controls: { grant: control(true), downgrade: control(false, "no grant") },
          }),
        }),
        observation: {
          state: "normal-waiting",
          reason: null,
          observedAt: 1,
          baselineAt: 1,
          idleSince: null,
          trusted: true,
          waits: [],
          waitsPartial: true,
          waitsTruncated: false,
          effective: { idleMs: 1, runningSilentMs: 1, waitOverdueMs: 1 },
        },
      }),
    )
    expect(blocks.notes.join("\n")).toContain("g: review correction grant")
    expect(blocks.notes.join("\n")).not.toContain("Correction grant unavailable")
  })

  test("uses server disabled reasons and does not invent a grant when the grant is unavailable", () => {
    const blocks = content(
      state({
        task: task({
          correction: correction({
            controls: {
              grant: control(false, "the current activation does not own this task"),
              downgrade: control(false, "no grant is active"),
            },
          }),
        }),
      }),
    )
    expect(blocks.notes.join("\n")).toContain(
      "Correction grant unavailable: the current activation does not own this task",
    )
    expect(blocks.notes.join("\n")).toContain("Downgrade unavailable: no grant is active")
    expect(blocks.notes.join("\n")).not.toContain("g: review correction grant")
    expect(blocks.notes.join("\n")).not.toContain("d: downgrade to alert-only")
  })

  test("does not duplicate an attempt present in history and last", () => {
    const one = attempt({ attemptID: "attempt_one", ordinal: 1 })
    const blocks = content(
      state({
        task: task({
          correction: correction({
            attempts: { used: 1, limit: 3 },
            last: one,
            history: [one],
          }),
        }),
      }),
    )
    expect(blocks.rows.filter((row) => row[0]?.text.startsWith("Attempt "))).toHaveLength(1)
  })

  test("shows a pending grant as pending, not as a sent correction", () => {
    const blocks = content(
      state({
        task: task({
          correction: correction({
            authorization: {
              mode: "limited-correction",
              state: "pending-confirmation",
              deployment: "single-host-same-location",
              version: 2,
              reviewSummary: "Pending terms.",
              grantedAt: null,
            },
          }),
        }),
      }),
    )
    expect(valueOf(blocks, "Authorization")).toContain("pending confirmation")
    expect(blocks.notes.join("\n")).toContain("prepared but not confirmed")
  })
})

describe("correction gates", () => {
  test("pages failed gates explicitly instead of silently clipping them", () => {
    const gates = Array.from({ length: 5 }, (_, index) =>
      gate({
        gate: index === 0 ? "executor" : "observation",
        ok: false,
        reason: `gate ${index + 1} failed`,
        observed: `observed ${index + 1}`,
        required: `required ${index + 1}`,
      }),
    )
    const blocks = watchContent({
      state: {
        kind: "payload",
        payload: state({
          task: task({
            correction: correction({
              gates,
              controls: { grant: control(), downgrade: control(false, "no grant") },
            }),
          }),
        }),
      },
      sessionID: SELF,
      pane: "correction",
      gatePage: 0,
      gatePageSize: 2,
    })
    expect(blocks.rows.filter((row) => row[0]?.text.startsWith("Gate "))).toHaveLength(2)
    expect(blocks.notes.join("\n")).toContain("showing failed gates 1–2 of 5")

    const next = watchContent({
      state: {
        kind: "payload",
        payload: state({
          task: task({
            correction: correction({
              gates,
              controls: { grant: control(), downgrade: control(false, "no grant") },
            }),
          }),
        }),
      },
      sessionID: SELF,
      pane: "correction",
      gatePage: 1,
      gatePageSize: 2,
    })
    expect(next.rows.filter((row) => row[0]?.text.startsWith("Gate "))).toHaveLength(2)
    expect(next.notes.join("\n")).toContain("showing failed gates 3–4 of 5")
  })
})

describe("bounded attempt display", () => {
  test("shows the third recovered attempt as a success, not as a quota failure", () => {
    const third = attempt({
      attemptID: "attempt_0003",
      ordinal: 3,
      phase: "recovered",
      recovery: {
        progressReportID: "report_third",
        resultReference: "src/third.test.ts",
        at: Date.UTC(2026, 10, 16, 5, 0, 0),
      },
    })
    const blocks = content(
      state({
        task: task({
          mode: "limited-correction",
          correction: correction({
            executionPolicy: "bounded-three-attempt",
            attempts: { used: 3, limit: 3 },
            policy: {
              observationMs: 300_000,
              windowMs: 1_200_000,
              windowStartedAt: Date.UTC(2026, 10, 16, 4, 50, 0),
              windowEndsAt: Date.UTC(2026, 10, 16, 5, 10, 0),
              nextAttemptAt: null,
            },
            phase: "recovered",
            last: third,
            history: [third],
            stop: {
              reason: "attempt-limit",
              missingEvidence: "the three permanent attempts are spent",
            },
          }),
        }),
      }),
    )
    expect(valueOf(blocks, "Policy")).toContain("up to 3 automatic attempts")
    expect(valueOf(blocks, "Policy")).toContain("window ends")
    expect(valueOf(blocks, "Attempts")).toBe("3 of 3 used · 0 remaining")
    expect(valueOf(blocks, "Attempt 3")).toContain("recovered")
    expect(valueOf(blocks, "Attempt 3")).toContain("report_third → src/third.test.ts")
    expect(blocks.notes.join("\n")).toContain("The last attempt recovered")
    expect(blocks.notes.join("\n")).toContain("only prevents a fourth automatic attempt")
  })

  test("separates normal-wait and completed closures from recovery", () => {
    const waiting = attempt({
      attemptID: "attempt_0001",
      ordinal: 1,
      phase: "receipted",
      receipt: {
        at: Date.UTC(2026, 10, 16, 4, 32, 0),
        continuePermitIssuedAt: Date.UTC(2026, 10, 16, 4, 33, 0),
        refusalReason: null,
      },
      stopReason: "normal-wait",
    })
    const completed = attempt({
      attemptID: "attempt_0002",
      ordinal: 2,
      phase: "receipted",
      receipt: {
        at: Date.UTC(2026, 10, 16, 4, 40, 0),
        continuePermitIssuedAt: Date.UTC(2026, 10, 16, 4, 41, 0),
        refusalReason: null,
      },
      stopReason: "task-completed",
    })
    const blocks = content(
      state({
        task: task({
          mode: "limited-correction",
          correction: correction({
            attempts: { used: 2, limit: 3 },
            phase: "receipted",
            last: completed,
            history: [waiting, completed],
          }),
        }),
      }),
    )
    expect(valueOf(blocks, "Attempt 1")).toContain("closed · normal wait")
    expect(valueOf(blocks, "Attempt 2")).toContain("closed · task completed")
    expect(valueOf(blocks, "Attempt 1")).not.toContain("recovered")
    expect(valueOf(blocks, "Attempt 2")).not.toContain("recovered")
    expect(blocks.notes.join("\n")).toContain("A normal wait closed that round; it is not recovery")
    expect(blocks.notes.join("\n")).toContain("Task completion closed that round")
  })

  test("marks an issued permit as recovery unconfirmed until new progress arrives", () => {
    const pending = attempt({
      attemptID: "attempt_0001",
      ordinal: 1,
      phase: "receipted",
      receipt: {
        at: Date.UTC(2026, 10, 16, 4, 32, 0),
        continuePermitIssuedAt: Date.UTC(2026, 10, 16, 4, 33, 0),
        refusalReason: null,
      },
      stopReason: "receipted-awaiting-recovery",
    })
    const blocks = content(
      state({
        task: task({
          mode: "limited-correction",
          correction: correction({
            attempts: { used: 1, limit: 3 },
            phase: "receipted",
            pending,
            last: pending,
            history: [pending],
            stop: {
              reason: "receipted-awaiting-recovery",
              missingEvidence: "new progress and a new result reference have not arrived",
            },
          }),
        }),
      }),
    )
    expect(valueOf(blocks, "Attempt 1")).toContain("recovery unconfirmed")
    expect(valueOf(blocks, "Attempt 1")).not.toContain("closed · normal wait")
    expect(blocks.notes.join("\n")).toContain("recovery is unconfirmed until new progress")
  })
})
