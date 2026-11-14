/**
 * Deterministic local model stub for the issue #56 experiments.
 *
 * It speaks the OpenAI chat-completions shape the host's openai-compatible
 * provider uses, on a loopback port only. It is a script, not a model: the
 * answer is a pure function of the request, apart from one deliberate counter
 * used to inject a bounded number of HTTP 500s (to make the host's retry path
 * observable).
 *
 * Directives are written by the research runner into a user message:
 *
 *   WATCHDOG_STUB_TEXT=<token>          final text = <token>
 *   WATCHDOG_STUB_DELAY_MS=<n>          hold the response for n ms
 *   WATCHDOG_STUB_SHELL_SLEEP=<seconds> call the `shell` tool once, then answer
 *   WATCHDOG_STUB_FAIL_FIRST=<n>:<tok>  answer 500 to the first n requests for <tok>
 *   WATCHDOG_STUB_STEER=<tok>           answer DELIVERED/NOT_SEEN depending on
 *                                        whether WATCHDOG_STEER_<tok> is in the
 *                                        conversation
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const DEFAULT_TEXT = "WATCHDOG_STUB_IDLE"
export const SHELL_DONE_TEXT = "WATCHDOG_SHELL_DONE"

export interface StubHandle {
  port: number
  url: string
  requests: readonly string[]
  stop(): Promise<void>
}

interface ChatMessage {
  role?: string
  content?: unknown
}

interface ChatRequest {
  model?: string
  stream?: boolean
  messages?: ReadonlyArray<ChatMessage>
}

type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; name: string; arguments: string }

export async function startResearchStub(): Promise<StubHandle> {
  const requests: string[] = []
  const failures = new Map<string, number>()

  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`)
    handle(request, response, failures).catch((error: unknown) => {
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
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async stop() {
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
  failures: Map<string, number>,
): Promise<void> {
  if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "the stub only answers POST */chat/completions" } }))
    return
  }

  let body: ChatRequest
  try {
    body = JSON.parse(await readBody(request)) as ChatRequest
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: `unreadable request body: ${String(error)}` } }))
    return
  }

  const messages = body.messages ?? []
  const text = messages.map(contentOf).join("\n")

  const failDirective = /WATCHDOG_STUB_FAIL_FIRST=(\d+):(\w+)/.exec(text)
  if (failDirective !== null) {
    const total = Number(failDirective[1])
    const token = failDirective[2]!
    const remaining = failures.get(token) ?? total
    if (remaining > 0) {
      failures.set(token, remaining - 1)
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: `WATCHDOG_STUB_FAILURE ${token} remaining=${remaining - 1}` } }))
      return
    }
  }

  const delay = Number(/WATCHDOG_STUB_DELAY_MS=(\d+)/.exec(text)?.[1] ?? "0")
  if (delay > 0) await sleep(delay)

  const reply = planReply(body)
  if (body.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    response.end(streamedReply(reply, body.model ?? "harness-stub"))
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(jsonReply(reply, body.model ?? "harness-stub")))
}

export function planReply(body: ChatRequest): Reply {
  const messages = body.messages ?? []
  const shellIndex = lastIndexOf(messages, (message) => {
    return message.role === "user" && /WATCHDOG_STUB_SHELL_SLEEP=(\d+)/.test(contentOf(message))
  })
  const shellText = shellIndex < messages.length ? contentOf(messages[shellIndex]!) : ""
  const sleepSeconds = /WATCHDOG_STUB_SHELL_SLEEP=(\d+)/.exec(shellText)?.[1]
  if (sleepSeconds !== undefined) {
    const calledAfter = messages.slice(shellIndex + 1).some((message) => message.role === "tool")
    if (!calledAfter) {
      const seconds = Number(sleepSeconds)
      return {
        kind: "tool-call",
        name: "shell",
        arguments: JSON.stringify({ command: `sleep ${seconds}`, timeout: seconds * 1000 + 10_000 }),
      }
    }
    const steerToken = /WATCHDOG_STUB_STEER=(\w+)/.exec(shellText)?.[1]
    if (steerToken !== undefined) {
      const seen = messages.some(
        (message) => message.role === "user" && contentOf(message).includes(`WATCHDOG_STEER_${steerToken}`),
      )
      return { kind: "text", text: seen ? `WATCHDOG_STEER_DELIVERED_${steerToken}` : `WATCHDOG_STEER_NOT_SEEN_${steerToken}` }
    }
    return { kind: "text", text: SHELL_DONE_TEXT }
  }

  const questionIndex = lastIndexOf(messages, (message) => {
    return message.role === "user" && contentOf(message).includes("WATCHDOG_STUB_QUESTION")
  })
  if (questionIndex < messages.length) {
    const calledAfter = messages.slice(questionIndex + 1).some((message) => message.role === "tool")
    if (!calledAfter) {
      return {
        kind: "tool-call",
        name: "question",
        arguments: JSON.stringify({
          questions: [
            {
              header: "Probe",
              question: "Proceed with the research stub?",
              options: [{ label: "Yes", description: "continue" }, { label: "No", description: "stop" }],
              multiple: false,
            },
          ],
        }),
      }
    }
    return { kind: "text", text: "WATCHDOG_QUESTION_DONE" }
  }

  const lastUser = lastIndexOf(messages, (message) => message.role === "user")
  const turnText = messages.slice(lastUser).map(contentOf).join("\n")
  const steer = /WATCHDOG_STUB_STEER=(\w+)/.exec(turnText)
  if (steer !== null) {
    const token = steer[1]!
    const seen = messages.some(
      (message) => message.role === "user" && contentOf(message).includes(`WATCHDOG_STEER_${token}`),
    )
    return { kind: "text", text: seen ? `WATCHDOG_STEER_DELIVERED_${token}` : `WATCHDOG_STEER_NOT_SEEN_${token}` }
  }

  const token = /WATCHDOG_STUB_TEXT=(\w+)/.exec(turnText)?.[1]
  return { kind: "text", text: token ?? DEFAULT_TEXT }
}

function lastIndexOf<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return index
  }
  return items.length
}

function contentOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : contentText(message.content)
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === "string")
    .join("")
}

function jsonReply(reply: Reply, model: string): unknown {
  return {
    id: "chatcmpl-watchdog-stub",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: messageOf(reply), finish_reason: finishOf(reply) }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function messageOf(reply: Reply): unknown {
  if (reply.kind === "text") return { role: "assistant", content: reply.text }
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_watchdog_stub_1", type: "function", function: { name: reply.name, arguments: reply.arguments } },
    ],
  }
}

function finishOf(reply: Reply): string {
  return reply.kind === "text" ? "stop" : "tool_calls"
}

function streamedReply(reply: Reply, model: string): string {
  const chunk = (delta: unknown, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-watchdog-stub",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  const frames = [chunk({ role: "assistant", content: reply.kind === "text" ? "" : null }, null)]
  if (reply.kind === "text") {
    frames.push(chunk({ content: reply.text }, null))
  } else {
    frames.push(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_watchdog_stub_1",
              type: "function",
              function: { name: reply.name, arguments: "" },
            },
          ],
        },
        null,
      ),
    )
    frames.push(chunk({ tool_calls: [{ index: 0, function: { arguments: reply.arguments } }] }, null))
  }
  frames.push(chunk({}, finishOf(reply)))
  frames.push("data: [DONE]\n\n")
  return frames.join("")
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
