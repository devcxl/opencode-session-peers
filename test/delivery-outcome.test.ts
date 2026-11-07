import { describe, expect, test } from "bun:test"

import plugin from "../src/index.ts"
import { fakeHost, type FakeHostOptions } from "./fake-host.ts"
import { fakeStorage } from "./fake-storage.ts"

const A = { id: "ses_aaaa1111", title: "sender" }
const B = { id: "ses_bbbb2222", title: "recipient" }

async function peers(options: FakeHostOptions = {}) {
  const storage = fakeStorage()
  const sender = fakeHost({ location: "/work/a", caller: A.id, sessions: [A], storage, ...options })
  const recipient = fakeHost({ location: "/work/b", caller: B.id, sessions: [B], storage })
  const stopSender = await plugin.setup(sender.context)
  const stopRecipient = await plugin.setup(recipient.context)
  await sender.call("peers", { action: "list" })
  await recipient.call("peers", { action: "list" })
  return {
    sender,
    recipient,
    storage,
    async close() {
      if (typeof stopSender === "function") await stopSender()
      if (typeof stopRecipient === "function") await stopRecipient()
    },
  }
}

describe("delivery outcomes", () => {
  test("a successful prompt reports admission, not reading", async () => {
    const { sender, close } = await peers()
    try {
      const result = await sender.call("peers", { action: "send", to: B.id, message: "hello" })
      expect(result.details).toMatchObject({ delivered: true, outcome: "accepted" })
      expect(result.text).toContain("accepted")
      expect(result.text).toContain("not mean")
    } finally {
      await close()
    }
  })

  test("a prompt error is unknown rather than an invented missing session", async () => {
    const { sender, close } = await peers({ promptError: new Error("temporary failure") })
    try {
      const result = await sender.call("peers", { action: "send", to: B.id, message: "hello" })
      expect(result.details).toMatchObject({ outcome: "unknown", retryable: false })
      expect(result.details).not.toHaveProperty("delivered")
      expect(result.text).toContain("may have been accepted")
      expect(result.text).toContain("duplicate")
    } finally {
      await close()
    }
  })

  test("an uncertain ask remains answerable after the local wait ends", async () => {
    const { sender, recipient, storage, close } = await peers({ promptError: new Error("connection lost") })
    try {
      const result = await sender.call("peers", { action: "ask", to: B.id, message: "question" })
      expect(result.details).toMatchObject({ outcome: "unknown" })
      const askID = (result.details as { askID: string }).askID
      expect(storage.values().some((value) => (value as { askID?: string })?.askID === askID)).toBe(true)
      const reply = await recipient.call("peers", { action: "reply", replyTo: askID, message: "answer" })
      expect(reply.details).toMatchObject({ outcome: "accepted", late: true })
      expect(recipient.prompts[0]?.text).toContain("answer")
    } finally {
      await close()
    }
  })
})
