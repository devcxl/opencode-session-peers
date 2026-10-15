/**
 * The stub model the harness drives its offline pass through.
 *
 * It is not a model: it is a script that answers the OpenAI chat-completions
 * shape the host's openai-compatible provider speaks. The answer is a pure
 * function of the request, so two runs of the pass see the same turn:
 *
 *   - a conversation that carries the harness's directive and no tool result
 *     yet gets one tool call: `peers` with action "send";
 *   - the same conversation after the tool result, or any conversation without
 *     the directive, gets a fixed final text.
 *
 * The directive is a line of the prompt the harness itself writes, which keeps
 * the script's input the only thing that decides the output.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** Marks the prompt whose turn must call `peers`; written by the harness. */
export const STUB_DIRECTIVE = "HARNESS_STUB_SEND"

/** The answer the stub gives once the tool result has come back. */
export const STUB_SENT_TEXT = "HARNESS_STUB_SENT"

/** The answer the stub gives to any turn it was not scripted for. */
export const STUB_IDLE_TEXT = "HARNESS_STUB_IDLE"

export interface StubHandle {
  port: number
  url: string
  /** Every request path the stub was asked for, in order; evidence for a report. */
  requests: readonly string[]
  stop(): Promise<void>
}

export interface StartStubOptions {
  hostname?: string
}

export async function startStubModel(options: StartStubOptions = {}): Promise<StubHandle> {
  const hostname = options.hostname ?? "127.0.0.1"
  const requests: string[] = []

  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`)
    void handle(request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    port: address.port,
    url: `http://${hostname}:${address.port}`,
    requests,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; name: string; arguments: string }

interface ChatRequest {
  model?: string
  stream?: boolean
  messages?: ReadonlyArray<ChatMessage>
}

interface ChatMessage {
  role?: string
  content?: unknown
}

/**
 * The script. Deterministic by construction: it reads the directive from the
 * messages and whether a tool result is already in the conversation, and
 * nothing else.
 */
export function planReply(body: ChatRequest): Reply {
  const messages = body.messages ?? []
  const lastUser = lastIndexOf(messages, (message) => message.role === "user")
  const directive = messages.slice(lastUser).map(directiveOf).find((value) => value !== undefined)
  // The tool result for the last user turn is what makes the next call final,
  // so the stub answers one tool call per turn and cannot loop on itself.
  const calledInTurn = messages
    .slice(lastUser)
    .some((message) => message.role === "tool")

  if (directive !== undefined && !calledInTurn) {
    return directive.kind === "list"
      ? { kind: "tool-call", name: "peers", arguments: JSON.stringify({ action: "list" }) }
      : {
          kind: "tool-call",
          name: "peers",
          arguments: JSON.stringify({ action: "send", to: directive.to, message: directive.message }),
        }
  }
  if (directive !== undefined) return { kind: "text", text: STUB_SENT_TEXT }
  return { kind: "text", text: STUB_IDLE_TEXT }
}

function lastIndexOf<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return index
  }
  return items.length
}

/** The `to` and `message` the harness wrote into the prompt, if it is there. */
function directiveOf(message: ChatMessage): Directive | undefined {
  if (message.role !== "user") return undefined
  const text = contentOf(message)
  if (text.includes("HARNESS_STUB_LIST")) return { kind: "list" }
  const start = text.indexOf(STUB_DIRECTIVE)
  if (start === -1) return undefined

  const rest = text.slice(start + STUB_DIRECTIVE.length)
  const to = /(?:^|\s)to=(\S+)/.exec(rest)?.[1]
  const sent = /(?:^|\s)message=(\S+)/.exec(rest)?.[1]
  return to === undefined || sent === undefined ? undefined : { kind: "send", to, message: sent }
}

type Directive = { kind: "list" } | { kind: "send"; to: string; message: string }

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
    id: "chatcmpl-harness-stub",
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
      { id: "call_harness_stub_1", type: "function", function: { name: reply.name, arguments: reply.arguments } },
    ],
  }
}

function finishOf(reply: Reply): string {
  return reply.kind === "text" ? "stop" : "tool_calls"
}

/** The same answer as an SSE stream, which is how a chat client asks by default. */
function streamedReply(reply: Reply, model: string): string {
  const chunk = (delta: unknown, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-harness-stub",
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
              id: "call_harness_stub_1",
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
