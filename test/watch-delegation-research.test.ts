/**
 * Pure scripted-model and bounded-directive tests for the #63 real-host runner.
 *
 * They never start an opencode instance, a model endpoint or a host database.
 */

import { describe, expect, test } from "bun:test"

import {
  CHILD_BEGIN_MARKER,
  CHILD_IDLE_MARKER,
  CORRECTION_PREFIX,
  DUPLICATE_MARKER,
  PARENT_BEGIN_MARKER,
  PARENT_DELEGATE_MARKER,
  PARENT_RECEIPT_MARKER,
  PARENT_SUBAGENT_MARKER,
  PROGRESS_MARKER,
  classifyNativeSubagentReport,
  countMessages,
  countNativeSubagentReports,
  directiveFields,
  parseCorrectionCall,
  scenarioFromValue,
} from "../scripts/research/watchdog-63/protocol.ts"
import { planWatch63, shouldLatch } from "../scripts/research/watchdog-63/stub.ts"

const CORRECTION_PROMPT = [
  "[session-peers correction]",
  "Watched task task-1; ledger generation 1; permanent attempt 1; attemptID attempt-1; correlation corr-1.",
  "Target session: ses-child; task state version after reservation: 7.",
  'peers({"action":"watch","watch":{"operation":"receipt","taskID":"task-1","attemptID":"attempt-1","correlation":"corr-1"}})',
].join("\n")

