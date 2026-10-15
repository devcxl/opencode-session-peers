/**
 * The offline pass: the stub model, the provider plugin that registers it, and
 * the driving phase that asserts a message crossed directories.
 *
 * The stub is a script, so its answers are checked here directly rather than
 * judged; the driving phase is checked against a fake instance API, so the
 * assertion logic is exercised without booting an opencode process.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageError, drivenModel, parseArgs } from "../scripts/harness/args.ts"
import { createClient, type SessionInfo, type SessionMessage } from "../scripts/harness/client.ts"
import { instanceEnvironment, prepareScratch } from "../scripts/harness/instance.ts"
import {
  STUB_KEY_ENV,
  STUB_MODEL_ID,
  STUB_PLUGIN_SOURCE,
  STUB_PROVIDER_ID,
  STUB_URL_ENV,
  REPO_ROOT,
  scratchLayout,
} from "../scripts/harness/paths.ts"
import { expectationsMet, type Expectation, type SessionSummary } from "../scripts/harness/report.ts"
import { UNANSWERED_QUESTION, type AskPlan } from "../scripts/harness/stub/ask.ts"
import { CROSSING_TOKEN, REPLY_HINT, driveStubPass } from "../scripts/harness/stub/drive.ts"
import {
  LIST_PROMPT,
  STUB_ANSWER_TEXT,
  STUB_IDLE_TEXT,
  STUB_REPLY_DIRECTIVE,
  STUB_SENT_TEXT,
  askPrompt,
  planReply,
  sendPrompt,
  startStubModel,
} from "../scripts/harness/stub/model-server.ts"

const WORK = mkdtempSync(join(tmpdir(), "session-peers-stub-"))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

describe("the stub's script", () => {
  test("a send directive with no tool result yet earns one peers tool call", () => {
    const reply = planReply({ messages: [{ role: "user", content: sendPrompt("harness-b", "TOKEN") }] })
    expect(reply).toEqual({
      kind: "tool-call",
      name: "peers",
      arguments: JSON.stringify({ action: "send", to: "harness-b", message: "TOKEN" }),
    })
  })

  test("the same conversation after the tool result earns the fixed text", () => {
    const messages = [
      { role: "user", content: sendPrompt("harness-b", "TOKEN") },
      { role: "assistant", content: null },
      { role: "tool", content: "Message sent to harness-b" },
    ]
    expect(planReply({ messages })).toEqual({ kind: "text", text: STUB_SENT_TEXT })
  })

  test("a turn with no directive is answered with the idle text", () => {
    expect(planReply({ messages: [{ role: "user", content: "hello" }] })).toEqual({
      kind: "text",
      text: STUB_IDLE_TEXT,
    })
    expect(planReply({ messages: [] })).toEqual({ kind: "text", text: STUB_IDLE_TEXT })
  })

  test("the roster directive earns a list call instead of a send", () => {
    expect(planReply({ messages: [{ role: "user", content: LIST_PROMPT }] })).toEqual({
      kind: "tool-call",
      name: "peers",
      arguments: JSON.stringify({ action: "list" }),
    })
  })

  test("an ask directive earns an ask call carrying its message", () => {
    expect(planReply({ messages: [{ role: "user", content: askPrompt("harness-b", "HARNESS_STUB_REPLY") }] })).toEqual({
      kind: "tool-call",
      name: "peers",
      arguments: JSON.stringify({ action: "ask", to: "harness-b", message: "HARNESS_STUB_REPLY" }),
    })
  })

  test("a question body carrying the reply directive earns a reply call", () => {
    // The peer never sees the asker's prompt; it reads the token the harness
    // wrote into the question body, inside the delivered message.
    const delivered = `**From harness-a** (/scratch/project-a)\nTo reply: peers({ action: "reply", message: "..." })\n\n${STUB_REPLY_DIRECTIVE}`
    expect(planReply({ messages: [{ role: "user", content: delivered }] })).toEqual({
      kind: "tool-call",
      name: "peers",
      arguments: JSON.stringify({ action: "reply", message: STUB_ANSWER_TEXT }),
    })
  })

  test("the ask wins over the reply directive nested in its message", () => {
    // One message carries both markers; the asker's turn must produce the ask,
    // not answer its own question.
    const reply = planReply({ messages: [{ role: "user", content: askPrompt("harness-b", STUB_REPLY_DIRECTIVE) }] })
    expect(reply).toEqual({
      kind: "tool-call",
      name: "peers",
      arguments: JSON.stringify({ action: "ask", to: "harness-b", message: STUB_REPLY_DIRECTIVE }),
    })
  })

  test("the same request always gets the same answer", () => {
    const body = { messages: [{ role: "user", content: sendPrompt("harness-b", "TOKEN") }] }
    expect(planReply(body)).toEqual(planReply(body))
  })

  test("a tool result from an earlier turn does not stop this turn's call", () => {
    // The transcript keeps every turn; only the messages after the last user
    // turn decide, or a second send would be answered as if it were done.
    const messages = [
      { role: "user", content: sendPrompt("harness-b", "FIRST") },
      { role: "assistant", content: null },
      { role: "tool", content: "Message sent to harness-b" },
      { role: "assistant", content: STUB_SENT_TEXT },
      { role: "user", content: sendPrompt("harness-b", "SECOND") },
    ]
    expect(planReply({ messages })).toMatchObject({ kind: "tool-call" })
  })
})

describe("the stub's HTTP shape", () => {
  test("answers both the JSON and the streamed chat-completions request", async () => {
    const stub = await startStubModel()
    try {
      const body = {
        model: "stub",
        messages: [{ role: "user", content: sendPrompt("harness-b", "TOKEN") }],
      }
      const plain = await fetch(`${stub.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(plain.status).toBe(200)
      const completion = (await plain.json()) as {
        object: string
        choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }>
      }
      expect(completion.object).toBe("chat.completion")
      expect(completion.choices[0]!.finish_reason).toBe("tool_calls")
      expect(completion.choices[0]!.message.tool_calls[0]!.function.name).toBe("peers")

      const streamed = await fetch(`${stub.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
      })
      expect(streamed.headers.get("content-type")).toContain("text/event-stream")
      const frames = await streamed.text()
      expect(frames).toContain("chat.completion.chunk")
      expect(frames).toContain("TOKEN")
      expect(frames.trimEnd().endsWith("data: [DONE]")).toBe(true)

      expect(stub.requests).toHaveLength(2)
    } finally {
      await stub.stop()
    }
  })

  test("refuses anything that is not a chat completion", async () => {
    const stub = await startStubModel()
    try {
      const response = await fetch(`${stub.url}/v1/models`)
      expect(response.status).toBe(404)
    } finally {
      await stub.stop()
    }
  })
})

describe("the provider plugin and its environment", () => {
  test("the plugin names the environment variables the harness sets", () => {
    const source = readFileSync(STUB_PLUGIN_SOURCE, "utf8")
    expect(source).toContain(STUB_URL_ENV)
    expect(source).toContain(STUB_KEY_ENV)
    expect(source).toContain(`"${STUB_PROVIDER_ID}"`)
    expect(source).toContain(`"${STUB_MODEL_ID}"`)
  })

  test("the offline environment carries the stub URL and the literal key", () => {
    const layout = scratchLayout("/scratch-root", "stub-env")
    const env = instanceEnvironment(layout, "harness-pw", {}, "http://127.0.0.1:9999/v1")
    expect(env[STUB_URL_ENV]).toBe("http://127.0.0.1:9999/v1")
    expect(env[STUB_KEY_ENV]).toBe("stub")

    const structural = instanceEnvironment(layout, "harness-pw", {})
    expect(structural[STUB_URL_ENV]).toBeUndefined()
    expect(structural[STUB_KEY_ENV]).toBeUndefined()
  })

  test("preparing scratch for the offline pass installs the plugin next to the config", () => {
    const layout = scratchLayout(WORK, "stub-plugin")
    prepareScratch(layout, { plugins: [], stub: true })
    expect(existsSync(layout.stubProvider)).toBe(true)
    expect(readFileSync(layout.stubProvider, "utf8")).toBe(readFileSync(STUB_PLUGIN_SOURCE, "utf8"))

    const plain = scratchLayout(WORK, "stub-plugin-plain")
    prepareScratch(plain, { plugins: [] })
    expect(existsSync(plain.stubProvider)).toBe(false)
  })

  test("a plugin entry with options lands in the project config as the object form", () => {
    const layout = scratchLayout(WORK, "stub-options")
    prepareScratch(layout, {
      plugins: [{ package: "/plugin/under-test", options: { askTimeoutMs: 4242 } }, "/plugin/probe"],
    })
    const written = readFileSync(join(layout.projectA, ".opencode", "opencode.json"), "utf8")
    const parsed = JSON.parse(written) as { plugins: unknown[] }
    expect(parsed.plugins).toEqual([
      { package: "/plugin/under-test", options: { askTimeoutMs: 4242 } },
      "/plugin/probe",
    ])
  })
})

describe("the offline command line", () => {
  test("the stub is test-only, and the package payload says so", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] }
    expect(pkg.files).not.toContain("scripts/")
    expect(pkg.files.some((entry) => entry.startsWith("scripts"))).toBe(false)
  })

  test("--stub opts into the offline pass and names the stub model", () => {
    const options = parseArgs(["--stub"], "/tmp/harness-cwd")
    expect(options.stub).toBe(true)
    expect(options.driveModel).toBe(false)
    expect(drivenModel(options)).toEqual({ providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID })
  })

  test("the structural default drives nothing", () => {
    expect(parseArgs([], "/tmp/harness-cwd").stub).toBe(false)
    expect(drivenModel(parseArgs([], "/tmp/harness-cwd"))).toBeUndefined()
    expect(drivenModel(parseArgs(["--model", "fake/model"], "/tmp/harness-cwd"))).toEqual({
      providerID: "fake",
      id: "model",
    })
  })

  test("--stub contradicts the other two modes", () => {
    expect(() => parseArgs(["--stub", "--model", "fake/model"], "/tmp/harness-cwd")).toThrow(UsageError)
    expect(() => parseArgs(["--stub", "--no-model"], "/tmp/harness-cwd")).toThrow(UsageError)
  })
})

interface FakeSession {
  id: string
  directory: string
  title: string
  messages: SessionMessage[]
}

const BEGIN = { created: 0, updated: 0 }

function sessionInfo(session: FakeSession): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    time: BEGIN,
    location: { directory: session.directory },
    outcome: "succeeded",
  }
}

/**
 * A fake instance that answers a scripted turn the way the stub plus the real
 * plugin would: a roster ask returns a roster naming both sessions, a send
 * returns a delivered tool result and writes the message into the peer, and an
 * ask returns the timeout text or the peer's answer, each with the host's own
 * record of the wait. The `hint` flag writes a reply instruction into the
 * peer's copy of a plain send, standing in for a plugin that still appends one
 * to a message that opens no ask.
 */
