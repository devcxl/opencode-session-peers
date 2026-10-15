/**
 * What an ask does when no answer comes: the timeout, the interrupted wait, and
 * the answer that arrives after either of them — as an ordinary message, since
 * nobody is blocked on the question any more.
 *
 * Seam 2 on the asker's own side: the blocking call returns without an answer,
 * and the question it asked is still answerable. Asking, and being answered,
 * lives in `test/ask.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import { askTimeout } from "../src/domain/errors.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions } from "./fake-host.ts"

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }

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
 * Two locations on one machine, each serving one session, both published so
 * each can address the other. The two-second ask timeout keeps a test that
 * leaves a question waiting bounded.
 */
async function twoDirectories(
  options: { alpha?: FakeHostOptions; beta?: FakeHostOptions } = {},
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

  const instances = [alpha, beta]
  for (const instance of instances) instance.host.emit("session.created", { sessionID: instance.id })
  await settle()
  for (const instance of instances) await instance.host.call("peers", { action: "list" })
  return { alpha, beta, storage }
}

async function unloadAll(...instances: Instance[]): Promise<void> {
  for (const instance of instances) await instance.unload()
}

describe("a wait that ends without an answer", () => {
  test("returns the ported timeout text and leaves the question answerable", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { options: { askTimeoutMs: 60 } } })

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
    const { alpha, beta } = await twoDirectories({ alpha: { options: { askTimeoutMs: 60 } } })

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
    // The answer reached the asker's session as a message, not a reply slot —
    // and an answer ends an exchange rather than opening one, so it carries no
    // reply instruction.
    expect(beta.host.prompts).toEqual([
      {
        sessionID: ALPHA.id,
        text: [
          `**From Docs site** (/work/beta)`,
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

  test("an interrupted wait returns, and the answer it may still get arrives as a message", async () => {
    const { alpha, beta } = await twoDirectories()
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
      askTimeout({ target: "Docs site", askID: "ask_1", timeoutMs: 600_000, delivery: "steer" }).reason,
    ).toContain(`No reply from "Docs site" for message ask_1 within 10 minutes.`)
    expect(
      askTimeout({ target: "Docs site", askID: "ask_1", timeoutMs: 60_000, delivery: "queue" }).reason,
    ).toContain("within 1 minute.")
  })
})
