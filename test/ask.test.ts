/**
 * Asking a peer, and answering one.
 *
 * Seam 2 again: fake hosts that share one storage, standing in for two or three
 * locations of one machine. The ask call is started and *not* awaited — that is
 * what blocking means — and what is asserted is what the model reads on each
 * side, and what the plugin asked the host to hand to which session. The
 * instance that answers is deliberately a different one from the instance that
 * is blocked, because that is the route storage has to carry.
 */

import { describe, expect, test } from "bun:test"

import { askKey } from "../src/host/storage.ts"
import { askTimeoutReason } from "../src/domain/errors.ts"
import type { AskRecord } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions, type FakeStorage } from "./fake-host.ts"

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

/**
 * Three locations on one machine, each serving one session, all published so
 * each can address the others. A two-second ask timeout keeps a test that
 * leaves a question waiting bounded, and makes the asker notice an answer
 * within a hundred milliseconds rather than a second.
 */
async function threeDirectories(
  options: { alpha?: FakeHostOptions; beta?: FakeHostOptions; gamma?: FakeHostOptions } = {},
) {
  const storage = fakeStorage()
  const timeout = { options: { askTimeoutMs: 2_000 } }
  const alpha = await loaded({
    location: "/work/alpha",
    caller: ALPHA.id,
    storage,
    sessions: [ALPHA],
    ...timeout,
    ...options.alpha,
  })
  const beta = await loaded({
    location: "/work/beta",
    caller: BETA.id,
    storage,
    sessions: [BETA],
    ...timeout,
    ...options.beta,
  })
  const gamma = await loaded({
    location: "/work/gamma",
    caller: GAMMA.id,
    storage,
    sessions: [GAMMA],
    ...timeout,
    ...options.gamma,
  })

  const instances = [alpha, beta, gamma]
  for (const instance of instances) instance.host.emit("session.created", { sessionID: instance.id })
  await settle()
  // Both sides are addressable only once they are on the roster.
  for (const instance of instances) await instance.host.call("peers", { action: "list" })
  return { alpha, beta, gamma, storage }
}

async function unloadAll(...instances: Instance[]): Promise<void> {
  for (const instance of instances) await instance.unload()
}

/** Every value stored under one prefix, the way another instance would read it. */
async function stored(storage: FakeStorage, prefix: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  let after: string | undefined
  for (;;) {
    const page = await storage.scan(after === undefined ? { prefix } : { prefix, after })
    values.push(...page.entries.map((entry) => entry.value as Record<string, unknown>))
    if (page.next === undefined || page.next === after) return values
    after = page.next
  }
}

