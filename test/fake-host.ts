/**
 * A fake opencode plugin context.
 *
 * `Plugin.Context` is a large, branded surface; the plugin's entry point reads
 * seven of its members. The fake implements exactly those, so a test can call
 * `setup`, drive the registered tool the way the host would, emit events into
 * the subscription, and inspect the storage the plugin wrote.
 *
 * Two fakes can share one `FakeStorage`, which is how the tests stand in for two
 * locations of one machine: the host's storage is shared per plugin id, while
 * everything else is per instance.
 *
 * It also pins the one host quirk this build ran into: a tool result whose
 * metadata holds an `undefined` value is never delivered (see `rejectUndefined`).
 *
 * The assertions live in the tests; this file knows nothing about the plugin's
 * internals.
 */

import type { Plugin } from "@opencode/plugin"

import type { HostEvent } from "../src/host/events.ts"
import { pluginStorage, type PluginStorage } from "../src/host/storage.ts"

/** The session a tool call comes from, unless a test says otherwise. */
export const CALLER_SESSION_ID = "ses_fake_caller"

type ToolTransform = Plugin.Context["tool"]["transform"]
type ToolEditor = Parameters<Parameters<ToolTransform>[0]>[0]
type ToolInfo = Parameters<ToolEditor["add"]>[0]
type ToolCall = Parameters<ToolInfo["execute"]>[1]
type ToolResult = Awaited<ReturnType<ToolInfo["execute"]>>

type SkillTransform = Plugin.Context["skill"]["transform"]
type SkillEditor = Parameters<Parameters<SkillTransform>[0]>[0]

/** A session as the fake host knows it. Everything else has a default. */
export interface FakeSession {
  readonly id: string
  readonly title?: string
  /** Defaults to this host's location: sessions live where their instance does. */
  readonly directory?: string
  readonly parentID?: string
  readonly model?: string
  /** The tool calls this session's transcript shows, oldest first. */
  readonly toolCalls?: readonly FakeToolCall[]
}

/**
 * One tool call in a session's transcript, as the host reports it. Only name and
 * status are posed: measured on opencode 2.0.29, a running call's input holds no
 * child session id and its metadata stays empty, which is all the parked rule
 * could read either way.
 */
export interface FakeToolCall {
  readonly name: string
  readonly status?: string
}

/** One skill the plugin registered with the host. */
export interface FakeSkill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly path: string
  readonly content: string
}

export interface FakeScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

/** One message the plugin asked the host to hand to a session. */
export interface FakePrompt {
  readonly sessionID: string
  readonly text: string
  readonly delivery: string
}

/** One generation the plugin asked this session's own model to write. */
export interface FakeGeneration {
  readonly sessionID: string
  readonly prompt: string
}

