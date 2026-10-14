/**
 * A fake opencode plugin context.
 *
 * `Plugin.Context` is a large, branded surface; the plugin's entry point reads
 * six of its members. The fake implements exactly those, so a test can call
 * `setup`, drive the registered tool the way the host would, emit events into
 * the subscription, and inspect the storage the plugin wrote.
 *
 * Two fakes can share one `FakeStorage`, which is how the tests stand in for two
 * locations of one machine: the host's storage is shared per plugin id, while
 * everything else is per instance.
 *
 * The assertions live in the tests; this file knows nothing about the plugin's
 * internals.
 */

import type { Plugin } from "@opencode/plugin"

import type { HostEvent } from "../src/host/events.ts"

/** The session a tool call comes from, unless a test says otherwise. */
export const CALLER_SESSION_ID = "ses_fake_caller"

type ToolTransform = Plugin.Context["tool"]["transform"]
type ToolEditor = Parameters<Parameters<ToolTransform>[0]>[0]
type ToolInfo = Parameters<ToolEditor["add"]>[0]
type ToolCall = Parameters<ToolInfo["execute"]>[1]
type ToolResult = Awaited<ReturnType<ToolInfo["execute"]>>

/** A session as the fake host knows it. Everything else has a default. */
export interface FakeSession {
  readonly id: string
  readonly title?: string
  /** Defaults to this host's location: sessions live where their instance does. */
  readonly directory?: string
  readonly parentID?: string
  readonly model?: string
}

export interface FakeScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface FakeStorage {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: FakeScanOptions) => Promise<{
    readonly entries: readonly { readonly key: string; readonly value: unknown }[]
    readonly next?: string
  }>
  /** Every stored value, in key order: what the plugin asked the host to keep. */
  values(): readonly unknown[]
}

/** One scan page. The real host may page; the fake always does, so nothing can rely on a single page. */
const SCAN_PAGE = 2

export function fakeStorage(): FakeStorage {
  const entries = new Map<string, unknown>()

  return {
    async get(key) {
      return entries.get(key)
    },
    async set(key, value) {
      entries.set(key, value)
    },
    async remove(key) {
      entries.delete(key)
    },
    async scan(options) {
      const matching = [...entries.keys()]
        .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
        .sort()
      const page = matching.slice(0, options.limit ?? SCAN_PAGE)
      const next = matching.length > page.length ? page[page.length - 1] : undefined
      return {
        entries: page.map((key) => ({ key, value: entries.get(key) })),
        ...(next === undefined ? {} : { next }),
      }
    },
    values() {
      return [...entries.keys()].sort().map((key) => entries.get(key))
    },
  }
}

export interface FakeHostOptions {
  /** Raw plugin options, as the host would pass them. */
  readonly options?: unknown
  /** The directory this instance was loaded for. */
  readonly location?: string
  /** Sessions this fake host knows; a lookup for anything else fails as the host's does. */
  readonly sessions?: readonly (string | FakeSession)[]
  /** Shared namespace; pass the same storage to two hosts to make them one machine. */
  readonly storage?: FakeStorage
  /** The session tool calls come from, unless a call names another. */
  readonly caller?: string
}

export interface FakeHost {
  /** The context handed to the plugin's `setup`. */
  readonly context: Plugin.Context
  /** Session ids the plugin looked up, in order. */
  readonly lookups: readonly string[]
  /** Tools the plugin registered, in order. */
  readonly tools: readonly ToolInfo[]
  /** The storage the plugin wrote to; the same object the host was given. */
  readonly storage: FakeStorage
  /** Delivers an event to the plugin's subscription, as the host would. */
  emit(type: string, data: Readonly<Record<string, unknown>>): void
  /** Live event subscriptions; zero once the plugin has unsubscribed. */
  subscribers(): number
  /** Invoke a registered tool, and report what the model would receive. */
  call(
    name: string,
    input: unknown,
    sessionID?: string,
  ): Promise<{ readonly text: string; readonly details: unknown }>
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const location = options.location ?? "/tmp/opencode/fake"
  const caller = options.caller ?? CALLER_SESSION_ID
  const storage = options.storage ?? fakeStorage()
  const known = new Map(
    (options.sessions ?? [caller]).map((session) =>
      typeof session === "string" ? [session, {} as Partial<FakeSession>] : [session.id, session],
    ),
  )
  const lookups: string[] = []
  const tools: ToolInfo[] = []
  const subscriptions = new Set<FakeSubscription>()
  let eventCounter = 0

  const editor: ToolEditor = {
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    add: (tool) => {
      tools.push(tool)
    },
    update: () => {},
    remove: () => {},
  }

  const context = {
    options: options.options ?? {},
    location: { directory: location, project: { id: "proj_fake" } },
    session: {
      get: async (input: { readonly sessionID: string }) => {
        lookups.push(input.sessionID)
        const session = known.get(input.sessionID)
        if (session === undefined) throw new Error("Session.NotFoundError")
        return {
          id: input.sessionID,
          title: session.title ?? "fake session",
          projectID: "proj_fake",
          location: { directory: session.directory ?? location },
          ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
          ...(session.model === undefined ? {} : { model: { id: session.model, providerID: "fake" } }),
        }
      },
    },
    storage,
    event: {
      subscribe: (subscribeOptions: { readonly signal?: AbortSignal }) => {
        const subscription = new FakeSubscription()
        subscriptions.add(subscription)
        const onAbort = () => {
          subscriptions.delete(subscription)
          subscription.close()
        }
        if (subscribeOptions.signal?.aborted === true) onAbort()
        else subscribeOptions.signal?.addEventListener("abort", onAbort, { once: true })
        return subscription
      },
    },
    tool: {
      transform: async (edit: (editor: ToolEditor) => void) => {
        edit(editor)
        return { dispose: async () => {} }
      },
    },
  }

  return {
    // The fake implements the members the plugin uses; the cast is where a fake
    // stops pretending to be the whole host.
    context: context as unknown as Plugin.Context,
    lookups,
    tools,
    storage,
    emit(type, data) {
      eventCounter += 1
      const event = { id: `evt_fake_${eventCounter}`, created: Date.now(), type, data }
      for (const subscription of [...subscriptions]) subscription.push(event as unknown as HostEvent)
    },
    subscribers: () => subscriptions.size,
    async call(name, input, sessionID = caller) {
      const tool = tools.find((candidate) => candidate.name === name)
      if (tool === undefined) throw new Error(`No tool named "${name}" is registered`)
      const result = await tool.execute(input, toolCall(sessionID))
      return { text: textOf(result), details: result.metadata }
    },
  }
}

/** One live subscription: an async iterable the test pushes events into. */
class FakeSubscription implements AsyncIterable<HostEvent> {
  private readonly queue: HostEvent[] = []
  private wake: (() => void) | undefined
  private closed = false

  push(event: HostEvent): void {
    this.queue.push(event)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  [Symbol.asyncIterator](): AsyncIterator<HostEvent> {
    return this
  }

  async next(): Promise<IteratorResult<HostEvent>> {
    for (;;) {
      const event = this.queue.shift()
      if (event !== undefined) return { done: false, value: event }
      if (this.closed) return { done: true, value: undefined }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}

/** The host's tool call context; only `sessionID` and `signal` are ours to read. */
function toolCall(sessionID: string): ToolCall {
  return {
    sessionID,
    agent: "build",
    messageID: "msg_fake",
    id: "tool_fake",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolCall
}

/** Flatten a tool result to the text the model reads. */
function textOf(result: ToolResult): string {
  const content = result.content
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.map((part) => (part.type === "text" ? part.text : "")).join("")
}