describe("watchdog-63 scripted protocol", () => {
  test("scenario values are bounded and default to positive", () => {
    expect(scenarioFromValue(undefined)).toBe("positive")
    expect(scenarioFromValue("positive")).toBe("positive")
    expect(scenarioFromValue("revoke")).toBe("revoke")
    expect(scenarioFromValue("scope")).toBe("scope")
    expect(() => scenarioFromValue("all")).toThrow()
  })

  test("reads only the bounded key fields and the concrete receipt", () => {
    const fields = directiveFields(
      `${PARENT_DELEGATE_MARKER} taskID=task-parent version=3 targetSessionID=ses-child requestId=req-1 goal=WATCH63_GOAL`,
      PARENT_DELEGATE_MARKER,
    )
    expect(fields).toMatchObject({
      taskID: "task-parent",
      version: "3",
      targetSessionID: "ses-child",
      requestId: "req-1",
      goal: "WATCH63_GOAL",
    })
    expect(parseCorrectionCall(CORRECTION_PROMPT)).toEqual({
      taskID: "task-1",
      attemptID: "attempt-1",
      correlation: "corr-1",
      stateVersion: 7,
    })
    expect(parseCorrectionCall("no correction here")).toBeUndefined()
  })

  test("counts user, assistant and correction messages without reading their bodies", () => {
    expect(
      countMessages([
        { type: "user", text: "driver" },
        { type: "assistant", text: "tool call" },
        { type: "user", text: CORRECTION_PREFIX },
        { type: "tool", text: "result" },
      ]),
    ).toEqual({ user: 2, assistant: 1, correctionUsers: 1, synthetic: 0 })
  })

  test("native subagent reports need matching metadata, source and tag; a fake tag is not exempt", () => {
    const native = {
      type: "synthetic",
      text: '<subagent sessionID="ses_child" state="completed">result</subagent>',
      metadata: { source: "subagent", childID: "ses_child", agent: "general", state: "completed" },
    }
    expect(classifyNativeSubagentReport(native, "ses_child")).toBe("native")
    expect(classifyNativeSubagentReport(native, "ses_other")).toBe("other")
    expect(
      classifyNativeSubagentReport(
        { type: "synthetic", text: '<subagent sessionID="ses_child">result</subagent>' },
        "ses_child",
      ),
    ).toBe("other")
    expect(
      classifyNativeSubagentReport(
        { type: "synthetic", text: '<subagent sessionID="ses_other">result</subagent>', metadata: native.metadata },
        "ses_child",
      ),
    ).toBe("invalid")
    expect(
      classifyNativeSubagentReport(
        { type: "synthetic", text: "result without a tag", metadata: native.metadata },
        "ses_child",
      ),
    ).toBe("invalid")
    expect(
      countNativeSubagentReports(
        [
          native,
          { type: "synthetic", text: '<subagent sessionID="ses_child">x</subagent>' },
          {
            type: "synthetic",
            text: '<subagent sessionID="ses_other">x</subagent>',
            metadata: { source: "subagent", childID: "ses_other" },
          },
        ],
        "ses_child",
      ),
    ).toEqual({ nativeHostReports: 1, otherSynthetic: 2, invalidNativeReports: 0 })
  })

  test("the parent subagent turn creates the child without a task begin", () => {
    const reply = planWatch63({ messages: [{ role: "user", content: PARENT_SUBAGENT_MARKER }] })
    expect(reply).toMatchObject({ kind: "tool", name: "subagent" })
    if (reply.kind !== "tool") return
    expect(reply.arguments).toContain(CHILD_IDLE_MARKER)
    expect(reply.arguments).toContain('"agent":"general"')
    expect(reply.arguments).not.toContain("taskID")
    const after = planWatch63({
      messages: [
        { role: "user", content: PARENT_SUBAGENT_MARKER },
        { role: "tool", content: "child done" },
      ],
    })
    expect(after.kind).toBe("text")
  })

  test("child idle, child begin and parent begin are distinct bounded turns", () => {
    expect(planWatch63({ messages: [{ role: "user", content: CHILD_IDLE_MARKER }] }).kind).toBe("text")
    const childBegin = planWatch63({
      messages: [{ role: "user", content: `${CHILD_BEGIN_MARKER} taskID=task-child version=1 reportId=begin-1` }],
    })
    expect(childBegin).toMatchObject({ kind: "tool", name: "peers" })
    if (childBegin.kind === "tool") {
      expect(childBegin.arguments).toContain('"operation":"report"')
      expect(childBegin.arguments).toContain('"kind":"begin"')
    }
    const parentBegin = planWatch63({
      messages: [{ role: "user", content: `${PARENT_BEGIN_MARKER} taskID=task-parent version=4 reportId=begin-2` }],
    })
    expect(parentBegin).toMatchObject({ kind: "tool", name: "peers" })
    if (parentBegin.kind === "tool") expect(parentBegin.arguments).toContain('"taskID":"task-parent"')
  })

  test("the public delegate call carries the limited-correction mode", () => {
    const reply = planWatch63({
      messages: [
        {
          role: "user",
          content: `${PARENT_DELEGATE_MARKER} taskID=task-parent version=4 targetSessionID=ses-child requestId=req-1 goal=WATCH63_GOAL`,
        },
      ],
    })
    expect(reply).toMatchObject({ kind: "tool", name: "peers" })
    if (reply.kind !== "tool") return
    expect(reply.arguments).toContain('"operation":"delegate"')
    expect(reply.arguments).toContain('"mode":"limited-correction"')
    expect(reply.arguments).toContain('"targetSessionID":"ses-child"')
  })

  test("the correction prompt drives receipt, then progress, then stop", () => {
    const receipt = planWatch63({ messages: [{ role: "user", content: CORRECTION_PROMPT }] })
    expect(receipt).toMatchObject({ kind: "tool", name: "peers" })
    if (receipt.kind !== "tool") return
    expect(receipt.arguments).toContain('"operation":"receipt"')
    expect(receipt.arguments).toContain('"correlation":"corr-1"')

    const progress = planWatch63({
      messages: [
        { role: "user", content: CORRECTION_PROMPT },
        { role: "tool", content: "One continue permit was issued." },
      ],
    })
    expect(progress).toMatchObject({ kind: "tool", name: "peers" })
    if (progress.kind === "tool") {
      expect(progress.arguments).toContain('"operation":"report"')
      expect(progress.arguments).toContain(PROGRESS_MARKER)
    }

    const done = planWatch63({
      messages: [
        { role: "user", content: CORRECTION_PROMPT },
        { role: "tool", content: "One continue permit was issued." },
        { role: "tool", content: `${PROGRESS_MARKER} recorded` },
      ],
    })
    expect(done.kind).toBe("text")
  })

  test("duplicate and parent receipt directives use the same concrete ids", () => {
    for (const marker of [DUPLICATE_MARKER, PARENT_RECEIPT_MARKER]) {
      const reply = planWatch63({
        messages: [
          {
            role: "user",
            content: `${marker} taskID=task-1 attemptID=attempt-1 correlation=corr-1`,
          },
        ],
      })
      expect(reply).toMatchObject({ kind: "tool", name: "peers" })
      if (reply.kind === "tool") {
        expect(reply.arguments).toContain('"operation":"receipt"')
        expect(reply.arguments).toContain('"attemptID":"attempt-1"')
      }
    }
  })

  test("the latch is enabled only for the first negative-variant correction", () => {
    const body = { messages: [{ role: "user", content: CORRECTION_PROMPT }] }
    expect(shouldLatch(body, "positive", { latchUsed: false, released: false })).toBe(false)
    expect(shouldLatch(body, "revoke", { latchUsed: false, released: false })).toBe(true)
    expect(shouldLatch(body, "scope", { latchUsed: false, released: false })).toBe(true)
    expect(shouldLatch(body, "revoke", { latchUsed: true, released: false })).toBe(false)
    expect(shouldLatch(body, "revoke", { latchUsed: false, released: true })).toBe(false)
    expect(shouldLatch({ messages: [{ role: "user", content: "plain" }] }, "revoke", { latchUsed: false, released: false })).toBe(false)
  })
})
