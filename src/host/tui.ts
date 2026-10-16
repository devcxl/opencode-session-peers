/**
 * The TUI side's host layer.
 *
 * The same rule as the server side, and `test/boundaries.test.ts` enforces it
 * for both: the plugin context is read inside `host/` and nowhere else. A TUI
 * plugin's context is a different surface — a slot tree, a client, the TUI's
 * own data — so it gets its own port rather than a second use of the server's.
 *
 * The view asks the plugin at this TUI's own location and no other: measured,
 * the first RPC into a never-activated location costs 122 ms *and starts that
 * location's plugin instances*, which merely opening a sidebar must not do
 * (`docs/research/tui-surface-data-path.md` §5).
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { JSX } from "@opentui/solid"

import { SESSION_PEERS_RPC } from "../rpc.ts"

/** How long one RPC call may take before the view reports it as failed. */
const RPC_TIMEOUT_MS = 15_000

/** The panel's colours, read when a line is drawn so a theme switch shows. */
export interface TuiPalette {
  readonly base: ResolvedTheme["text"]["base"]
  readonly muted: ResolvedTheme["text"]["muted"]
  readonly error: ResolvedTheme["text"]["feedback"]["error"]["base"]
}

/** The roster, as the plugin at this location answers for it. */
export interface RosterSource {
  /** One call, at this TUI's own location. Resolves with the raw answer. */
  read(): Promise<unknown>
  /** Called when the plugin says a fresh read would say something else. */
  onChange(listener: () => void): () => void
}

/** What the view may ask of the TUI it runs inside. */
export interface TuiPort {
  readonly palette: () => TuiPalette
  readonly roster: RosterSource
  /** The directory a session works in, when the TUI knows that session. */
  sessionDirectory(sessionID: string): string | undefined
  /** Renders the panel inside `sidebar.content`; returns its disposer. */
  claimSidebar(render: (input: { readonly sessionID: string }) => JSX.Element): () => void
}

export function createTuiPort(context: Plugin.Context): TuiPort {
  const client = context.client.rpc(SESSION_PEERS_RPC)

  return {
    palette: () => ({
      base: context.theme.text.base,
      muted: context.theme.text.muted,
      error: context.theme.text.feedback.error.base,
    }),

    roster: {
      read: () =>
        client.roster(
          {},
          {
            location: context.location ?? context.data.location.default(),
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          },
        ),
      onChange: (listener) => client.events.on("changed", () => listener()),
    },

    sessionDirectory: (sessionID) => context.data.session.get(sessionID)?.location.directory,

    claimSidebar: (render) => context.ui.slot({ append: "sidebar.content", render }),
  }
}