/** The question in the shared storage, whoever is blocked on it. */
async function askRecordFor(storage: FakeStorage): Promise<AskRecord> {
  const [record] = await stored(storage, "v1/asks/")
  if (record === undefined) throw new Error("no ask record is stored")
  return record as unknown as AskRecord
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

describe("a question that is answered", () => {
  test("blocks the asker's call until the peer's instance produces the answer", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const asking = alpha.host.call("peers", {
      action: "ask",
      to: "Docs site",
      message: "Is the payments API frozen?",
    })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    // The recipient reads the body `send` would have produced: sender,
    // directory, the instruction that answers it, then the question.
    expect(alpha.host.prompts).toEqual([
      {
        sessionID: BETA.id,
        text: [
          `**From Payments API** (/work/alpha)`,
          `To reply: peers({ action: "reply", message: "..." })`,
          "",
          "Is the payments API frozen?",
        ].join("\n"),
        delivery: "queue",
      },
    ])
    expect(beta.host.prompts).toEqual([])

    const answered = await beta.host.call("peers", { action: "reply", message: "Yes, frozen for review." })
    const askID = (answered.details as { askID: string }).askID
    expect(answered.text).toBe("Reply sent to Payments API")
    expect(answered.details).toEqual({
      delivered: true,
      askID,
      sessionID: ALPHA.id,
      title: "Payments API",
    })

    const result = await asking
    expect(result.text).toBe("**Reply from Docs site:**\nYes, frozen for review.")
    expect(result.details).toEqual({
      answered: true,
      askID,
      sessionID: BETA.id,
      title: "Docs site",
      directory: "/work/beta",
      status: "idle",
      self: false,
    })
    // The answer was consumed: the slot nobody reads again is gone.
    expect(await stored(storage, "v1/replies/")).toEqual([])
    expect(await stored(storage, "v1/asks/")).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("resolves inside the instance that serves both sessions", async () => {
    const host = fakeHost({
      location: "/work/one",
      caller: ALPHA.id,
      sessions: [ALPHA, BETA],
      options: { askTimeoutMs: 2_000 },
    })
    const cleanup = await plugin.setup(host.context)
    host.emit("session.created", { sessionID: ALPHA.id })
    host.emit("session.created", { sessionID: BETA.id })
    await settle()
    await host.call("peers", { action: "list" }, ALPHA.id)
    await host.call("peers", { action: "list" }, BETA.id)

    const asking = host.call("peers", { action: "ask", to: BETA.id, message: "Same directory?" }, ALPHA.id)
    await waitFor("the question to be delivered", () => host.prompts.length === 1)

    const answered = await host.call("peers", { action: "reply", message: "Same answer." }, BETA.id)
    expect(answered.text).toBe("Reply sent to Payments API")

    const result = await asking
    expect(result.text).toBe("**Reply from Docs site:**\nSame answer.")

    if (typeof cleanup === "function") await cleanup()
  })

  test("resolves from the reply slot another instance wrote, id and all", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Who writes this?" })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)
    const ask = await askRecordFor(storage)

    // Exactly what the answering instance's `reply` writes, by hand: if the
    // asker resolved anything but this, this test would hang.
    await storage.set(`v1/replies/${ask.askID}`, {
      askID: ask.askID,
      fromSessionID: BETA.id,
      fromTitle: "Docs site",
      text: "A different instance wrote this.",
    })

    const result = await asking
    expect(result.text).toBe("**Reply from Docs site:**\nA different instance wrote this.")

    await unloadAll(alpha, beta)
  })

  test("carries attachments from the answer to the asker", async () => {
    const { alpha, beta } = await threeDirectories()

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Attach the handler?" })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)
    await beta.host.call("peers", {
      action: "reply",
      message: "Here it is.",
      attachments: [{ type: "snippet", name: "handler.ts", content: "export const x = 1", language: "ts" }],
    })

    const result = await asking
    expect(result.text).toContain("**Reply from Docs site:**\nHere it is.")
    expect(result.text).toContain("--- snippet: handler.ts ts ---\nexport const x = 1")

    await unloadAll(alpha, beta)
  })
})

describe("admission", () => {
  test("refuses a second ask while one is waiting", async () => {
    const { alpha, beta, gamma } = await threeDirectories()

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "First question" })
    await waitFor("the first question to be delivered", () => alpha.host.prompts.length === 1)

    const second = await alpha.host.call("peers", { action: "ask", to: GAMMA.id, message: "Second question" })
    expect(second.text).toBe("Already waiting for a reply; one ask at a time.")
    expect(second.details).toEqual({
      delivered: false,
      code: "E_ASK_IN_FLIGHT",
      reason: "Already waiting for a reply; one ask at a time.",
      retryable: false,
      sessionID: GAMMA.id,
    })
    expect(alpha.host.prompts).toHaveLength(1)

    await beta.host.call("peers", { action: "reply", message: "Answer to the first" })
    expect((await asking).text).toBe("**Reply from Docs site:**\nAnswer to the first")

    await unloadAll(alpha, beta, gamma)
  })

  test("refuses to ask a peer that has an open question of its own", async () => {
    const { alpha, beta } = await threeDirectories()

    const asking = beta.host.call("peers", { action: "ask", to: ALPHA.id, message: "Question from beta" })
    await waitFor("beta's question to be delivered", () => beta.host.prompts.length === 1)

    const refused = await alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Question from alpha" })
    const reason = `"Docs site" has an open question to you. Answer it with "reply" before asking one of your own.`
    expect(refused.text).toBe(reason)
    expect(refused.details).toEqual({
      delivered: false,
      code: "E_MUTUAL_ASK",
      reason,
      retryable: false,
      sessionID: BETA.id,
    })
    // Alpha never asked: it answered first, which is what the refusal asked of it.
    expect(alpha.host.prompts).toEqual([])

    await alpha.host.call("peers", { action: "reply", message: "Answering yours instead." })
    expect((await asking).text).toBe("**Reply from Payments API:**\nAnswering yours instead.")

    await unloadAll(alpha, beta)
  })

  test("refuses a send to a third session while a question waits here", async () => {
    const { alpha, beta, gamma, storage } = await threeDirectories()

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Are you there?" })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    const misdirected = await beta.host.call("peers", { action: "send", to: GAMMA.id, message: "not an answer" })
    const reason = `This session has an unanswered question from "Payments API". Answer it with "reply" before sending to another peer.`
    expect(misdirected.text).toBe(reason)
    expect(misdirected.details).toEqual({
      delivered: false,
      code: "E_ASK_UNANSWERED",
      reason,
      retryable: false,
      sessionID: GAMMA.id,
      askID: (await askRecordFor(storage)).askID,
      askerSessionID: ALPHA.id,
    })
    expect(beta.host.prompts).toEqual([])

    // The asker itself is not a third session: a send there is delivered.
    const toTheAsker = await beta.host.call("peers", { action: "send", to: ALPHA.id, message: "a note, not the answer" })
    expect(toTheAsker.text).toBe("Message sent to Payments API")
    expect(beta.host.prompts).toHaveLength(1)

    await beta.host.call("peers", { action: "reply", message: "the actual answer" })
    expect((await asking).text).toBe("**Reply from Docs site:**\nthe actual answer")

    await unloadAll(alpha, beta, gamma)
  })

  test("an ask reaches a peer that declares it accepts only replies", async () => {
    const { alpha, beta } = await threeDirectories({ beta: { options: { trigger: "replies", askTimeoutMs: 2_000 } } })

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Exchange only, please." })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    // The same declaration refuses a plain message, so the exchange flag is
    // what admitted the question (see test/send.test.ts for the refusal).
    const plain = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "a plain message" })
    expect(plain.details).toMatchObject({ code: "E_TARGET_REPLIES_ONLY" })

    await beta.host.call("peers", { action: "reply", message: "Admitted as an exchange." })
    expect((await asking).text).toBe("**Reply from Docs site:**\nAdmitted as an exchange.")

    await unloadAll(alpha, beta)
  })

  test("a peer that declares never is not asked", async () => {
    const { alpha, beta } = await threeDirectories({ beta: { options: { trigger: "never" } } })

    const result = await alpha.host.call("peers", { action: "ask", to: "Docs site", message: "anyone?" })

    expect(result.text).toBe(`Session "Docs site" does not accept peer messages.`)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_REFUSES",
      reason: `Session "Docs site" does not accept peer messages.`,
      retryable: false,
      sessionID: BETA.id,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a late answer whose asker has gone away is refused, and nothing is delivered", async () => {
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

  test("a disabled plugin asks nothing and says why", async () => {
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      options: { enabled: false },
      sessions: [ALPHA],
    })

    const result = await alpha.host.call("peers", { action: "ask", to: BETA.id, message: "anyone?" })

    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toMatchObject({ delivered: false, code: "E_DISABLED" })

    await alpha.unload()
  })
})

