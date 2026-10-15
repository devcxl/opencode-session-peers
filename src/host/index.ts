/**
 * The host layer's front door.
 *
 * Everything above this directory — the entry point, the tool, the actions —
 * works against `Host`, so the plugin context is read here and nowhere else.
 * `test/boundaries.test.ts` enforces that; `test/fake-host.ts` implements the
 * same port so the entry path can be driven without an opencode process.
 */

import type { Plugin } from "@opencode/plugin"

import type { EventSource } from "./events.ts"
import { sessionLookup, type SessionLookup } from "./session.ts"
import { pluginStorage, type PluginStorage } from "./storage.ts"
import { toolRegistrar, type ToolRegistrar } from "./tools.ts"

/** The location this plugin instance was loaded for: one directory, one project. */
export interface InstanceLocation {
  readonly directory: string
  readonly projectID?: string
}

/** What the plugin may ask of the host it runs inside. */
export interface Host {
  /** Raw plugin options, as configured. `parseConfig` validates them. */
  readonly options: unknown
  readonly location: InstanceLocation
  readonly sessions: SessionLookup
  /** The one namespace every instance on the machine can meet in. */
  readonly storage: PluginStorage
  readonly events: EventSource
  readonly tools: ToolRegistrar
}

export function createHost(context: Plugin.Context): Host {
  return {
    options: context.options,
    location: {
      directory: context.location.directory,
      projectID: context.location.project?.id,
    },
    sessions: sessionLookup(context.session),
    storage: pluginStorage(context.storage),
    events: {
      subscribe: (options) => context.event.subscribe({ signal: options.signal }),
    },
    tools: toolRegistrar(context.tool),
  }
}