function fakeInstance(deliver: boolean, hint: boolean, plan: AskPlan) {
  const sessions = new Map<string, FakeSession>([
    ["ses_a", { id: "ses_a", directory: "/scratch/project-a", title: "harness-a", messages: [] }],
    ["ses_b", { id: "ses_b", directory: "/scratch/project-b", title: "harness-b", messages: [] }],
  ])
  const peer = sessions.get("ses_b")!

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const json = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 })
    if (url.pathname === "/api/model") return json([{ providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID }])

    const match = /^\/api\/session\/([^/]+)(\/prompt|\/context)?$/.exec(url.pathname)
    if (match === null) throw new Error(`the fake instance does not serve ${url.pathname}`)
    const session = sessions.get(match[1]!)
    if (session === undefined) throw new Error(`no such session ${match[1]}`)

    if (url.pathname.endsWith("/prompt")) {
      const text = (JSON.parse(String(init?.body)) as { text: string }).text
      session.messages.push({ id: "msg_user", type: "user", text })
      if (text === LIST_PROMPT) {
        session.messages.push(toolMessage({ action: "list" }, "harness-a (ses_a) … harness-b (ses_b)", {}))
      } else if (text === askPrompt("harness-b", UNANSWERED_QUESTION)) {
        session.messages.push(
          toolMessage(
            { action: "ask", to: "harness-b", message: UNANSWERED_QUESTION },
            `No reply from "harness-b" for message ask-1 within ${plan.timeoutMs}ms. Last known delivery state: queue. ` +
              "This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.",
            { answered: false, code: "E_ASK_TIMEOUT" },
            { ran: 1_000_000, completed: 1_000_000 + plan.timeoutMs },
          ),
        )
        peer.messages.push({ id: "msg_question", type: "user", text: `**From harness-a**\n\n${UNANSWERED_QUESTION}` })
      } else if (text === askPrompt("harness-b", STUB_REPLY_DIRECTIVE)) {
        session.messages.push(
          toolMessage(
            { action: "ask", to: "harness-b", message: STUB_REPLY_DIRECTIVE },
            `**Reply from harness-b:**\n${STUB_ANSWER_TEXT}`,
            { answered: true },
            { ran: 2_000_000, completed: 2_000_100 },
          ),
        )
        peer.messages.push(
          toolMessage({ action: "reply", message: STUB_ANSWER_TEXT }, "Reply sent to harness-a", { delivered: true }),
        )
      } else {
        const sentText = deliver ? "Message sent to harness-b" : 'Session "harness-b" is not connected.'
        session.messages.push(
          toolMessage({ action: "send", to: "harness-b", message: CROSSING_TOKEN }, sentText, { delivered: deliver }),
        )
        if (deliver) {
          peer.messages.push({
            id: "msg_peer",
            type: "user",
            text: hint ? `${CROSSING_TOKEN}\n\n${REPLY_HINT}` : CROSSING_TOKEN,
          })
        }
      }
      return json(sessionInfo(session))
    }
    if (url.pathname.endsWith("/context")) return json(session.messages)
    return json(sessionInfo(session))
  }

  return createClient("http://instance.invalid", "fake-password", fetchImpl as typeof fetch)
}