describe("a wait that ends without an answer", () => {
  test("returns the ported timeout text and stays answerable", async () => {
    const { alpha, beta } = await threeDirectories({ alpha: { options: { askTimeoutMs: 60 } } })

    const result = await alpha.host.call("peers", { action: "ask", to: "Docs site", message: "Still there?" })
    const askID = (result.details as { askID: string }).askID

    expect(result.text).toBe(
      `No reply from "Docs site" for message ${askID} within 60ms. Last known delivery state: queue. ` +
        `This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`,
    )
    expect(result.details).toEqual({
      answered: false,
      delivered: true,
      delivery: "queue",
      code: "E_ASK_TIMEOUT",
      reason: result.text,
      retryable: false,
      askID,
      sessionID: BETA.id,
      title: "Docs site",
      directory: "/work/beta",
      status: "idle",
      self: false,
    })
    // The question was delivered and is still in the recipient's hands.
    expect(alpha.host.prompts).toHaveLength(1)

    await unloadAll(alpha, beta)
  })

  test("an answer that arrives afterwards arrives as an ordinary message", async () => {
    const { alpha, beta } = await threeDirectories({ alpha: { options: { askTimeoutMs: 60 } } })

    const result = await alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Late answer test" })
    const askID = (result.details as { askID: string }).askID
    expect((result.details as { code: string }).code).toBe("E_ASK_TIMEOUT")

    const answered = await beta.host.call("peers", { action: "reply", message: "Answering anyway." })
    expect(answered.text).toBe(
      "Reply sent to Payments API (late: the wait for its answer had ended, so it arrived as an ordinary message)",
    )
    expect(answered.details).toEqual({
      delivered: true,
      late: true,
      delivery: "queue",
      askID,
      sessionID: ALPHA.id,
      title: "Payments API",
    })
    // The answer reached the asker's session as a message, not a reply slot.
    expect(beta.host.prompts).toEqual([
      {
        sessionID: ALPHA.id,
        text: [
          `**From Docs site** (/work/beta)`,
          `To reply: peers({ action: "reply", message: "..." })`,
          `_Reply to your question, arriving after the wait for it had ended._`,
          "",
          "Answering anyway.",
        ].join("\n"),
        delivery: "queue",
      },
    ])
    // Answered once: the question cannot be answered again.
    const again = await beta.host.call("peers", { action: "reply", message: "twice" })
    expect(again.text).toBe("No pending ask matches that reply.")
    expect(again.details).toMatchObject({ delivered: false, code: "E_NO_PENDING_ASK" })

    await unloadAll(alpha, beta)
  })

  test("a late answer to a peer that accepts only replies is admitted", async () => {
    const { alpha, beta, storage } = await threeDirectories({ alpha: { options: { trigger: "replies" } } })

    // The asker's wait ended long ago; its instance is gone; nothing is left
    // but the record — exactly the state a live timeout leaves behind.
    const ask = askRecord({ askID: "ask_expired", expiresAt: Date.now() - 1_000, question: "Old question" })
    await storage.set(askKey(ask.askID), ask)
    await settle()

    const answered = await beta.host.call("peers", { action: "reply", message: "An answer after the fact." })
    expect(answered.text).toContain("(late:")
    expect(beta.host.prompts).toHaveLength(1)

    // A plain send to the same session is still refused: the answer was admitted
    // because it is one side of an exchange, not because the policy was ignored.
    const plain = await beta.host.call("peers", { action: "send", to: "Payments API", message: "a plain message" })
    const reason = `Session "Payments API" accepts peer messages only as answers to its own questions, and this is a new message.`
    expect(plain.text).toBe(reason)
    expect(plain.details).toMatchObject({ delivered: false, code: "E_TARGET_REPLIES_ONLY" })

    await unloadAll(alpha, beta)
  })

  test("an interrupted wait returns, and the answer it may still get arrives as a message", async () => {
    const { alpha, beta } = await threeDirectories()
    const call = new AbortController()

    const asking = alpha.host.call(
      "peers",
      { action: "ask", to: BETA.id, message: "Interrupt me" },
      ALPHA.id,
      call.signal,
    )
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    call.abort()
    const result = await asking
    const askID = (result.details as { askID: string }).askID

    expect(result.text).toBe(
      `Waiting for a reply from "Docs site" for message ${askID} was interrupted. ` +
        `The question was delivered; an answer that arrives later will arrive as an ordinary message.`,
    )
    expect(result.details).toEqual({
      answered: false,
      delivered: true,
      delivery: "queue",
      code: "E_ASK_INTERRUPTED",
      reason: result.text,
      askID,
      sessionID: BETA.id,
      title: "Docs site",
      directory: "/work/beta",
      status: "idle",
      self: false,
    })
    // Nobody is waiting on the question any more, so it is not pending here.
    const pending = await beta.host.call("peers", { action: "pending" })
    expect(pending.text).toBe("No unresolved inbound asks.")

    const answered = await beta.host.call("peers", { action: "reply", message: "Answering a stopped wait." })
    expect(answered.text).toContain("(late:")

    await unloadAll(alpha, beta)
  })

  test("the ported timeout text spells whole minutes as minutes", () => {
    expect(
      askTimeoutReason({ target: "Docs site", askID: "ask_1", timeoutMs: 600_000, delivery: "steer" }),
    ).toContain(`No reply from "Docs site" for message ask_1 within 10 minutes.`)
    expect(
      askTimeoutReason({ target: "Docs site", askID: "ask_1", timeoutMs: 60_000, delivery: "queue" }),
    ).toContain("within 1 minute.")
  })
})

