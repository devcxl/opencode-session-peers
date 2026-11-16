/**
 * Targeted tests for the WatchDelegationDialog component.
 *
 * Verifies review rendering of canonical terms, short terminal (40h)
 * visibility, keyboard interaction, and nonce redaction (challenge never
 * reaches the screen).
 */

import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

import { WATCH_DELEGATION_TERMS } from "../src/watch/delegation.ts"
import {
  WatchDelegationDialog,
  type WatchDelegationDialogProps,
} from "../src/tui/watch-delegation-dialog.tsx"
import type { DelegationPaneState } from "../src/tui/watch-delegation.ts"
import {
  SELF,
  delegationViewPayload,
  palette,
} from "./tui-watch-fake.ts"

function childTask(goal = "Child private work") {
  return {
    taskID: "task_child_01",
    initiatorSessionID: SELF,
    targetSessionID: "ses_child_01",
    goal,
    mode: "alert" as const,
    watchState: "active" as const,
    taskState: "in-progress" as const,
    version: 2,
    generation: 1,
    ownership: "this-instance" as const,
    participation: "seen" as const,
    attempts: { used: 0, limit: 3 },
    correction: {
      actual: "unavailable" as const,
      actualReason: "alert only",
      authorization: { mode: "alert" as const, state: "not-granted" as const },
    },
    pause: null,
    lastReport: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    endedAt: null,
  }
}

async function renderDelegationDialog(
  initialState: DelegationPaneState,
  options: {
    readonly height?: number
    readonly initialTargetSessionID?: string
    readonly initialMode?: "alert" | "limited-correction"
    readonly onPrepare?: WatchDelegationDialogProps["onPrepare"]
    readonly onConfirm?: WatchDelegationDialogProps["onConfirm"]
    readonly onRevoke?: WatchDelegationDialogProps["onRevoke"]
    readonly onCancel?: WatchDelegationDialogProps["onCancel"]
    readonly onClose?: WatchDelegationDialogProps["onClose"]
  } = {},
) {
  const [state, setState] = createSignal<DelegationPaneState>(initialState)
  const setup = await testRender(
    () => (
      <WatchDelegationDialog
        state={state}
        sessionID={SELF}
        parentTaskID="task_parent_001"
        parentVersion={3}
        palette={() => palette}
        initialTargetSessionID={options.initialTargetSessionID}
        initialMode={options.initialMode}
        onPrepare={options.onPrepare}
        onConfirm={options.onConfirm}
        onRevoke={options.onRevoke}
        onCancel={options.onCancel}
        onClose={options.onClose}
      />
    ),
    { width: 100, height: options.height ?? 50 },
  )
  await setup.flush()

  const text = () =>
    setup.captureCharFrame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")

  return { setup, text, setState }
}

describe("WatchDelegationDialog inspection and navigation", () => {
  test("shows direct children and hides unauthorized child content", async () => {
    let closed = 0
    const view = delegationViewPayload({
      parentTaskID: "task_parent_001",
      children: [
        {
          taskID: "task_child_01",
          parentTaskID: "task_parent_001",
          parentSessionID: SELF,
          targetSessionID: "ses_child_authorized",
          authorized: true,
          authorization: {
            allowed: true,
            reason: null,
            grantID: "grant-1",
            grantVersion: 1,
            mode: "alert",
            scopeDirectory: "/tmp/project",
            scopePeerScope: "scope-a",
            scopeSource: "recorded",
            checkedAt: 1_000,
          },
          task: childTask("Authorized child goal") as never,
          alerts: null,
        },
        {
          taskID: "task_child_02",
          parentTaskID: "task_parent_001",
          parentSessionID: SELF,
          targetSessionID: "ses_child_unauthorized",
          authorized: false,
          authorization: {
            allowed: false,
            reason: "cross-scope delegation rejected",
            grantID: null,
            grantVersion: null,
            mode: null,
            scopeDirectory: null,
            scopePeerScope: null,
            scopeSource: "recorded",
            checkedAt: 1_000,
          },
          task: null,
          alerts: null,
        },
      ],
    })

    const { setup, text } = await renderDelegationDialog(
      { kind: "payload", payload: view },
      {
        onClose: () => {
          closed += 1
        },
      },
    )

    const rendered = text()
    expect(rendered).toContain("Session watch — delegation")
    expect(rendered).toContain("Authorized child")
    expect(rendered).toContain("not readable")
    expect(rendered).toContain("cross-scope delegation rejected")
    expect(rendered).toContain("No goal, report or alert is shown")
    expect(rendered).toContain("g: grant delegation")

    setup.mockInput.pressKey("q")
    await setup.flush()
    expect(closed).toBe(1)
  })
})