function toolMessage(
  input: unknown,
  text: string,
  metadata: Readonly<Record<string, unknown>>,
  time?: { ran: number; completed: number },
): SessionMessage {
  return {
    id: "msg_tool",
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "peers",
        state: { status: "completed", input, content: [{ type: "text", text }], metadata },
        ...(time === undefined ? {} : { time }),
      },
    ],
  }
}

function summaries(): SessionSummary[] {
  return [
    { label: "A", id: "ses_a", directory: "/scratch/project-a", title: "harness-a", messages: [] },
    { label: "B", id: "ses_b", directory: "/scratch/project-b", title: "harness-b", messages: [] },
  ]
}

/** A fast stand-in for the plan the instance is booted with; the pass itself never waits here. */
const FAKE_PLAN: AskPlan = { timeoutMs: 1_000 }

async function run(deliver: boolean, hint = false) {
  const expectations: Expectation[] = []
  const disclosures: string[] = []
  const result = await driveStubPass(
    fakeInstance(deliver, hint, FAKE_PLAN),
    parseArgs(["--stub"], "/tmp/harness-cwd"),
    summaries(),
    expectations,
    disclosures,
    FAKE_PLAN,
  ).then(
    (value) => value,
    (error: Error) => error,
  )
  return { result, expectations, disclosures }
}

