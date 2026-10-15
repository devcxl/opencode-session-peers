/**
 * The stub model the harness drives its offline pass through.
 *
 * It is not a model: it is a script that answers the OpenAI chat-completions
 * shape the host's openai-compatible provider speaks. The answer is a pure
 * function of the request, so two runs of the pass see the same turn:
 *
 *   - a conversation whose last user turn carries a directive and has no tool
 *     result yet gets exactly one tool call: `peers` with action "send", "ask"
 *     or "list", or "reply" for the directive a peer reads in a question;
 *   - the same conversation after the tool result, or any conversation without
 *     a directive, gets a fixed final text.
 *
 * The directive is text the harness itself writes — into the prompt it sends,
 * or into the question the peer receives — which keeps the script's input the
 * only thing that decides the output.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** Marks the prompt whose turn must call `peers` with `send`; written by the harness. */
export const STUB_SEND_DIRECTIVE = "HARNESS_STUB_SEND"

/** Marks the prompt whose turn must call `peers` with `ask`; written by the harness. */
export const STUB_ASK_DIRECTIVE = "HARNESS_STUB_ASK"

/**
 * Marks the question a peer must answer. The harness writes it as the ask's
 * message, so the peer never sees the prompt the asker was given: it reads the
 * token where a reader would, inside the delivered question, and replies.
 */
export const STUB_REPLY_DIRECTIVE = "HARNESS_STUB_REPLY"

/** Marks a prompt whose turn must ask `peers` for the roster instead. */
export const STUB_LIST_DIRECTIVE = "HARNESS_STUB_LIST"

/** The answer the peer's reply carries; the asker's result must show it. */
export const STUB_ANSWER_TEXT = "HARNESS_OFFLINE_ANSWER_OK"

/** The answer the stub gives once the tool result has come back. */
export const STUB_SENT_TEXT = "HARNESS_STUB_SENT"

/** The answer the stub gives to any turn it was not scripted for. */
export const STUB_IDLE_TEXT = "HARNESS_STUB_IDLE"

export interface StubHandle {
  port: number
  url: string
  /** Every request path the stub was asked for, in order; the tests assert on it. */
  requests: readonly string[]
  stop(): Promise<void>
}

export async function startStubModel(): Promise<StubHandle> {
  const hostname = "127.0.0.1"
  const requests: string[] = []

  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`)
    handle(request, response).catch((error: unknown) => {
      // A stub that cannot answer is a failed turn, not a hang: drop the
      // connection so the host reports the turn as an error.
      response.destroy(error instanceof Error ? error : undefined)
    })
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
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // The host may be holding an idle keep-alive connection; closing the
        // listener alone would leave the port bound until it goes away.
        server.closeAllConnections()
      })
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

  if (directive !== undefined && !calledInTurn) return toolCallFor(directive)
  if (directive !== undefined) return { kind: "text", text: STUB_SENT_TEXT }
  return { kind: "text", text: STUB_IDLE_TEXT }
}

function toolCallFor(directive: Directive): Reply {
  switch (directive.kind) {
    case "list":
      return { kind: "tool-call", name: "peers", arguments: JSON.stringify({ action: "list" }) }
    case "send":
      return {
        kind: "tool-call",
        name: "peers",
        arguments: JSON.stringify({ action: "send", to: directive.to, message: directive.message }),
      }
    case "ask":
      return {
        kind: "tool-call",
        name: "peers",
        arguments: JSON.stringify({ action: "ask", to: directive.to, message: directive.message }),
      }
    case "reply":
      // No `to` and no `replyTo`: the peer holds one question, and answering it
      // is what the delivered message asked for.
      return {
        kind: "tool-call",
        name: "peers",
        arguments: JSON.stringify({ action: "reply", message: STUB_ANSWER_TEXT }),
      }
  }
}

/** The prompt that makes A's turn call `peers({ action: "send" })`. */
export function sendPrompt(to: string, message: string): string {
  return `${STUB_SEND_DIRECTIVE} to=${to} message=${message}`
}

/** The prompt that makes the asker's turn call `peers({ action: "ask" })`. */
export function askPrompt(to: string, message: string): string {
  return `${STUB_ASK_DIRECTIVE} to=${to} message=${message}`
}

/** The prompt that makes a session's turn call `peers({ action: "list" })`. */
export const LIST_PROMPT = STUB_LIST_DIRECTIVE

function lastIndexOf<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!)) return index
  }
  return items.length
}

/**
 * The directive the harness wrote into this message, if it is there.
 *
 * The markers are read in a fixed order because one directive can nest inside
 * another: an ask whose message is the reply directive carries both, and the
 * asker's turn must produce the ask. The `to` and `message` that follow a
 * marker are read as single whitespace-free words: the harness chooses the
 * titles and the token, so it can keep the directive line that simple.
 */
function directiveOf(message: ChatMessage): Directive | undefined {
  if (message.role !== "user") return undefined
  const text = contentOf(message)
  if (text.includes(STUB_LIST_DIRECTIVE)) return { kind: "list" }

  const asked = addressed(text, STUB_ASK_DIRECTIVE)
  if (asked !== undefined) return { kind: "ask", ...asked }
  if (text.includes(STUB_REPLY_DIRECTIVE)) return { kind: "reply" }

  const sent = addressed(text, STUB_SEND_DIRECTIVE)
  return sent === undefined ? undefined : { kind: "send", ...sent }
}

/** The `to` and `message` written after a marker, if both are there. */
function addressed(text: string, marker: string): { to: string; message: string } | undefined {
  const start = text.indexOf(marker)
  if (start === -1) return undefined

  const rest = text.slice(start + marker.length)
  const to = /(?:^|\s)to=(\S+)/.exec(rest)?.[1]
  const message = /(?:^|\s)message=(\S+)/.exec(rest)?.[1]
  return to === undefined || message === undefined ? undefined : { to, message }
}

type Directive =
  | { kind: "list" }
  | { kind: "send"; to: string; message: string }
  | { kind: "ask"; to: string; message: string }
  | { kind: "reply" }

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
