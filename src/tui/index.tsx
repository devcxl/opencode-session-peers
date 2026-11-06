/** @jsxImportSource @opentui/solid */

/**
 * The TUI entrypoint: the package's `./tui` export.
 *
 * A TUI plugin is loaded beside the server plugin of the same package (one
 * version constrains both sides). It renders nothing until it is asked:
 * `/peers` (or `Session peers` in the palette) opens the host's dialog with the
 * roster table, and `/peers-scope <scope>` moves the current session into
 * another visibility partition. Everything the host knows is read through
 * `host/tui.ts`; this file is wiring, not behaviour: the roster's liveness is
 * `feed.ts`, the table is `dialog.tsx`, the cells are `view.ts`.
 */

import type { Plugin } from "@opencode/plugin/tui"

import { createTuiPort } from "../host/tui.ts"
import { RosterDialog } from "./dialog.tsx"
import { createRosterFeed, failureText } from "./feed.ts"

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
        feed.open(viewpoint.sessionID)
        port.dialog.show(
          () => (
            <RosterDialog
              state={feed.state}
              viewpoint={viewpoint}
              palette={port.palette}
              onScope={(scope) => feed.showScope(scope)}
            />
          ),
          // The host closes the dialog on escape and friends; the feed keeps
          // its subscription but stops its refresh floor until the next open.
          () => feed.close(),
        )
        // The host offers three widths: 60, 88 and 116 columns (each capped by
        // the terminal). A directory is an absolute path, so the widest one is
        // what keeps a row on one line most of the time.
        port.dialog.set({ size: "xlarge", centered: true })
      },
    })

    // The scope a session belongs to is chosen with a prompt command, because
    // it is the session's own property: moving it changes who it can see and
    // who can reach it, and the command says so by naming the group.
    port.command({
      id: "session-peers.scope",
      title: "Set session peers scope",
      group: "Session",
      slash: "peers-scope",
      arguments: true,
      run: (input) => {
        const scope = input?.trim() ?? ""
        if (scope === "") {
          port.toast("usage: /peers-scope <scope>", "warning")
          return
        }
        const { sessionID } = port.currentSession()
        if (sessionID === undefined) {
          port.toast("Peers scope: no session is open here.", "warning")
          return
        }
        void port.setScope(sessionID, scope).then(
          () => port.toast(`Session scope: ${scope}`, "success"),
          (error) => port.toast(`Could not set the session scope: ${failureText(error)}`, "error"),
        )
      },
    })

    // The host calls this when the plugin unloads or the TUI exits.
    return () => feed.dispose()
  },
} satisfies Plugin.Definition
