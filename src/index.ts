/**
 * The plugin definition.
 *
 * The host accepts a plain `{ id, setup }`, and `Plugin.define` is an identity
 * function, so the object below is the whole runtime contract — importing the
 * plugin package for its `define` would only add a dependency we would have to
 * ship. `satisfies` still checks the object against the host's `Plugin`
 * interface, and every host import here is type-only.
 *
 * `setup` hands the context straight to the host layer and works with the port
 * it returns; this file is wiring, not behaviour.
 */

import type { Plugin } from "@opencode/plugin"

import { parseConfig } from "./config.ts"
import { createHost } from "./host/index.ts"
import { startRoster } from "./peers/roster.ts"
import { peersTool } from "./tool.ts"

export const PLUGIN_ID = "session-peers"

export default {
  id: PLUGIN_ID,

  async setup(context) {
    const host = createHost(context)

    // Options are user input: report what was ignored, once, at load.
    const warn = (message: string) => console.warn(`[${PLUGIN_ID}] ${message}`)
    const { config, warnings } = parseConfig(host.options)
    for (const warning of warnings) warn(warning)

    // A disabled plugin publishes nothing: peers must not see a session that is
    // not listening, and its own session is told why nothing happens.
    const roster = config.enabled ? await startRoster({ config, warn, ...host }) : undefined

    await host.tools.register(peersTool({ config, sessions: host.sessions, roster }))

    // The host calls this when the location shuts down or the plugin reloads.
    if (roster === undefined) return
    return () => roster.dispose()
  },
} satisfies Plugin.Plugin
