/**
 * Tool registration.
 *
 * opencode takes one synchronous transform over a tool editor, and a tool with
 * `codemode: false` is exposed to the model directly (ADR-0003). The adapter
 * turns our tool spec — text for the model, details for the host — into the
 * host's result shape, so no other file has to know it.
 */

import type { Plugin } from "@opencode/plugin"

import type { ActionResult, SessionID } from "../domain/types.ts"

/** One tool call, as the host reports it. */
export interface ToolCall {
  /** The session that invoked the tool. */
  readonly sessionID: SessionID
  /** Cancelled when the invoking turn is interrupted. */
  readonly signal: AbortSignal
}

/** A tool as this plugin defines it. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** Plain JSON Schema; the host hands it to the model as written. */
  readonly input: Readonly<Record<string, unknown>>
  readonly handle: (input: unknown, call: ToolCall) => Promise<ActionResult>
}

export interface ToolRegistrar {
  register(spec: ToolSpec): Promise<void>
}

export function toolRegistrar(tool: Pick<Plugin.Context["tool"], "transform">): ToolRegistrar {
  return {
    async register(spec) {
      await tool.transform((editor) => {
        editor.add({
          name: spec.name,
          description: spec.description,
          input: spec.input,
          options: { codemode: false },
          async execute(input, call) {
            const result = await spec.handle(input, { sessionID: call.sessionID, signal: call.signal })
            return {
              content: [{ type: "text" as const, text: result.text }],
              metadata: result.details,
            }
          },
        })
      })
    },
  }
}
