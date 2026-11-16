/**
 * Deterministic offline stub for the #63 real-host runner.
 *
 * It is not a model and makes no remote call. It reads only the conversation
 * the host sent. Parent and child turns are distinguished by bounded markers;
 * the correction receipt is built from the prompt's own concrete JSON. For the
 * revoke/scope variants it can hold the first correction response until the
 * runner changes a real host fact, bounded and never used for the positive
 * variant.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import {
  CHILD_BEGIN_MARKER,
  CHILD_IDLE_MARKER,
  CORRECTION_PREFIX,
  DUPLICATE_MARKER,
  PARENT_BEGIN_MARKER,
  PARENT_DELEGATE_MARKER,
  PARENT_RECEIPT_MARKER,
  PARENT_SUBAGENT_MARKER,
  PROGRESS_MARKER,
  STUB_DONE_TEXT,
  directiveFields,
  parseCorrectionCall,
  type Scenario,
} from "./protocol.ts"

export interface Watch63StubHandle {
  readonly port: number
  readonly url: string
  readonly controlUrl: string
  readonly requests: readonly string[]
  state(): StubStateView
  stop(): Promise<void>
}

export interface StubStateView {
  readonly waiting: boolean
  readonly released: boolean
  readonly timedOut: boolean
  readonly correctionSeen: number
  readonly latchUsed: boolean
  readonly requests: number
}

interface StubState {
  waiting: boolean
  released: boolean
  timedOut: boolean
  correctionSeen: number
  latchUsed: boolean
  requests: number
  release: (() => void) | undefined
}

interface ChatMessage {
  readonly role?: string
  readonly content?: unknown
}

interface ChatBody {
  readonly model?: string
  readonly stream?: boolean
  readonly messages?: readonly ChatMessage[]
}

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly arguments: string }

const LATCH_TIMEOUT_MS = 20_000

export async function startWatch63Stub(scenario: Scenario): Promise<Watch63StubHandle> {
  const state: StubState = {
    waiting: false,
    released: false,
    timedOut: false,
    correctionSeen: 0,
    latchUsed: false,
    requests: 0,
    release: undefined,
  }
  const requests: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`)
    state.requests += 1
    handle(request, response, scenario, state).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  return {
    port: address.port,
    url,
    controlUrl: `${url}/control`,
    requests,
    state: () => ({
      waiting: state.waiting,
      released: state.released,
      timedOut: state.timedOut,
      correctionSeen: state.correctionSeen,
      latchUsed: state.latchUsed,
      requests: state.requests,
    }),
    async stop() {
      state.release?.()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  scenario: Scenario,
  state: StubState,
): Promise<void> {
  if (request.method === "GET" && request.url === "/control/state") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      waiting: state.waiting,
      released: state.released,
      timedOut: state.timedOut,
      correctionSeen: state.correctionSeen,
      latchUsed: state.latchUsed,
    }))
    return
  }
  if (request.method === "POST" && request.url === "/control/release") {
    release(state)
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ released: true }))
    return
  }
  if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "only POST */chat/completions and the control endpoints" } }))
    return
  }
  let body: ChatBody
  try {
    body = JSON.parse(await readBody(request)) as ChatBody
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: `unreadable body: ${String(error)}` } }))
    return
  }

  if (shouldLatch(body, scenario, state)) {
    state.latchUsed = true
    state.waiting = true
    state.correctionSeen += 1
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.timedOut = true
        state.waiting = false
        resolve()
      }, LATCH_TIMEOUT_MS)
      timer.unref?.()
      state.release = () => {
        clearTimeout(timer)
        state.waiting = false
        resolve()
      }
    })
  } else if (isCorrection(body)) {
    state.correctionSeen += 1
  }

  const reply = planWatch63(body)
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(streamed(reply, body.model ?? "watchdog-63-stub"))
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(json(reply, body.model ?? "watchdog-63-stub")))
}

function release(state: StubState): void {
  state.released = true
  const resolve = state.release
  state.release = undefined
  state.waiting = false
  resolve?.()
}

export function isCorrection(body: ChatBody): boolean {
  const messages = body.messages ?? []
  const lastUser = lastUserIndex(messages)
  return textOf(messages[lastUser]).includes(CORRECTION_PREFIX)
}

export function shouldLatch(body: ChatBody, scenario: Scenario, state: {
  readonly latchUsed: boolean
  readonly released: boolean
}): boolean {
  if (scenario === "positive" || state.latchUsed || state.released) return false
  const messages = body.messages ?? []
  const lastUser = lastUserIndex(messages)
  if (!textOf(messages[lastUser]).includes(CORRECTION_PREFIX)) return false
  return messages.slice(lastUser + 1).every((message) => message.role !== "tool")
}

