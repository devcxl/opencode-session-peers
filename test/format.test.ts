import { describe, expect, test } from "bun:test"

import { formatAttachments, inboundMessage, rosterRow } from "../src/domain/format.ts"
import type { Peer } from "../src/domain/types.ts"

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
    const row = rosterRow(PEER, { self: false, sameDirectory: false, prefix: "ses_aaaa" })
    expect(row).toBe("• Payments API (ses_aaaa) — /home/dev/projects/payments (some-model · busy)")
  })

  test("omits empty facts and adds tags", () => {
    const bare: Peer = { ...PEER, model: undefined, status: undefined }
    const row = rosterRow(bare, { self: true, sameDirectory: true, prefix: "ses_aaaa" })
    expect(row).toBe("• Payments API (ses_aaaa) — /home/dev/projects/payments [self, same cwd]")
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