describe("WatchDelegationDialog controlled review and terms", () => {
  test("review displays both canonical texts and policy parameters for limited-correction", async () => {
    let prepared = 0
    let cancelled = 0
    const { setup, text } = await renderDelegationDialog(
      { kind: "payload", payload: delegationViewPayload() },
      {
        initialTargetSessionID: "ses_child_worker",
        initialMode: "limited-correction",
        onPrepare: async () => {
          prepared += 1
          return {
            reviewSummary: WATCH_DELEGATION_TERMS,
            targetSessionID: "ses_child_worker",
            mode: "limited-correction",
            scopeDirectory: "/tmp/project",
            scopePeerScope: "scope-a",
            expiresAt: 5_000,
          }
        },
        onCancel: () => {
          cancelled += 1
        },
      },
    )

    const review = text()
    expect(review).toContain("Session watch — delegation review")
    expect(review).toContain("Target child session: ses_child_worker")
    expect(review).toContain("Delegation mode: limited-correction")
    // Canonical delegation terms
    expect(review).toContain("Direct-child delegation")
    expect(review).toContain("one host-verified direct child")
    expect(review).toContain("one level only")
    // Canonical correction terms & disclaimers
    expect(review).toContain("Single-host declaration is not proof of uniqueness")
    expect(review).toContain("controlled channel is not human authentication")
    expect(review).toContain("Effective round parameters")
    expect(review).toContain("y: declare + prepare challenge · n: cancel")

    // n cancels without writing
    setup.mockInput.pressKey("n")
    await setup.flush()
    expect(prepared).toBe(0)
    expect(cancelled).toBe(1)
  })

  test("y prepares challenge, y confirms it, and the nonce never reaches the screen", async () => {
    const secretNonce = "secret-delegation-nonce-999"
    let prepares = 0
    let confirms = 0

    const { setup, text } = await renderDelegationDialog(
      { kind: "payload", payload: delegationViewPayload() },
      {
        initialTargetSessionID: "ses_child_worker",
        initialMode: "alert",
        onPrepare: async () => {
          prepares += 1
          return {
            reviewSummary: WATCH_DELEGATION_TERMS,
            targetSessionID: "ses_child_worker",
            mode: "alert",
            scopeDirectory: "/tmp/project",
            scopePeerScope: "scope-a",
            expiresAt: 10_000,
          }
        },
        onConfirm: async () => {
          confirms += 1
        },
      },
    )

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(prepares).toBe(1)

    const confirmView = text()
    expect(confirmView).toContain("Session watch — delegation confirmation")
    expect(confirmView).toContain("Challenge prepared for child session: ses_child_worker")
    expect(confirmView).toContain("Mode: alert")
    expect(confirmView).toContain("/tmp/project")
    expect(confirmView).toContain("scope-a")
    // Nonce must NOT be present on the screen
    expect(confirmView).not.toContain(secretNonce)
    expect(confirmView).toContain("y: grant · n: cancel")

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(confirms).toBe(1)
  })

  test("short terminal height (40h) keeps review terms, disclaimers and action prompts visible", async () => {
    const { text } = await renderDelegationDialog(
      { kind: "payload", payload: delegationViewPayload() },
      {
        height: 40,
        initialTargetSessionID: "ses_child_worker",
        initialMode: "limited-correction",
      },
    )

    const review = text()
    expect(review).toContain("Session watch — delegation review")
    expect(review).toContain("Target child session: ses_child_worker")
    expect(review).toContain("Direct-child delegation")
    expect(review).toContain("Single-host declaration is not proof of uniqueness")
    expect(review).toContain("y: declare + prepare challenge · n: cancel")
  })

  test("interactive target input and mode toggle advance to review", async () => {
    let preparedTarget: string | undefined
    let preparedMode: string | undefined

    const { setup, text } = await renderDelegationDialog(
      { kind: "payload", payload: delegationViewPayload() },
      {
        onPrepare: async (target, mode) => {
          preparedTarget = target
          preparedMode = mode
          return undefined
        },
      },
    )

    // Press g to open input stage
    setup.mockInput.pressKey("g")
    await setup.flush()
    expect(text()).toContain("Session watch — select delegation target")
    expect(text()).toContain("Mode: alert")

    // Type child session ID characters
    for (const char of "child-42") {
      setup.mockInput.pressKey(char)
    }
    await setup.flush()
    expect(text()).toContain("child-42")

    // Toggle mode to limited-correction
    setup.mockInput.pressKey("m")
    await setup.flush()
    expect(text()).toContain("Mode: limited-correction")

    // Press enter to advance to review
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(text()).toContain("Session watch — delegation review")
    expect(text()).toContain("Target child session: child-42")
    expect(text()).toContain("Delegation mode: limited-correction")

    // Press y to prepare
    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(preparedTarget).toBe("child-42")
    expect(preparedMode).toBe("limited-correction")
  })

  test("revoking an active grant prompts for confirmation and calls onRevoke", async () => {
    let revokedTarget: string | undefined

    const view = delegationViewPayload({
      grants: [
        {
          grantID: "grant-99",
          parentTaskID: "task_parent_001",
          parentSessionID: SELF,
          mode: "alert",
          state: "granted",
          version: 1,
          generation: 1,
          targetSessionID: "ses_child_granted_99",
          scopeDirectory: "/tmp/project",
          scopePeerScope: "scope-a",
          reviewSummary: WATCH_DELEGATION_TERMS,
          deployment: null,
          grantedAt: 1_000,
          revokedAt: null,
        },
      ],
    })

    const { setup, text } = await renderDelegationDialog(
      { kind: "payload", payload: view },
      {
        onRevoke: async (target) => {
          revokedTarget = target
        },
      },
    )

    setup.mockInput.pressKey("r")
    await setup.flush()
    expect(text()).toContain("Revoke delegation grant for ses_child_granted_99?")
    expect(text()).toContain("Existing child attempts and accepted reports are not reset")

    setup.mockInput.pressKey("y")
    await setup.flush()
    expect(revokedTarget).toBe("ses_child_granted_99")
  })
})