/** The pure scripted reply. No host, no network, no clock. */
export function planWatch63(body: ChatBody): Reply {
  const messages = body.messages ?? []
  const lastUser = lastUserIndex(messages)
  const userText = textOf(messages[lastUser])
  const after = messages.slice(lastUser + 1)
  const toolText = after.filter((message) => message.role === "tool").map(textOf).join("\n")

  const subagent = directiveFields(userText, PARENT_SUBAGENT_MARKER)
  if (subagent !== undefined) {
    if (toolText.length > 0) return text()
    return tool("subagent", {
      prompt: CHILD_IDLE_MARKER,
      description: "watchdog-63 delegated child",
      agent: "general",
    })
  }

  if (userText.includes(CHILD_IDLE_MARKER)) return text()

  const parentBegin = directiveFields(userText, PARENT_BEGIN_MARKER)
  if (parentBegin !== undefined) {
    if (toolText.length > 0) return text()
    return watchTool({
      operation: "report",
      taskID: parentBegin["taskID"],
      expectedVersion: Number(parentBegin["version"]),
      reportId: parentBegin["reportId"],
      kind: "begin",
      evidence: {},
    })
  }

  const parentDelegate = directiveFields(userText, PARENT_DELEGATE_MARKER)
  if (parentDelegate !== undefined) {
    if (toolText.length > 0) return text()
    return watchTool({
      operation: "delegate",
      taskID: parentDelegate["taskID"],
      expectedVersion: Number(parentDelegate["version"]),
      targetSessionID: parentDelegate["targetSessionID"],
      requestId: parentDelegate["requestId"],
      goal: parentDelegate["goal"],
      mode: "limited-correction",
    })
  }

  const childBegin = directiveFields(userText, CHILD_BEGIN_MARKER)
  if (childBegin !== undefined) {
    if (toolText.length > 0) return text()
    return watchTool({
      operation: "report",
      taskID: childBegin["taskID"],
      expectedVersion: Number(childBegin["version"]),
      reportId: childBegin["reportId"],
      kind: "begin",
      evidence: {},
    })
  }

  const duplicate = directiveFields(userText, DUPLICATE_MARKER)
  if (duplicate !== undefined) {
    if (toolText.length > 0) return text()
    return receiptTool(duplicate)
  }

  const parentReceipt = directiveFields(userText, PARENT_RECEIPT_MARKER)
  if (parentReceipt !== undefined) {
    if (toolText.length > 0) return text()
    return receiptTool(parentReceipt)
  }

  if (userText.includes(CORRECTION_PREFIX)) {
    const prompt = parseCorrectionCall(userText)
    if (prompt === undefined) return text()
    if (toolText.includes("One continue permit")) {
      if (!toolText.includes(PROGRESS_MARKER)) {
        return watchTool({
          operation: "report",
          taskID: prompt.taskID,
          expectedVersion: prompt.stateVersion,
          reportId: "watchdog-63-progress",
          kind: "progress",
          evidence: {
            summary: `${PROGRESS_MARKER}: the delegated child completed the smallest next step`,
            reference: "watchdog-63-child-result",
          },
        })
      }
      return text()
    }
    if (
      toolText.includes("no continue permit") ||
      toolText.includes("already recorded") ||
      toolText.includes("delegation") ||
      toolText.includes("scope")
    ) {
      return text()
    }
    if (toolText.length > 0) return text()
    return watchTool({
      operation: "receipt",
      taskID: prompt.taskID,
      attemptID: prompt.attemptID,
      correlation: prompt.correlation,
    })
  }

  return text()
}

function receiptTool(fields: Record<string, string>): Reply {
  return watchTool({
    operation: "receipt",
    taskID: fields["taskID"],
    attemptID: fields["attemptID"],
    correlation: fields["correlation"],
  })
}

function watchTool(watch: Record<string, unknown>): Reply {
  return tool("peers", { action: "watch", watch })
}

function tool(name: string, input: unknown): Reply {
  return { kind: "tool", name, arguments: JSON.stringify(input) }
}

function text(): Reply {
  return { kind: "text", text: STUB_DONE_TEXT }
}

function lastUserIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return messages.length
}

function textOf(message: ChatMessage | undefined): string {
  if (message === undefined) return ""
  const content = message.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return ""
        const record = part as { text?: unknown }
        return typeof record.text === "string" ? record.text : ""
      })
      .join("\n")
  }
  return ""
}

function json(reply: Reply, model: string): unknown {
  return {
    id: `chatcmpl-watchdog-63-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message:
          reply.kind === "text"
            ? { role: "assistant", content: reply.text }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call-watchdog-63-${crypto.randomUUID()}`,
                    type: "function",
                    function: { name: reply.name, arguments: reply.arguments },
                  },
                ],
              },
        finish_reason: reply.kind === "text" ? "stop" : "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function streamed(reply: Reply, model: string): string {
  const id = `chatcmpl-watchdog-63-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const delta =
    reply.kind === "text"
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call-watchdog-63-${crypto.randomUUID()}`,
              type: "function",
              function: { name: reply.name, arguments: reply.arguments },
            },
          ],
        }
  const finish = reply.kind === "text" ? "stop" : "tool_calls"
  return [
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n")
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}
