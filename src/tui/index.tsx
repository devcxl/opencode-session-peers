/** @jsxImportSource @opentui/solid */

/**
 * The TUI entrypoint: the package's `./tui` export.
 *
 * A TUI plugin is loaded beside the server plugin of the same package (one
 * version constrains both sides). It renders nothing until it is asked: one
 * command — `/peers` or `Session peers` in the palette — opens the host's
 * dialog with the roster table. Everything the host knows is read through
 * `host/tui.ts`; this file is wiring, not behaviour.
 *
 * The roster is read once when the dialog opens, then the plugin's own change
 * events keep it current, with a slow refresh under them as the floor (events
 * are live-only and can be missed). The refresh runs only while the dialog is
 * open and is stopped when the host closes it or the plugin unloads.
 */

import type { Plugin } from "@opencode/plugin/tui"

import { createTuiPort } from "../host/tui.ts"
import { RosterDialog } from "./dialog.tsx"
import { createRosterFeed } from "./feed.ts"

/**
 * How often the dialog re-reads even when nothing has been announced. Events
 * are live-only and measured to arrive in milliseconds, but they can be missed
 * — a dropped event would otherwise freeze the dialog forever — so this is the
 * floor under them, at one request a minute, not the mechanism.
 */
const REFRESH_MS = 60_000

export default {
  id: "session-peers.tui",

  setup(context) {
    const port = createTuiPort(context)
    // One feed for the whole TUI, not one per dialog: the roster answers for
    // this location, and a dialog that opens later reads what is already known.
    const feed = createRosterFeed(port.roster)

    let refresh: ReturnType<typeof setInterval> | undefined
    const stopRefresh = (): void => {
      if (refresh === undefined) return
      clearInterval(refresh)
      refresh = undefined
    }

    port.command({
      id: "session-peers.roster",
      title: "Session peers",
      group: "Session",
      slash: "peers",
      run: () => {
        // The marks are relative to the session that is open now, so they are
        // read once per opening; the roster itself stays live through the feed.
        const sessionID = port.currentSessionID()
        const sessionDirectory =
          sessionID === undefined ? undefined : port.sessionDirectory(sessionID)

        feed.open()
        stopRefresh()
        refresh = setInterval(() => feed.open(), REFRESH_MS)
        port.dialog.show(
          () => (
            <RosterDialog
              state={feed.state}
              sessionID={sessionID}
              sessionDirectory={sessionDirectory}
              palette={port.palette}
            />
          ),
          stopRefresh,
        )
        port.dialog.set({ size: "large", centered: true })
      },
    })

    // The host calls this when the plugin unloads or the TUI exits.
    return () => {
      stopRefresh()
      feed.dispose()
    }
  },
} satisfies Plugin.Definition
