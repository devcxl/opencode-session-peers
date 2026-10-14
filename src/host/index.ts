/**
 * The host layer's front door.
 *
 * Everything above this directory — the entry point, the tool, the actions —
 * works against `Host`, so the plugin context is read here and nowhere else.
 * `test/boundaries.test.ts` enforces that; `test/fake-host.ts` implements the
 * same port so the entry path can be driven without an opencode process.
 */

import type { Plugin } from "@opencode/plugin"

import { sessionLookup, type SessionLookup } from "./session.ts"
import { toolRegistrar, type ToolRegistrar } from "./tools.ts"

/** What the plugin may ask of the host it runs inside. */
export interface Host {
  /** Raw plugin options, as configured. `parseConfig` validates them. */
  readonly options: unknown
  readonly sessions: SessionLookup
  readonly tools: ToolRegistrar
}

export function createHost(context: Plugin.Context): Host {
  return {
    options: context.options,
    sessions: sessionLookup(context.session),
    tools: toolRegistrar(context.tool),
  }
}