describe("pending questions", () => {
  test("lists what is waiting here, oldest first, with a preview a reply can name", async () => {
    const { alpha, beta, gamma } = await threeDirectories()

    const empty = await beta.host.call("peers", { action: "pending" })
    expect(empty.text).toBe("No unresolved inbound asks.")
    expect(empty.details).toEqual({ pending: 0 })

    const fromAlpha = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "First question,\n  with whitespace" })
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
    const asks = (await beta.host.call("peers", { action: "pending" })).details as {
      asks: { askID: string; title: string }[]
    }
    const forGamma = asks.asks.find((ask) => ask.title === "Release notes")!
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
    await storage.set(askKey("ask_theirs"), askRecord({ askID: "ask_theirs", askerSessionID: BETA.id, targetSessionID: ALPHA.id }))
    await settle()

    const named = await alpha.host.call("peers", { action: "cancel", replyTo: "ask_nope" })
    expect(named.text).toBe(`No question with id "ask_nope" is outstanding for this session.`)
    expect(named.details).toMatchObject({ code: "E_NO_ASK_TO_CANCEL" })

    const mine = await alpha.host.call("peers", { action: "cancel", replyTo: "ask_mine" })
    expect(mine.text).toBe("Cancellation requested for ask_mine")

    await unloadAll(alpha, beta)
  })
})