describe("the offline driving phase", () => {
  test("a delivered send is asserted in the peer's own directory", async () => {
    const { result, expectations, disclosures } = await run(true)
    expect(result).not.toBeInstanceOf(Error)
    const byName = new Map(expectations.map((expectation) => [expectation.name, expectation]))
    expect(byName.get("peers-visible")!.met).toBe(true)
    expect(byName.get("message-delivered")!.met).toBe(true)
    const crossed = byName.get("message-crossed-directories")!
    expect(crossed.met).toBe(true)
    expect(crossed.observed).toContain("/scratch/project-b")
    expect(crossed.observed).toContain("/scratch/project-a")
    expect(byName.get("send-carries-no-reply-hint")!.met).toBe(true)
    // The ask phases run in the same pass: the unanswered ask timed out and
    // the answered one came back with the peer's words.
    expect(byName.get("ask-timeout-returned")!.met).toBe(true)
    expect(byName.get("ask-timeout-elapsed")!.met).toBe(true)
    expect(byName.get("ask-question-arrived")!.met).toBe(true)
    expect(byName.get("ask-answered-returned")!.met).toBe(true)
    expect(byName.get("ask-peer-replied")!.met).toBe(true)
    expect(expectationsMet(expectations)).toBe(true)
    expect(disclosures.join(" ")).toContain("no hosted model and no credential were involved")
    expect(disclosures.join(" ")).toContain("askTimeoutMs 1000 ms")
  })

  test("a delivered body that still tells the receiver to reply fails the pass", async () => {
    const { result, expectations } = await run(true, true)
    expect(result).not.toBeInstanceOf(Error)
    const byName = new Map(expectations.map((expectation) => [expectation.name, expectation]))
    expect(byName.get("message-crossed-directories")!.met).toBe(true)
    const hint = byName.get("send-carries-no-reply-hint")!
    expect(hint.met).toBe(false)
    expect(hint.observed).toContain("a send opens no ask to answer")
    expect(expectationsMet(expectations)).toBe(false)
  })

  test("an undelivered send fails the pass with the tool's own words", async () => {
    const { result, expectations, disclosures } = await run(false)
    expect(result).toBeInstanceOf(Error)
    const byName = new Map(expectations.map((expectation) => [expectation.name, expectation]))
    expect(byName.get("message-delivered")!.met).toBe(false)
    expect(byName.get("message-delivered")!.observed).toContain("not connected")
    // The crossing is never claimed, and nothing pretends the message moved.
    expect(byName.has("message-crossed-directories")).toBe(false)
    expect(disclosures).toHaveLength(0)
  })
})
