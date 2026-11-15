import { describe, expect, test } from "bun:test"

import { plan, BEGIN_MARKER, DUPLICATE_MARKER, WRONG_CALLER_MARKER, STUB_DONE_TEXT } from "../scripts/research/watchdog-61/positive-stub.ts"

const correction = [
  "[session-peers correction]",
  "Watched task task-1; ledger generation 1; permanent attempt 1; attemptID attempt-1; correlation corr-1.",
  "Target session: ses-1; task state version after reservation: 4.",
  'peers({"action":"watch","watch":{"operation":"receipt","taskID":"task-1","attemptID":"attempt-1","correlation":"corr-1"}})',
].join("\n")

describe("positive stub plan", () => {
  test("begin calls the tool once and then stops", () => {
    const first = plan({ messages: [{ role: "user", content: `${BEGIN_MARKER} taskID=task-1 version=3 reportId=begin` }] })
    expect(first).toMatchObject({ kind: "tool" })
    const second = plan({
      messages: [
        { role: "user", content: `${BEGIN_MARKER} taskID=task-1 version=3 reportId=begin` },
        { role: "tool", content: "begin recorded" },
      ],
    })
    expect(second).toEqual({ kind: "text", text: STUB_DONE_TEXT })
  })

  test("correction calls receipt, then progress once, then stops", () => {
    const receipt = plan({ messages: [{ role: "user", content: correction }] })
    expect(receipt).toMatchObject({ kind: "tool" })
    if (receipt.kind === "tool") expect(receipt.arguments).toContain('"operation":"receipt"')

    const progress = plan({
      messages: [
        { role: "user", content: correction },
        { role: "tool", content: "One continue permit was issued for this attempt." },
      ],
    })
    expect(progress).toMatchObject({ kind: "tool" })
    if (progress.kind === "tool") expect(progress.arguments).toContain('"operation":"report"')

    const done = plan({
      messages: [
        { role: "user", content: correction },
        { role: "tool", content: "One continue permit was issued for this attempt." },
        { role: "tool", content: "progress recorded WATCH61_PROGRESS" },
      ],
    })
    expect(done).toEqual({ kind: "text", text: STUB_DONE_TEXT })
  })

  test("a refused receipt never issues progress", () => {
    const done = plan({
      messages: [
        { role: "user", content: correction },
        { role: "tool", content: "Correction receipt recorded as seen, but no continue permit was issued." },
      ],
    })
    expect(done).toEqual({ kind: "text", text: STUB_DONE_TEXT })
  })

  test("duplicate and wrong-caller directives call once and stop", () => {
    for (const marker of [DUPLICATE_MARKER, WRONG_CALLER_MARKER]) {
      const first = plan({
        messages: [{ role: "user", content: `${marker} taskID=task-1 attemptID=attempt-1 correlation=corr-1` }],
      })
      expect(first).toMatchObject({ kind: "tool" })
      const done = plan({
        messages: [
          { role: "user", content: `${marker} taskID=task-1 attemptID=attempt-1 correlation=corr-1` },
          { role: "tool", content: "refused" },
        ],
      })
      expect(done).toEqual({ kind: "text", text: STUB_DONE_TEXT })
    }
  })
})
