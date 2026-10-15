/**
 * Answering a question, listing the ones waiting, and withdrawing one.
 *
 * Seam 2, from the responder's side: the session that received a question
 * resolves which one it is answering (or refuses to guess), and the session
 * that asked withdraws what nobody is waiting on any more. The asker's own
 * side of the handshake lives in `test/ask.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import { askKey } from "../src/host/storage.ts"
import type { AskRecord } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions } from "./fake-host.ts"

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }
const GAMMA = { id: "ses_cccc3333", title: "Release notes" }

/** Load the plugin into a fake host, as the host would, and keep the unload. */
async function loaded(options: FakeHostOptions & { caller: string }) {
  const host = fakeHost(options)
  const cleanup = await plugin.setup(host.context)
  return {
    host,
    id: options.caller,
    async unload() {
      if (typeof cleanup === "function") await cleanup()
    },
  }
}

type Instance = Awaited<ReturnType<typeof loaded>>

/** Let the plugin's subscription and the work it started run to a stop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Wait for something the plugin is doing in the background; fail loudly if it never does. */
async function waitFor(what: string, condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Three locations on one machine, each serving one session, all published. */
async function threeDirectories(
  options: { alpha?: FakeHostOptions; beta?: FakeHostOptions; gamma?: FakeHostOptions } = {},
) {
  const storage = fakeStorage()
  const askTimeoutMs = 2_000
  const alpha = await loaded({
    location: "/work/alpha",
    caller: ALPHA.id,
    storage,
    sessions: [ALPHA],
    options: { askTimeoutMs },
    ...options.alpha,
  })
  const beta = await loaded({
    location: "/work/beta",
    caller: BETA.id,
    storage,
    sessions: [BETA],
    options: { askTimeoutMs },
    ...options.beta,
  })
  const gamma = await loaded({
    location: "/work/gamma",
    caller: GAMMA.id,
    storage,
    sessions: [GAMMA],
    options: { askTimeoutMs },
    ...options.gamma,
  })

  const instances = [alpha, beta, gamma]
  for (const instance of instances) instance.host.emit("session.created", { sessionID: instance.id })
  await settle()
  for (const instance of instances) await instance.host.call("peers", { action: "list" })
  return { alpha, beta, gamma, storage }
}

async function unloadAll(...instances: Instance[]): Promise<void> {
  for (const instance of instances) await instance.unload()
}

/** A record as another instance would have written it. */
function askRecord(overrides: Partial<AskRecord> & { askID: string }): AskRecord {
  const now = Date.now()
  return {
    askerSessionID: ALPHA.id,
    askerInstanceID: "instance-other",
    askerTitle: ALPHA.title,
    targetSessionID: BETA.id,
    question: "Is the payments API frozen?",
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  }
}

describe("pending questions", () => {
  test("lists what is waiting here, oldest first, with a preview a reply can name", async () => {
    const { alpha, beta, gamma } = await threeDirectories()

    const empty = await beta.host.call("peers", { action: "pending" })
    expect(empty.text).toBe("No unresolved inbound asks.")
    expect(empty.details).toEqual({ pending: 0 })

    const fromAlpha = alpha.host.call("peers", {
      action: "ask",
      to: BETA.id,
      message: "First question,\n  with whitespace",
    })
    await waitFor("alpha's question to be delivered", () => alpha.host.prompts.length === 1)
    const fromGamma = gamma.host.call("peers", { action: "ask", to: BETA.id, message: "Second question" })
    await waitFor("gamma's question to be delivered", () => gamma.host.prompts.length === 1)

    const listed = await beta.host.call("peers", { action: "pending" })
    const asks = (listed.details as { asks: { askID: string; title: string }[] }).asks
    expect(asks.map((ask) => ask.title)).toEqual(["Payments API", "Release notes"])
    expect(listed.text).toBe(
      [
        "**Pending asks:**",
        `- Payments API · ${asks[0]!.askID} · 0s ago · First question, with whitespace`,
        `- Release notes · ${asks[1]!.askID} · 0s ago · Second question`,
      ].join("\n"),
    )
    expect(listed.details).toMatchObject({ pending: 2 })

    // Naming the asker is what resolves the line above.
    await beta.host.call("peers", { action: "reply", to: "Release notes", message: "Answer for gamma" })
    await beta.host.call("peers", { action: "reply", to: "Payments API", message: "Answer for alpha" })
    expect((await fromAlpha).text).toBe("**Reply from Docs site:**\nAnswer for alpha")
    expect((await fromGamma).text).toBe("**Reply from Docs site:**\nAnswer for gamma")

    await unloadAll(alpha, beta, gamma)
  })

  test("refuses to guess between two waiting questions", async () => {
    const { alpha, beta, gamma } = await threeDirectories()

    const fromAlpha = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Question one" })
    await waitFor("alpha's question to be delivered", () => alpha.host.prompts.length === 1)
    const fromGamma = gamma.host.call("peers", { action: "ask", to: BETA.id, message: "Question two" })
    await waitFor("gamma's question to be delivered", () => gamma.host.prompts.length === 1)

    const refused = await beta.host.call("peers", { action: "reply", message: "an answer with no target" })
    const reason =
      `More than one peer is waiting for a reply: Payments API, Release notes. ` +
      `Name the one you are answering with "to", or its question with "replyTo".`
    expect(refused.text).toBe(reason)
    expect(refused.details).toMatchObject({
      delivered: false,
      code: "E_REPLY_AMBIGUOUS",
      reason,
      candidates: [
        { sessionID: ALPHA.id, title: "Payments API" },
        { sessionID: GAMMA.id, title: "Release notes" },
      ],
    })
    expect(beta.host.prompts).toEqual([])

    // replyTo names the question itself, and answers the asker who wrote it.
    const listed = (await beta.host.call("peers", { action: "pending" })).details as {
      asks: { askID: string; title: string }[]
    }
    const forGamma = listed.asks.find((ask) => ask.title === "Release notes")!
    const answered = await beta.host.call("peers", {
      action: "reply",
      replyTo: forGamma.askID,
      message: "Answer chosen by id",
    })
    expect(answered.text).toBe("Reply sent to Release notes")
    expect((await fromGamma).text).toBe("**Reply from Docs site:**\nAnswer chosen by id")

    await beta.host.call("peers", { action: "reply", message: "the remaining answer" })
    expect((await fromAlpha).text).toBe("**Reply from Docs site:**\nthe remaining answer")

    await unloadAll(alpha, beta, gamma)
  })

  test("reports a reply that names nobody waiting", async () => {
    const { alpha, beta } = await threeDirectories()

    const none = await beta.host.call("peers", { action: "reply", message: "to nobody" })
    expect(none.text).toBe("No pending ask matches that reply.")
    expect(none.details).toMatchObject({ delivered: false, code: "E_NO_PENDING_ASK" })

    const wrongAsk = await beta.host.call("peers", { action: "reply", replyTo: "ask_nope", message: "to nobody" })
    expect(wrongAsk.text).toBe("No pending ask matches that reply.")

    await unloadAll(alpha, beta)
  })
})

describe("answering a question whose wait has ended", () => {
  test("delivers the answer as an ordinary message to a peer that accepts only replies", async () => {
    const { alpha, beta, storage } = await threeDirectories({ alpha: { options: { trigger: "replies" } } })

    // The asker's wait ended long ago; its instance is gone; nothing is left
    // but the record — the state a live timeout leaves behind.
    const ask = askRecord({ askID: "ask_expired", expiresAt: Date.now() - 1_000, question: "Old question" })
    await storage.set(askKey(ask.askID), ask)
    await settle()

    const answered = await beta.host.call("peers", { action: "reply", message: "An answer after the fact." })
    expect(answered.text).toContain("(late:")
    expect(beta.host.prompts).toHaveLength(1)
    // An answer is not a question: the message it becomes carries no reply
    // instruction (issue #24).
    expect(beta.host.prompts[0]?.text).not.toContain("To reply:")

    // A plain send to the same session is still refused: the answer was admitted
    // because it is one side of an exchange, not because the policy was ignored.
    const plain = await beta.host.call("peers", { action: "send", to: "Payments API", message: "a plain message" })
    const reason = `Session "Payments API" accepts peer messages only as answers to its own questions, and this is a new message.`
    expect(plain.text).toBe(reason)
    expect(plain.details).toMatchObject({ delivered: false, code: "E_TARGET_REPLIES_ONLY" })

    await unloadAll(alpha, beta)
  })

  test("refuses it when the asker has gone away, and delivers nothing", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const ask = askRecord({ askID: "ask_gone", askerSessionID: "ses_gone", expiresAt: Date.now() - 1_000 })
    await storage.set(askKey(ask.askID), ask)
    await settle()

    const answered = await beta.host.call("peers", { action: "reply", message: "to nobody in particular" })

    const reason = `Session "Payments API" is not connected. Blocking asks are not queued; use "send" or retry once it reconnects.`
    expect(answered.text).toBe(reason)
    expect(answered.details).toEqual({
      delivered: false,
      code: "E_TARGET_NOT_FOUND",
      reason,
      retryable: false,
      sessionID: "ses_gone",
    })
    expect(beta.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("withdrawing a question", () => {
  test("withdraws one that is still waiting, and reports it", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    // The question of an asker whose instance has gone away: recorded, not
    // answered, and nobody in the blocked call any more.
    const ask = askRecord({ askID: "ask_waiting" })
    await storage.set(askKey(ask.askID), ask)
    await settle()
    expect((await beta.host.call("peers", { action: "pending" })).text).toContain("Payments API")

    const result = await alpha.host.call("peers", { action: "cancel" })
    expect(result.text).toBe("Cancellation requested for ask_waiting")
    expect(result.details).toEqual({
      delivered: true,
      cancelled: true,
      askID: "ask_waiting",
      sessionID: BETA.id,
    })
    expect((await beta.host.call("peers", { action: "pending" })).text).toBe("No unresolved inbound asks.")

    // Withdrawn means withdrawn: a reply now has no question to answer.
    const late = await beta.host.call("peers", { action: "reply", message: "too late?" })
    expect(late.details).toMatchObject({ code: "E_NO_PENDING_ASK" })

    await unloadAll(alpha, beta)
  })

  test("reports one whose wait had already ended, and still lets its answer arrive", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const ask = askRecord({ askID: "ask_ended", expiresAt: Date.now() - 1_000 })
    await storage.set(askKey(ask.askID), ask)
    await settle()

    const result = await alpha.host.call("peers", { action: "cancel" })
    expect(result.text).toBe(
      "Cancellation for ask_ended was not delivered: its wait had already ended, so an answer " +
        "that arrives later will arrive as an ordinary message.",
    )
    expect(result.details).toEqual({
      delivered: false,
      cancelled: false,
      ended: true,
      askID: "ask_ended",
      sessionID: BETA.id,
    })

    // The record was left alone: the answer still has a path to the asker.
    const answered = await beta.host.call("peers", { action: "reply", message: "An answer, eventually." })
    expect(answered.text).toContain("(late:")
    expect(beta.host.prompts).toHaveLength(1)

    await unloadAll(alpha, beta)
  })

  test("names the question when one was asked, and refuses when none is outstanding", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const none = await alpha.host.call("peers", { action: "cancel" })
    expect(none.text).toBe("This session has no question waiting for an answer.")
    expect(none.details).toEqual({
      delivered: false,
      code: "E_NO_ASK_TO_CANCEL",
      reason: "This session has no question waiting for an answer.",
      retryable: false,
    })

    await storage.set(askKey("ask_mine"), askRecord({ askID: "ask_mine" }))
    await storage.set(
      askKey("ask_theirs"),
      askRecord({ askID: "ask_theirs", askerSessionID: BETA.id, targetSessionID: ALPHA.id }),
    )
    await settle()

    const named = await alpha.host.call("peers", { action: "cancel", replyTo: "ask_nope" })
    expect(named.text).toBe(`No question with id "ask_nope" is outstanding for this session.`)
    expect(named.details).toMatchObject({ code: "E_NO_ASK_TO_CANCEL" })

    const mine = await alpha.host.call("peers", { action: "cancel", replyTo: "ask_mine" })
    expect(mine.text).toBe("Cancellation requested for ask_mine")

    await unloadAll(alpha, beta)
  })

  test("a disabled plugin withdraws nothing and says why", async () => {
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      options: { enabled: false },
      sessions: [ALPHA],
    })

    const result = await alpha.host.call("peers", { action: "cancel" })
    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toMatchObject({ delivered: false, code: "E_DISABLED" })

    await alpha.unload()
  })
})
