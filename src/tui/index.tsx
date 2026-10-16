/** @jsxImportSource @opentui/solid */

/**
 * The TUI entrypoint: the package's `./tui` export.
 *
 * A TUI plugin is loaded beside the server plugin of the same package (one
 * version constrains both sides), and it renders in the host's
 * `sidebar.content` slot. Everything the host knows is read through
 * `host/tui.ts`; this file is wiring, not behaviour.
 */

import type { Plugin } from "@opencode/plugin/tui"

import { createTuiPort } from "../host/tui.ts"
import { createRosterFeed } from "./feed.ts"
import { RosterPanel } from "./sidebar.tsx"

export default {
  id: "session-peers.tui",

  setup(context) {
    const port = createTuiPort(context)
    // One feed for the whole TUI, not one per session: the roster answers for
    // this location, and a panel that mounts later reads what is already known.
    const feed = createRosterFeed(port.roster)

    const disposeSlot = port.claimSidebar((input) => (
      <RosterPanel port={port} feed={feed} sessionID={input.sessionID} />
    ))

    // The host calls this when the plugin unloads or the TUI exits.
    return () => {
      disposeSlot()
      feed.dispose()
    }
  },
} satisfies Plugin.Definition