/** One version control lookup the plugin made for a directory. */
export interface FakeVcsLookup {
  readonly directory: string
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

/**
 * The shared storage seen through the plugin's own adapter.
 *
 * The fake keeps values as `unknown` on purpose — it must not quietly mirror the
 * host's JSON type to look more like the host than it is — while the adapter
 * takes that JSON type. The conversion belongs here, next to the fake, rather
 * than in every test that seeds or inspects the namespace.
 */
export function fakePluginStorage(raw: FakeStorage): PluginStorage {
  return pluginStorage(raw as unknown as Parameters<typeof pluginStorage>[0])
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
  /** Sessions this fake host refuses to hand a message to, as the real one does for a session it no longer has. */
  readonly promptRefuses?: readonly string[]
  /** Sessions whose transcript this fake host cannot read, as the real one does not know a gone session. */
  readonly contextRefuses?: readonly string[]
  /** What this session's own model answers with; a throwable answer stands in for the host failing the request. */
  readonly generate?: string | Error
  /** The branch this host knows for a directory; a lookup for anything else is a directory with no repository. */
  readonly vcsBranch?: Readonly<Record<string, string>>
}

export interface FakeHost {
  /** The context handed to the plugin's `setup`. */
  readonly context: Plugin.Context
  /** Session ids the plugin looked up, in order. */
  readonly lookups: readonly string[]
  /** Sessions whose transcript the plugin asked to read, in order. */
  readonly transcriptReads: readonly string[]
  /** Messages the plugin asked the host to hand to a session, in order. */
  readonly prompts: readonly FakePrompt[]
  /** Generations the plugin asked this session's own model for, in order. */
  readonly generations: readonly FakeGeneration[]
  /** Version control lookups the plugin made, in order. */
  readonly vcsLookups: readonly FakeVcsLookup[]
  /** Tools the plugin registered, in order. */
  readonly tools: readonly ToolInfo[]
  /** Skills the plugin registered, in order. */
  readonly skills: readonly FakeSkill[]
  /** The storage the plugin wrote to; the same object the host was given. */
  readonly storage: FakeStorage
  /** Delivers an event to the plugin's subscription, as the host would. */
  emit(type: string, data: Readonly<Record<string, unknown>>): void
  /** Live event subscriptions; zero once the plugin has unsubscribed. */
  subscribers(): number
  /**
   * Invoke a registered tool, and report what the model would receive. The
   * signal is the tool call's own: aborting it stands in for the turn being
   * interrupted while the call is still running.
   */
  call(
    name: string,
    input: unknown,
    sessionID?: string,
    signal?: AbortSignal,
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
  const transcriptReads: string[] = []
  const prompts: FakePrompt[] = []
  const generations: FakeGeneration[] = []
  const vcsLookups: FakeVcsLookup[] = []
  const tools: ToolInfo[] = []
  const skills: FakeSkill[] = []
  const refused = new Set(options.promptRefuses ?? [])
  const unreadable = new Set(options.contextRefuses ?? [])
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

  const skillEditor: SkillEditor = {
    list: () => [],
    get: () => undefined,
    add: (skill) => {
      skills.push(skill as unknown as FakeSkill)
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
      prompt: async (input: {
        readonly sessionID: string
        readonly text: string
        readonly delivery?: string
      }) => {
        // The host refuses a session it no longer has, and refuses it loudly:
        // the plugin must report that, not treat it as delivered.
        if (refused.has(input.sessionID)) throw new Error("Session.NotFoundError")
        const delivery = input.delivery ?? "steer"
        prompts.push({ sessionID: input.sessionID, text: input.text, delivery })
        return {
          id: `msg_fake_${prompts.length}`,
          sessionID: input.sessionID,
          time: { created: Date.now() },
          type: "user",
          payload: { text: input.text },
          delivery,
        }
      },
      context: async (input: { readonly sessionID: string }) => {
        transcriptReads.push(input.sessionID)
        if (unreadable.has(input.sessionID)) throw new Error("Session.NotFoundError")
        const session = known.get(input.sessionID)
        if (session === undefined) throw new Error("Session.NotFoundError")
        return transcript(session)
      },
      generate: async (input: { readonly sessionID: string; readonly prompt: string }) => {
        generations.push({ sessionID: input.sessionID, prompt: input.prompt })
        // A refused request rejects, as the host's does when the model cannot be
        // reached; the plugin must report that instead of sending nothing.
        if (options.generate instanceof Error) throw options.generate
        return {
          id: `gen_fake_${generations.length}`,
          sessionID: input.sessionID,
          time: { created: Date.now() },
          type: "user",
          payload: { text: input.prompt },
          delivery: "queue",
          text: options.generate ?? "",
        }
      },
    },
    vcs: {
      get: async (input?: { readonly location?: { readonly directory?: string } }) => {
        const directory = input?.location?.directory ?? location
        vcsLookups.push({ directory })
        const branch = options.vcsBranch?.[directory]
        return {
          location: { directory },
          // A directory this host knows no repository for has no branch to
          // report, which is what the real surface does for a plain directory.
          data: branch === undefined ? { branch: {} } : { provider: "git", branch: { current: branch } },
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
    skill: {
      transform: async (edit: (editor: SkillEditor) => void) => {
        edit(skillEditor)
        return { dispose: async () => {} }
      },
    },
  }

  return {
    // The fake implements the members the plugin uses; the cast is where a fake
    // stops pretending to be the whole host.
    context: context as unknown as Plugin.Context,
    lookups,
    transcriptReads,
    prompts,
    generations,
    vcsLookups,
    tools,
    skills,
    storage,
    emit(type, data) {
      eventCounter += 1
      const event = { id: `evt_fake_${eventCounter}`, created: Date.now(), type, data }
      for (const subscription of [...subscriptions]) subscription.push(event as unknown as HostEvent)
    },
    subscribers: () => subscriptions.size,
    async call(name, input, sessionID = caller, signal) {
      const tool = tools.find((candidate) => candidate.name === name)
      if (tool === undefined) throw new Error(`No tool named "${name}" is registered`)
      const result = await tool.execute(input, toolCall(sessionID, signal))
      rejectUndefined(result.metadata, "metadata")
      return { text: textOf(result), details: result.metadata }
    },
  }
}

/**
 * opencode 2.0.29 never delivers a tool result whose metadata holds an
 * `undefined` value: the call stays running and the model sees no output. The
 * fake refuses one loudly instead, so the belief is pinned where CI can see it.
 */
function rejectUndefined(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`Tool result ${path} is undefined, which the host would drop`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUndefined(item, `${path}[${index}]`))
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) rejectUndefined(entry, `${path}.${key}`)
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
function toolCall(sessionID: string, signal?: AbortSignal): ToolCall {
  return {
    sessionID,
    agent: "build",
    messageID: "msg_fake",
    id: "tool_fake",
    signal: signal ?? new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolCall
}

/**
 * A session's transcript as the host reports it: one assistant message holding
 * the session's tool calls, each part carrying the state the host keeps for it.
 * The parked-parent probe reads exactly this.
 */
function transcript(session: Partial<FakeSession>): unknown[] {
  const calls = session.toolCalls ?? []
  if (calls.length === 0) return []
  return [
    {
      id: "msg_fake_transcript",
      type: "assistant",
      time: { created: Date.now() },
      content: calls.map((call, index) => ({
        type: "tool",
        id: `call_fake_${index}`,
        name: call.name,
        state: { status: call.status ?? "completed", input: {}, metadata: {} },
      })),
    },
  ]
}

/** Flatten a tool result to the text the model reads. */
function textOf(result: ToolResult): string {
  const content = result.content
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.map((part) => (part.type === "text" ? part.text : "")).join("")
}
