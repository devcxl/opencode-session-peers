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
import { peersTool } from "./tool.ts"

export const PLUGIN_ID = "session-peers"

export default {
  id: PLUGIN_ID,

  async setup(context) {
    const host = createHost(context)

    // Options are user input: report what was ignored, once, at load.
    const { config, warnings } = parseConfig(host.options)
    for (const warning of warnings) console.warn(`[${PLUGIN_ID}] ${warning}`)

    await host.tools.register(peersTool({ config, sessions: host.sessions }))
  },
} satisfies Plugin.Plugin
