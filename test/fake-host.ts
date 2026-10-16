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

/** One event the plugin pushed through an RPC registration. */
export interface FakeRpcEvent {
  readonly name: string
  readonly data: Readonly<Record<string, unknown>>
}

/** One RPC surface the plugin registered. */
export interface FakeRpc {
  /** The id the plugin registered under, as clients address it. */
  readonly id: string
  readonly methods: readonly string[]
  /** Events pushed, in order; one subscription sees all of them. */
  readonly events: readonly FakeRpcEvent[]
  /** True once the plugin disposed the registration, as it does when unloaded. */
  readonly disposed: boolean
  /**
   * Invokes one method the way the host does, and checks the answer against the
   * method's own output schema before handing it back — a client would never
   * see a value the schema rejects.
   */
  call(method: string, input?: unknown): Promise<unknown>
}

/** One scan page. The real host may page; the fake always does, so nothing can rely on a single page. */
const SCAN_PAGE = 2

/** A portable definition, as much of it as the fake needs. */
interface FakeRpcDefinition {
  readonly id: string
  readonly methods: Readonly<Record<string, { readonly input: unknown; readonly output: unknown }>>
  readonly events: Readonly<Record<string, { readonly schema: unknown }>>
}

type FakeRpcHandlers = Readonly<Record<string, ((input: unknown) => Promise<unknown>) | undefined>>

interface FakeRpcRecord {
  readonly definition: FakeRpcDefinition
  readonly handlers: FakeRpcHandlers
  readonly events: FakeRpcEvent[]
  disposed: boolean
}

/** The one JSON Schema node shape the plugin's own definitions use. */
interface SchemaNode {
  readonly type?: string | readonly string[]
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: SchemaNode
}

/**
 * The subset of JSON Schema the host validates portable definitions with, as
 * far as this project's definitions exercise it: types (including a union with
 * `null`), `properties`, `required`, `additionalProperties: false` and `items`.
 * A value that fails here is a value the real host would refuse to deliver, so
 * the fake refuses it too.
 */
function checkSchema(value: unknown, schema: unknown, path: string): void {
  const node = schema as SchemaNode | undefined
  if (node === undefined || node === null || typeof node !== "object") return

  const types =
    node.type === undefined ? undefined : Array.isArray(node.type) ? node.type : [node.type]
  if (types !== undefined && !types.some((type) => matchesType(value, type))) {
    throw new Error(`${path} is ${typeof value}, which ${types.join(" | ")} does not allow`)
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) checkSchema(entry, node.items, `${path}[${index}]`)
    return
  }
  if (typeof value !== "object" || value === null) return

  const properties = node.properties ?? {}
  for (const name of node.required ?? []) {
    if (!(name in value)) throw new Error(`${path}.${name} is required by the schema`)
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) {
      // JSON transport drops an undefined property, so a client would receive
      // something other than what the handler returned.
      throw new Error(`${path}.${name} is undefined, which cannot survive the transport`)
    }
    const property = properties[name]
    if (property === undefined) {
      if (node.additionalProperties === false) {
        throw new Error(`${path}.${name} is not allowed by the schema`)
      }
      continue
    }
    checkSchema(entry, property, `${path}.${name}`)
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null
    case "array":
      return Array.isArray(value)
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    default:
      return typeof value === type
  }
}

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
  /** RPC surfaces the plugin registered, in order. */
  readonly rpcs: readonly FakeRpc[]
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
  const rpcs: FakeRpcRecord[] = []
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
    rpc: {
      // The real host keeps one registration per definition id and answers
      // calls at the location it was registered for; the fake keeps them all
      // and lets a test call one the way the host would.
      register: async (
        definition: FakeRpcDefinition,
        handlers: FakeRpcHandlers,
      ): Promise<{ events: { emit: (name: string, data: Readonly<Record<string, unknown>>) => Promise<void> }; dispose: () => Promise<void> }> => {
        const record: FakeRpcRecord = { definition, handlers, events: [], disposed: false }
        rpcs.push(record)
        return {
          events: {
            async emit(name, data) {
              const schema = definition.events[name]?.schema
              // A name the definition does not declare is a bug in the plugin,
              // and the real host refuses it rather than dropping it.
              if (schema === undefined) {
                throw new Error(`No RPC event named "${name}" on ${definition.id}`)
              }
              checkSchema(data, schema, `${definition.id}.${name}`)
              record.events.push({ name, data })
            },
          },
          async dispose() {
            record.disposed = true
          },
        }
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
    get rpcs(): readonly FakeRpc[] {
      // Built on read: the plugin registers during `setup`, after the fake was.
      return rpcs.map((record) => ({
        get id() {
          return record.definition.id
        },
        get methods() {
          return Object.keys(record.definition.methods)
        },
        get events() {
          return record.events
        },
        get disposed() {
          return record.disposed
        },
        async call(method, input) {
          const definition = record.definition.methods[method]
          if (definition === undefined) {
            throw new Error(`No RPC method named "${method}" on ${record.definition.id}`)
          }
          // The host validates both sides against the portable schemas; a value
          // a client would never receive must not pass for one here either.
          checkSchema(input ?? {}, definition.input, `${record.definition.id}.${method} input`)
          const output = await record.handlers[method]?.(input)
          checkSchema(output, definition.output, `${record.definition.id}.${method} output`)
          return output
        },
      }))
    },
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
