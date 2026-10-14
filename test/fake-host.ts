/**
 * A fake opencode plugin context.
 *
 * `Plugin.Context` is a large, branded surface; the plugin's entry point reads
 * three of its members. The fake implements exactly those, so a test can call
 * `setup` and then invoke the registered tool the way the host would, and see
 * what the plugin asked for. The assertions live in `entry.test.ts`; this file
 * knows nothing about the plugin's internals.
 */

import type { Plugin } from "@opencode/plugin"

/** The session a tool call comes from, unless a test says otherwise. */
export const CALLER_SESSION_ID = "ses_fake_caller"

type ToolTransform = Plugin.Context["tool"]["transform"]
type ToolEditor = Parameters<Parameters<ToolTransform>[0]>[0]
type ToolInfo = Parameters<ToolEditor["add"]>[0]
type ToolCall = Parameters<ToolInfo["execute"]>[1]
type ToolResult = Awaited<ReturnType<ToolInfo["execute"]>>

export interface FakeHostOptions {
  /** Raw plugin options, as the host would pass them. */
  readonly options?: unknown
  /** Sessions this fake host knows; a lookup for anything else fails as the host's does. */
  readonly sessions?: readonly string[]
}

export interface FakeHost {
  /** The context handed to the plugin's `setup`. */
  readonly context: Plugin.Context
  /** Session ids the plugin looked up, in order. */
  readonly lookups: readonly string[]
  /** Tools the plugin registered, in order. */
  readonly tools: readonly ToolInfo[]
  /** Invoke a registered tool, and report what the model would receive. */
  call(name: string, input: unknown): Promise<{ readonly text: string; readonly details: unknown }>
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const known = new Set(options.sessions ?? [CALLER_SESSION_ID])
  const lookups: string[] = []
  const tools: ToolInfo[] = []

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
    session: {
      get: async (input: { readonly sessionID: string }) => {
        lookups.push(input.sessionID)
        if (!known.has(input.sessionID)) throw new Error("Session.NotFoundError")
        return {
          id: input.sessionID,
          title: "fake session",
          location: { directory: "/tmp/opencode/fake" },
        }
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
    async call(name, input) {
      const tool = tools.find((candidate) => candidate.name === name)
      if (tool === undefined) throw new Error(`No tool named "${name}" is registered`)
      const result = await tool.execute(input, toolCall())
      return { text: textOf(result), details: result.metadata }
    },
  }
}

/** The host's tool call context; only `sessionID` and `signal` are ours to read. */
function toolCall(): ToolCall {
  return {
    sessionID: CALLER_SESSION_ID,
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
