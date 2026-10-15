/**
 * The ask phases against a scripted instance API.
 *
 * The phases are the assertion logic the offline pass leans on, so they are
 * exercised here without booting anything: the timeout path, the answered path,
 * and the ways the pass must fail — the call comes back with some other
 * timeout, with no time spent inside it, or never comes back at all. The real
 * chain is covered by `bun run harness --stub`.
 */

import { describe, expect, test } from "bun:test"
import { type HarnessOptions, parseArgs } from "../scripts/harness/args.ts"
import { createClient, type SessionMessage, type SessionToolPart } from "../scripts/harness/client.ts"
import type { Expectation, SessionSummary } from "../scripts/harness/report.ts"
import { UNANSWERED_QUESTION, driveAskPass, type AskPlan } from "../scripts/harness/stub/ask.ts"
import { STUB_ANSWER_TEXT, STUB_REPLY_DIRECTIVE, askPrompt } from "../scripts/harness/stub/model-server.ts"

const CWD = "/tmp/harness-cwd"

const ASKER: SessionSummary = {
  label: "A",
  id: "ses_a",
  directory: "/scratch/project-a",
  title: "harness-a",
  messages: [],
}

const PEER: SessionSummary = {
  label: "B",
  id: "ses_b",
  directory: "/scratch/project-b",
  title: "harness-b",
  messages: [],
}

/** One scripted turn: the exact prompt it answers, and what the turn leaves behind. */
interface Turn {
  prompt: string
  messages: SessionMessage[]
}

/** The timeout text the plugin writes, as the host would record it. */
function timeoutText(within: string): string {
  return (
    `No reply from "harness-b" for message ask-1 within ${within}. Last known delivery state: queue. ` +
    "This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session."
  )
}

function toolCall(
  input: unknown,
  text: string,
  metadata: Readonly<Record<string, unknown>>,
  time?: { ran: number; completed: number },
): SessionMessage {
  const part: SessionToolPart = {
    type: "tool",
    name: "peers",
    state: { status: "completed", input, content: [{ type: "text", text }], metadata },
    ...(time === undefined ? {} : { time }),
  }
  return { id: "msg_tool", type: "assistant", content: [part] }
}

function userMessage(text: string): SessionMessage {
  return { id: "msg_user", type: "user", text }
}

/**
 * The smallest instance API the phases use: a transcript per session, and a
 * queue of scripted turns per session. A prompt with no queued turn is a test
 * bug, not a silent no-op.
 */
function fakeInstance(initial: Record<string, SessionMessage[]>, script: Record<string, Turn[]>) {
  const sessions = new Map<string, SessionMessage[]>([
    ["ses_a", []],
    ["ses_b", []],
    ...Object.entries(initial).map(([id, messages]): [string, SessionMessage[]] => [id, [...messages]]),
  ])
  const queued = new Map<string, Turn[]>(Object.entries(script).map(([id, turns]) => [id, [...turns]]))

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const json = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 })
    const match = /^\/api\/session\/([^/]+)(\/prompt|\/context)?$/.exec(url.pathname)
    if (match === null) throw new Error(`the fake instance does not serve ${url.pathname}`)

    const id = match[1]!
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`no such session ${id}`)

    if (url.pathname.endsWith("/prompt")) {
      const text = (JSON.parse(String(init?.body)) as { text: string }).text
      session.push(userMessage(text))
      const turns = queued.get(id) ?? []
      const index = turns.findIndex((turn) => turn.prompt === text)
      if (index === -1) throw new Error(`the fake instance has no turn for ${id}: ${text}`)
      session.push(...turns.splice(index, 1)[0]!.messages)
      return json(session)
    }
    return json(session)
  }

  return createClient("http://instance.invalid", "fake-password", fetchImpl as typeof fetch)
}

/** The host's record of a wait; `null` makes the transcript carry none. */
type Timings = { ran: number; completed: number } | null

/** The record a run under this plan would leave: the whole configured wait. */
function timingsFor(plan: AskPlan): { ran: number; completed: number } {
  return { ran: 1_000_000, completed: 1_000_000 + plan.timeoutMs }
}

/** The two turns the phases ask for, with the timeout result under test. */
function askScript(plan: AskPlan, within: string, hostTimings: Timings): Record<string, Turn[]> {
  const recorded = hostTimings === null ? undefined : hostTimings
  return {
    ses_a: [
      {
        prompt: askPrompt("harness-b", UNANSWERED_QUESTION),
        messages: [
          toolCall(
            { action: "ask", to: "harness-b", message: UNANSWERED_QUESTION },
            timeoutText(within),
            { answered: false, code: "E_ASK_TIMEOUT" },
            recorded,
          ),
        ],
      },
      {
        prompt: askPrompt("harness-b", STUB_REPLY_DIRECTIVE),
        messages: [
          toolCall(
            { action: "ask", to: "harness-b", message: STUB_REPLY_DIRECTIVE },
            `**Reply from harness-b:**\n${STUB_ANSWER_TEXT}`,
            { answered: true },
            { ran: 2_000_000, completed: 2_000_100 },
          ),
        ],
      },
    ],
  }
}

/** What the peer's own transcript already holds: the question, and its reply call. */
function peerTranscript(): SessionMessage[] {
  return [
    userMessage(`**From harness-a** (/scratch/project-a)\nTo reply: peers({ action: "reply", message: "..." })\n\n${UNANSWERED_QUESTION}`),
    toolCall({ action: "reply", message: STUB_ANSWER_TEXT }, "Reply sent to harness-a", { delivered: true }),
  ]
}

