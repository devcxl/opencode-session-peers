/** @jsxImportSource @opentui/solid */

/**
 * The TUI entrypoint: the package's `./tui` export.
 *
 * A TUI plugin is loaded beside the server plugin of the same package (one
 * version constrains both sides). It renders nothing until it is asked: one
 * command — `/peers` or `Session peers` in the palette — opens the host's
 * dialog with the roster table. Everything the host knows is read through
 * `host/tui.ts`; this file is wiring, not behaviour: the roster's liveness is
 * `feed.ts`, the table is `dialog.tsx`, the cells are `view.ts`.
 */

import type { Plugin } from "@opencode/plugin/tui"

import { createTuiPort } from "../host/tui.ts"
import { RosterDialog } from "./dialog.tsx"
import { createRosterFeed } from "./feed.ts"

export default {
  id: "session-peers.tui",

  setup(context) {
    const port = createTuiPort(context)
    // One feed for the whole TUI, not one per dialog: the roster answers for
    // this location, and a dialog that opens later reads what is already known.
    const feed = createRosterFeed(port.roster)

    port.command({
      id: "session-peers.roster",
      title: "Session peers",
      group: "Session",
      slash: "peers",
      run: () => {
        // The marks are relative to the session that is open now, so the
        // viewpoint is read once per opening; the roster itself stays live
        // through the feed.
        const viewpoint = port.currentSession()
        feed.open()
        port.dialog.show(
          () => (
            <RosterDialog state={feed.state} viewpoint={viewpoint} palette={port.palette} />
          ),
          // The host closes the dialog on escape and friends; the feed keeps
          // its subscription but stops its refresh floor until the next open.
          () => feed.close(),
        )
        port.dialog.set({ size: "large", centered: true })
      },
    })

    // The host calls this when the plugin unloads or the TUI exits.
    return () => feed.dispose()
  },
} satisfies Plugin.Definition
