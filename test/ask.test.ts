/**
 * Asking a peer, and waiting for the answer.
 *
 * Seam 2: fake hosts that share one storage, standing in for two or three
 * locations of one machine. The ask call is started and *not* awaited — that is
 * what blocking means — and what is asserted is what the model reads on each
 * side, and what the plugin asked the host to hand to which session. The
 * instance that answers is deliberately a different one from the instance that
 * is blocked, because that is the route storage has to carry. The responder's
 * side — who is answering whom — lives in `test/reply.test.ts`; what a wait
 * does when no answer comes lives in `test/ask-wait.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import type { AskRecord } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, type FakeHostOptions } from "./fake-host.ts"
import { fakeStorage, type FakeStorage } from "./fake-storage.ts"

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

describe("a question that is answered", () => {
  test("blocks the asker's call until the peer's instance produces the answer", async () => {
    const { alpha, beta, storage } = await threeDirectories()

    const asking = alpha.host.call("peers", {
      action: "ask",
      to: "Docs site",
      message: "Is the payments API frozen?",
    })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    // The recipient reads the question body: sender, directory, the instruction
    // that answers it, then the question. A question is the one message shape
    // that expects a reply, so it is the one that carries the instruction.
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

  test("leaves the reply instruction out of the question when the option asks it to", async () => {
    const { alpha, beta } = await threeDirectories({
      alpha: { options: { replyHint: false, askTimeoutMs: 2_000 } },
    })

    const asking = alpha.host.call("peers", { action: "ask", to: BETA.id, message: "Answer without a hint?" })
    await waitFor("the question to be delivered", () => alpha.host.prompts.length === 1)

    // The option removes the instruction from the one message that would
    // otherwise carry it; the question itself is unchanged.
    expect(alpha.host.prompts[0]?.text).toBe(
      `**From Payments API** (/work/alpha)\n\nAnswer without a hint?`,
    )

    await beta.host.call("peers", { action: "reply", message: "Answered anyway." })
    expect((await asking).text).toBe("**Reply from Docs site:**\nAnswered anyway.")

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

  test("a peer that declares never is not asked", async () => {
    const { alpha, beta } = await threeDirectories({ beta: { options: { trigger: "never" } } })

    const result = await alpha.host.call("peers", { action: "ask", to: "Docs site", message: "anyone?" })

    const reason = `Session "Docs site" does not accept peer messages.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_REFUSES",
      reason,
      retryable: false,
      sessionID: BETA.id,
    })
    expect(alpha.host.prompts).toEqual([])

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
