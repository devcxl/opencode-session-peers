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
import { describeError } from "./domain/errors.ts"
import { createHost } from "./host/index.ts"
import { startRoster } from "./peers/roster.ts"
import { SESSION_PEERS_RPC } from "./rpc.ts"
import { SUPERVISOR_SKILL } from "./skill.ts"
import { rosterPayload } from "./surface.ts"
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

    // The RPC surface is registered either way, because a disabled location
    // answering `enabled: false` is what lets a reader tell "off here" from
    // "not loaded here". It is the plugin's public surface for other plugins:
    // versioned, and documented in `src/rpc.ts`.
    const surface = await host.rpc.register(SESSION_PEERS_RPC, {
      roster: () => rosterPayload({ config, roster }),
    })

    await host.tools.register(
      peersTool({
        config,
        sessions: host.sessions,
        storage: host.storage,
        roster,
        warn,
        handover: {
          generation: host.generation,
          versionControl: host.versionControl,
          senderDirectory: host.location.directory,
        },
      }),
    )

    // A disabled plugin does nothing and describes nothing: its sessions are told
    // why their calls are refused, not how to use a channel that is off.
    if (roster === undefined) return () => surface.dispose()

    // Whoever reads the roster is told when a fresh read would say something
    // else; the event carries no value, because the snapshot is the truth.
    roster.observe(() => {
      void surface
        .emit("changed", { at: Date.now() })
        .catch((error) => warn(`could not announce a roster change: ${describeError(error)}`))
    })

    // The supervisor channel's parent-side text (ADR-0002) is a skill, not part
    // of the tool description: a parent reads it while deciding how to spawn a
    // child, which is before any tool of this plugin is in play.
    await host.skills.register(SUPERVISOR_SKILL)

    // The host calls this when the location shuts down or the plugin reloads.
    return async () => {
      await surface.dispose()
      await roster.dispose()
    }
  },
} satisfies Plugin.Plugin
