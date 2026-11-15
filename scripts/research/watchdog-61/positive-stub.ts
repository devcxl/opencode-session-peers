/**
 * Deterministic stub for the #61 real-host positive protocol.
 *
 * It is not a model and makes no remote call. It reads only the conversation
 * the host sent. The receipt call is built from the correction prompt's own
 * concrete JSON; the runner never injects the correlation into the tool call.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const BEGIN_MARKER = "WATCH61_BEGIN"
export const DUPLICATE_MARKER = "WATCH61_DUPLICATE"
export const WRONG_CALLER_MARKER = "WATCH61_WRONG_CALLER"

export const STUB_DONE_TEXT = "WATCH61_POSITIVE_DONE"

export interface PositiveStubHandle {
  readonly port: number
  readonly url: string
  readonly requests: readonly string[]
  stop(): Promise<void>
}

interface ChatMessage {
  readonly role?: string
  readonly content?: unknown
}

interface ChatRequest {
  readonly model?: string
  readonly stream?: boolean
  readonly messages?: readonly ChatMessage[]
}

type Reply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly arguments: string }

export async function startPositiveStub(): Promise<PositiveStubHandle> {
  const requests: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method ?? "?"} ${request.url ?? "?"}`)
    handle(request, response).catch((error: unknown) => {
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

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "only POST */chat/completions" } }))
    return
  }
  let body: ChatRequest
  try {
    body = JSON.parse(await readBody(request)) as ChatRequest
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: `unreadable body: ${String(error)}` } }))
    return
  }
  const reply = plan(body)
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.end(streamed(reply, body.model ?? "harness-stub"))
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(json(reply, body.model ?? "harness-stub")))
}

export function plan(body: ChatRequest): Reply {
  const messages = body.messages ?? []
  const lastUser = lastUserIndex(messages)
  const userText = textOf(messages[lastUser])
  const after = messages.slice(lastUser + 1)
  const toolText = after.filter((message) => message.role === "tool").map(textOf).join("\n")

  const begin = beginDirective(userText)
  if (begin !== undefined) {
    if (toolText.length > 0) return { kind: "text", text: STUB_DONE_TEXT }
    return tool({
      action: "watch",
      watch: {
        operation: "report",
        taskID: begin.taskID,
        expectedVersion: begin.version,
        reportId: begin.reportId,
        kind: "begin",
        evidence: {},
      },
    })
  }

  const duplicate = duplicateDirective(userText)
  if (duplicate !== undefined) {
    if (toolText.length > 0) return { kind: "text", text: STUB_DONE_TEXT }
    return tool({
      action: "watch",
      watch: {
        operation: "receipt",
        taskID: duplicate.taskID,
        attemptID: duplicate.attemptID,
        correlation: duplicate.correlation,
      },
    })
  }

  const wrong = wrongCallerDirective(userText)
  if (wrong !== undefined) {
    if (toolText.length > 0) return { kind: "text", text: STUB_DONE_TEXT }
    return tool({
      action: "watch",
      watch: {
        operation: "receipt",
        taskID: wrong.taskID,
        attemptID: wrong.attemptID,
        correlation: wrong.correlation,
      },
    })
  }

  if (userText.includes("[session-peers correction]")) {
    const prompt = correctionPrompt(userText)
    if (prompt === undefined) return { kind: "text", text: STUB_DONE_TEXT }
    if (toolText.includes("One continue permit")) {
      if (!toolText.includes("WATCH61_PROGRESS")) {
        return tool({
          action: "watch",
          watch: {
            operation: "report",
            taskID: prompt.taskID,
            expectedVersion: prompt.stateVersion,
            reportId: "positive-progress",
            kind: "progress",
            evidence: {
              summary: "WATCH61_PROGRESS: the target completed the smallest next step",
              reference: "new-host-result",
            },
          },
        })
      }
      return { kind: "text", text: STUB_DONE_TEXT }
    }
    if (toolText.includes("no continue permit") || toolText.includes("already recorded")) {
      return { kind: "text", text: STUB_DONE_TEXT }
    }
    if (toolText.length > 0) return { kind: "text", text: STUB_DONE_TEXT }
    return tool({ action: "watch", watch: { operation: "receipt", taskID: prompt.taskID, attemptID: prompt.attemptID, correlation: prompt.correlation } })
  }

  return { kind: "text", text: STUB_DONE_TEXT }
}

interface BeginDirective {
  readonly taskID: string
  readonly version: number
  readonly reportId: string
}

function beginDirective(text: string): BeginDirective | undefined {
  if (!text.includes(BEGIN_MARKER)) return undefined
  const taskID = /(?:^|\s)taskID=(\S+)/.exec(text)?.[1]
  const version = Number(/(?:^|\s)version=(\d+)/.exec(text)?.[1])
  const reportId = /(?:^|\s)reportId=(\S+)/.exec(text)?.[1]
  if (taskID === undefined || !Number.isSafeInteger(version) || reportId === undefined) return undefined
  return { taskID, version, reportId }
}

interface ReceiptDirective {
  readonly taskID: string
  readonly attemptID: string
  readonly correlation: string
}

function duplicateDirective(text: string): ReceiptDirective | undefined {
  return addressed(text, DUPLICATE_MARKER)
}

function wrongCallerDirective(text: string): ReceiptDirective | undefined {
  return addressed(text, WRONG_CALLER_MARKER)
}

function addressed(text: string, marker: string): ReceiptDirective | undefined {
  if (!text.includes(marker)) return undefined
  const taskID = /(?:^|\s)taskID=(\S+)/.exec(text)?.[1]
  const attemptID = /(?:^|\s)attemptID=(\S+)/.exec(text)?.[1]
  const correlation = /(?:^|\s)correlation=(\S+)/.exec(text)?.[1]
  if (taskID === undefined || attemptID === undefined || correlation === undefined) return undefined
  return { taskID, attemptID, correlation }
}

interface CorrectionPrompt {
  readonly taskID: string
  readonly attemptID: string
  readonly correlation: string
  readonly stateVersion: number
}

function correctionPrompt(text: string): CorrectionPrompt | undefined {
  const parsed = /peers\((\{.*\})\)/.exec(text)?.[1]
  if (parsed === undefined) return undefined
  try {
    const call = JSON.parse(parsed) as { watch?: { taskID?: string; attemptID?: string; correlation?: string } }
    const version = Number(/task state version after reservation: (\d+)/.exec(text)?.[1])
    if (
      call.watch?.taskID === undefined ||
      call.watch.attemptID === undefined ||
      call.watch.correlation === undefined ||
      !Number.isSafeInteger(version)
    ) {
      return undefined
    }
    return {
      taskID: call.watch.taskID,
      attemptID: call.watch.attemptID,
      correlation: call.watch.correlation,
      stateVersion: version,
    }
  } catch {
    return undefined
  }
}

function tool(input: unknown): Reply {
  return { kind: "tool", name: "peers", arguments: JSON.stringify(input) }
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
  if (!Array.isArray(content)) return ""
  return content.map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined)).filter((value): value is string => typeof value === "string").join("")
}

function json(reply: Reply, model: string): unknown {
  const message =
    reply.kind === "text"
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_watch61", type: "function", function: { name: reply.name, arguments: reply.arguments } }],
        }
  return {
    id: "chatcmpl-watch61",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function streamed(reply: Reply, model: string): string {
  const message = json(reply, model) as { choices: Array<{ message: unknown }> }
  const chunk = {
    id: "chatcmpl-watch61",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: message.choices[0]?.message, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}
