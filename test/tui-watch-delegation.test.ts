/**
 * The delegation pane's pure/headless view.
 *
 * The shared watch skeleton is untouched. This test asserts the reader-visible
 * rows: an authorized child shows its real task state and grant scope, while an
 * unauthorized child shows only identifiers, a reason and no goal/report text.
 */

import { describe, expect, test } from "bun:test"

import { watchDelegationContent } from "../src/tui/watch-delegation.ts"
import type { WatchDelegationViewPayload } from "../src/watch/delegation-contract.ts"

const SELF = "ses_parent"

function task(goal = "Deliver the private child goal") {
  return {
    taskID: "task-child",
    initiatorSessionID: SELF,
    targetSessionID: "ses_child",
    goal,
    mode: "limited-correction",
    watchState: "active",
    taskState: "in-progress",
    version: 3,
    generation: 1,
    ownership: "this-instance",
    participation: "seen",
    attempts: { used: 0, limit: 3 },
    correction: {
      actual: "unavailable",
      actualReason: "the runtime gate is closed",
      authorization: { mode: "limited-correction", state: "granted" },
    },
    pause: null,
    lastReport: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    endedAt: null,
  }
}

function payload(overrides: Partial<WatchDelegationViewPayload> = {}): WatchDelegationViewPayload {
  return {
    ok: true,
    parentTaskID: "task-parent",
    parentSessionID: SELF,
    grants: [
      {
        grantID: "delegation-1",
        parentTaskID: "task-parent",
        parentSessionID: SELF,
        mode: "limited-correction",
        state: "granted",
        version: 1,
        generation: 1,
        targetSessionID: "ses_child",
        scopeDirectory: "/tmp/opencode/project",
        scopePeerScope: "project-a",
        reviewSummary: "reviewed",
        deployment: "single-host-same-location",
        grantedAt: 1_500,
        revokedAt: null,
      },
    ],
    children: [
      {
        taskID: "task-child",
        parentTaskID: "task-parent",
        parentSessionID: SELF,
        targetSessionID: "ses_child",
        authorized: true,
        authorization: {
          allowed: true,
          reason: null,
          grantID: "delegation-1",
          grantVersion: 1,
          mode: "limited-correction",
          scopeDirectory: "/tmp/opencode/project",
          scopePeerScope: "project-a",
          scopeSource: "recorded",
          checkedAt: 2_000,
        },
        task: task() as never,
        alerts: null,
      },
    ],
    failure: null,
    ...overrides,
  }
}

function text(content: ReturnType<typeof watchDelegationContent>): string {
  return JSON.stringify(content)
}

describe("delegation pane", () => {
  test("an authorized child shows its goal, real states and grant scope", () => {
    const content = watchDelegationContent({ state: { kind: "payload", payload: payload() }, sessionID: SELF })
    const rendered = text(content)
    expect(rendered).toContain("Deliver the private child goal")
    expect(rendered).toContain("in-progress")
    expect(rendered).toContain("supervision active")
    expect(rendered).toContain("limited-correction grant v1")
    expect(rendered).toContain("scope project-a")
    expect(rendered).toContain("correction unavailable")
    expect(rendered).not.toContain("prompt sent")
  })

  test("an unauthorized child shows no goal, report or alert content", () => {
    const content = watchDelegationContent({
      state: {
        kind: "payload",
        payload: payload({
          children: [
            {
              taskID: "task-child",
              parentTaskID: "task-parent",
              parentSessionID: SELF,
              targetSessionID: "ses_child",
              authorized: false,
              authorization: {
                allowed: false,
                reason: "the source delegation grant is revoked",
                grantID: "delegation-1",
                grantVersion: 2,
                mode: "limited-correction",
                scopeDirectory: "/tmp/opencode/project",
                scopePeerScope: "project-a",
                scopeSource: "unknown",
                checkedAt: 2_000,
              },
              task: null,
              alerts: null,
            },
          ],
        }),
      },
      sessionID: SELF,
    })
    const rendered = text(content)
    expect(rendered).not.toContain("Deliver the private child goal")
    expect(rendered).toContain("not readable")
    expect(rendered).toContain("source delegation grant is revoked")
  })

  test("grants are listed with revoked state and the pane never claims it prompted", () => {
    const content = watchDelegationContent({
      state: {
        kind: "payload",
        payload: payload({
          grants: [
            {
              ...payload().grants[0]!,
              state: "revoked",
              version: 2,
              revokedAt: 3_000,
            },
          ],
        }),
      },
      sessionID: SELF,
    })
    const notes = content.notes.join(" ")
    expect(notes).toContain("revoked")
    expect(notes).toContain("read")
    expect(notes).toContain("does not prompt")
    expect(notes).not.toContain("correction sent")
  })

  test("a failed view is an error note, not an empty successful child list", () => {
    const content = watchDelegationContent({
      state: {
        kind: "payload",
        payload: { ...payload(), ok: false, failure: { code: "E_WATCH_STALE", reason: "scope changed" } },
      },
      sessionID: SELF,
    })
    expect(content.noteTone).toBe("error")
    expect(content.notes.join(" ")).toContain("scope changed")
  })
})
