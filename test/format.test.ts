import { describe, expect, test } from "bun:test"

import { formatAttachments, inboundMessage, pendingAskRow, replyResult, rosterRow } from "../src/domain/format.ts"
import type { AskRecord, Peer } from "../src/domain/types.ts"

const PEER: Peer = {
  sessionID: "ses_aaaaaaaaaaaa1111",
  title: "Payments API",
  directory: "/home/dev/projects/payments",
  model: "some-model",
  status: "busy",
  scope: "default",
  instanceID: "instance-a",
  updatedAt: 0,
}

describe("rosterRow", () => {
  test("carries the facts a reader needs to choose a target", () => {
    const row = rosterRow(PEER, { self: false, sameDirectory: false })
    expect(row).toBe("• Payments API (ses_aaaaaaaaaaaa1111) — /home/dev/projects/payments (some-model · busy)")
  })

  test("omits empty facts and adds tags", () => {
    const bare: Peer = { ...PEER, model: undefined, status: undefined }
    const row = rosterRow(bare, { self: true, sameDirectory: true })
    expect(row).toBe("• Payments API (ses_aaaaaaaaaaaa1111) — /home/dev/projects/payments [self, same cwd]")
  })
})

describe("formatAttachments", () => {
  test("labels each block with its type, name and language", () => {
    const block = formatAttachments([
      { type: "snippet", name: "handler.ts", content: "export const x = 1", language: "ts" },
      { type: "context", name: "notes", content: "why we did this" },
    ])
    expect(block).toContain("--- snippet: handler.ts ts ---")
    expect(block).toContain("--- context: notes ---")
    expect(block).toContain("why we did this")
  })
})

describe("inboundMessage", () => {
  test("names the sender, its directory, and the body", () => {
    const text = inboundMessage({ from: PEER, body: { text: "Are you done with the API?" }, replyHint: false })
    expect(text).toBe("**From Payments API** (/home/dev/projects/payments)\n\nAre you done with the API?")
  })

  test("adds the reply hint when asked for", () => {
    const text = inboundMessage({ from: PEER, body: { text: "ping" }, replyHint: true })
    expect(text).toContain(`To reply: peers({ action: "reply", message: "..." })`)
  })

  test("renders provenance and attachments after the body", () => {
    const text = inboundMessage({
      from: PEER,
      body: { text: "context attached", attachments: [{ type: "file", name: "a.ts", content: "let a = 1" }] },
      replyHint: false,
      meta: "ask ses_bbbb",
    })
    expect(text.indexOf("context attached")).toBeLessThan(text.indexOf("--- file: a.ts ---"))
    expect(text).toContain("_ask ses_bbbb_")
  })
})

describe("replyResult", () => {
  test("names the answerer and carries the answer, attachments and all", () => {
    const text = replyResult("Docs site", {
      text: "Yes, frozen for review.",
      attachments: [{ type: "snippet", name: "handler.ts", content: "export const x = 1", language: "ts" }],
    })
    expect(text).toBe(
      "**Reply from Docs site:**\nYes, frozen for review.\n\n--- snippet: handler.ts ts ---\nexport const x = 1",
    )
  })

  test("renders an answer that is only attachments", () => {
    const text = replyResult("Docs site", { text: "", attachments: [{ type: "file", name: "a.ts", content: "x" }] })
    expect(text).toContain("**Reply from Docs site:**")
    expect(text).toContain("--- file: a.ts ---\nx")
  })
})

describe("pendingAskRow", () => {
  test("carries the asker, the question id, the age and a one-line preview", () => {
    const ask: AskRecord = {
      askID: "ask_1234",
      askerSessionID: "ses_aaaa1111",
      askerInstanceID: "instance-a",
      askerTitle: "Payments API",
      targetSessionID: "ses_bbbb2222",
      question: "First question,\n   with whitespace",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    }
    expect(pendingAskRow(ask, 1_700_000_012_000)).toBe(
      "- Payments API · ask_1234 · 12s ago · First question, with whitespace",
    )
  })

  test("says so when a question carried no text of its own", () => {
    const ask: AskRecord = {
      askID: "ask_1234",
      askerSessionID: "ses_aaaa1111",
      askerInstanceID: "instance-a",
      askerTitle: "Payments API",
      targetSessionID: "ses_bbbb2222",
      question: "",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    }
    expect(pendingAskRow(ask, 1_700_000_000_000)).toBe("- Payments API · ask_1234 · 0s ago · (no text)")
  })
})
