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
 * location's plugin instances*, which merely opening the roster must not do
 * (`docs/research/tui-surface-data-path.md` §5).
 */

import type { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { JSX } from "@opentui/solid"

import { SESSION_PEERS_RPC } from "../rpc.ts"

/** How long one RPC call may take before the view reports it as failed. */
const RPC_TIMEOUT_MS = 15_000

/** The dialog's colours, read when a cell is drawn so a theme switch shows. */
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

/** One command this plugin puts on the keyboard: the palette and a slash name. */
export interface TuiCommand {
  /** Stable command and config keybind identifier. */
  readonly id: string
  readonly title: string
  readonly group: string
  /** The prompt slash name, without the slash. */
  readonly slash: string
  readonly run: () => void
}

/** What the view may ask of the TUI it runs inside. */
export interface TuiPort {
  readonly palette: () => TuiPalette
  readonly roster: RosterSource
  /**
   * The session this TUI has open right now, and the directory it works in
   * when the TUI knows the session — what the view's marks are relative to.
   * Both are `undefined` outside a session; `directory` alone is `undefined`
   * when the session is not one the TUI knows.
   */
  currentSession(): {
    readonly sessionID: string | undefined
    readonly directory: string | undefined
  }
  /**
   * Adds a command to the palette and the prompt's slash names. The host owns
   * its lifetime — it lives as long as the plugin does, so there is no
   * disposer; re-registering the same id replaces the command.
   */
  command(input: TuiCommand): void
  /** The host's dialog chrome; the plugin renders the content inside it. */
  readonly dialog: {
    /** Shows a dialog; `onClose` runs when the host closes it. */
    show(render: () => JSX.Element, onClose?: () => void): void
    /** Presentation options for the dialog that is open. */
    set(options: {
      readonly size: "medium" | "large" | "xlarge"
      readonly centered: boolean
    }): void
  }
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

    currentSession: () => {
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      return {
        sessionID,
        directory:
          sessionID === undefined ? undefined : context.data.session.get(sessionID)?.location.directory,
      }
    },

    command: (input) =>
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: input.id,
            title: input.title,
            group: input.group,
            palette: true,
            slash: { name: input.slash },
            run: input.run,
          },
        ],
      })),

    dialog: {
      show: (render, onClose) => context.ui.dialog.show(render, onClose),
      set: (options) => context.ui.dialog.set(options),
    },
  }
}