async function runAsk(input: {
  plan: AskPlan
  within: string
  hostTimings?: Timings
  options?: HarnessOptions
  initial?: Record<string, SessionMessage[]>
  script?: Record<string, Turn[]>
}) {
  const expectations: Expectation[] = []
  const options = input.options ?? parseArgs(["--stub"], CWD)
  const hostTimings = input.hostTimings === undefined ? timingsFor(input.plan) : input.hostTimings
  const script = input.script ?? askScript(input.plan, input.within, hostTimings)
  const client = fakeInstance(input.initial ?? { ses_b: peerTranscript() }, script)
  const error = await driveAskPass(client, options, ASKER, PEER, expectations, input.plan).then(
    () => undefined,
    (thrown: Error) => thrown,
  )
  const byName = new Map(expectations.map((expectation) => [expectation.name, expectation]))
  return { error, byName }
}

describe("the ask phases", () => {
  test("a timeout that used the configured timeout passes both assertions", async () => {
    const { error, byName } = await runAsk({ plan: { timeoutMs: 1_000 }, within: "1000ms" })

    expect(error).toBeUndefined()
    expect(byName.get("ask-timeout-returned")!.met).toBe(true)
    expect(byName.get("ask-timeout-returned")!.observed).toContain("within 1000ms")
    expect(byName.get("ask-timeout-elapsed")!.met).toBe(true)
    expect(byName.get("ask-timeout-elapsed")!.observed).toContain("1000 ms from the host's own ran to completed")
    expect(byName.get("ask-question-arrived")!.met).toBe(true)
  })

  test("a timeout that used the ten-minute default fails both assertions", async () => {
    const { error, byName } = await runAsk({
      plan: { timeoutMs: 1_000 },
      within: "10 minutes",
      hostTimings: { ran: 1_000_000, completed: 1_600_000 },
    })

    expect(error).toBeUndefined()
    expect(byName.get("ask-timeout-returned")!.met).toBe(false)
    expect(byName.get("ask-timeout-elapsed")!.met).toBe(false)
    expect(byName.get("ask-timeout-elapsed")!.observed).toContain("600000 ms")
    // The question still arrived: a failed wait is not a failed delivery.
    expect(byName.get("ask-question-arrived")!.met).toBe(true)
  })

  test("a timeout text returned with no time spent inside the call fails the measurement", async () => {
    // No host timings: the fallback is the wall clock, and the fake returned
    // the timeout text instantly, which no real wait can do.
    const { error, byName } = await runAsk({ plan: { timeoutMs: 1_000 }, within: "1000ms", hostTimings: null })
    expect(error).toBeUndefined()
    expect(byName.get("ask-timeout-elapsed")!.met).toBe(false)
    expect(byName.get("ask-timeout-elapsed")!.observed).toContain("wall clock around the prompt")
  })

  test("the answered ask returns the peer's words from the peer's own reply call", async () => {
    const { error, byName } = await runAsk({ plan: { timeoutMs: 1_000 }, within: "1000ms" })
    expect(error).toBeUndefined()
    expect(byName.get("ask-answered-returned")!.met).toBe(true)
    expect(byName.get("ask-answered-returned")!.observed).toContain(STUB_ANSWER_TEXT)
    expect(byName.get("ask-peer-replied")!.met).toBe(true)
    expect(byName.get("ask-peer-replied")!.observed).toContain("Reply sent to harness-a")
  })

  test("a call that never stops running fails the pass naming the state it stalled in", async () => {
    const running: SessionToolPart = {
      type: "tool",
      name: "peers",
      state: { status: "running", input: { action: "ask", to: "harness-b", message: UNANSWERED_QUESTION } },
    }
    const { error, byName } = await runAsk({
      plan: { timeoutMs: 1_000 },
      within: "1000ms",
      options: parseArgs(["--stub", "--turn-timeout-ms", "300"], CWD),
      script: { ses_a: [{ prompt: askPrompt("harness-b", UNANSWERED_QUESTION), messages: [{ id: "m", type: "assistant", content: [running] }] }] },
    })

    expect(error).toBeInstanceOf(Error)
    expect(byName.get("ask-timeout-returned")!.met).toBe(false)
    expect(byName.get("ask-timeout-returned")!.observed).toContain("reached no terminal state")
    // Nothing is claimed about a result that never came, and the answered phase
    // never ran: the pass stopped where the chain did.
    expect(byName.has("ask-timeout-elapsed")).toBe(false)
    expect(byName.has("ask-answered-returned")).toBe(false)
  })

  test("a turn that produces no call at all fails the same way", async () => {
    const { error, byName } = await runAsk({
      plan: { timeoutMs: 1_000 },
      within: "1000ms",
      options: parseArgs(["--stub", "--turn-timeout-ms", "300"], CWD),
      script: { ses_a: [{ prompt: askPrompt("harness-b", UNANSWERED_QUESTION), messages: [] }] },
    })

    expect(error).toBeInstanceOf(Error)
    expect(byName.get("ask-timeout-returned")!.met).toBe(false)
    expect(byName.get("ask-timeout-returned")!.observed).toContain("reached no terminal state")
  })
})
