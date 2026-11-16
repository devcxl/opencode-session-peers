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

/** Which roster a read is about: a session's own scope, or a scope previewed. */
export interface RosterRequest {
  readonly sessionID?: string
  readonly scope?: string
}

/** The roster, as the plugin at this location answers for it. */
export interface RosterSource {
  /** One call, at this TUI's own location. Resolves with the raw answer. */
  read(request: RosterRequest): Promise<unknown>
  /** Called when the plugin says a fresh read would say something else. */
  onChange(listener: () => void): () => void
}

/** Which watched task to read: this session's task. */
export interface WatchReadRequest {
  readonly sessionID: string
  readonly taskID?: string
}

/** The one mutation the watch panel may ask for. */
export interface WatchCallRequest {
  readonly operation: "enroll" | "pause" | "end" | "ack"
  readonly sessionID: string
  readonly taskID?: string
  readonly alertID?: string
  readonly expectedVersion?: number
  readonly requestId?: string
  readonly goal?: string
  readonly targetSessionID?: string
  readonly mode?: "alert"
}

/** The controlled TUI-only grant channel; never the model tool. */
export interface WatchGrantCallRequest {
  readonly operation: "prepare" | "confirm" | "downgrade"
  readonly sessionID: string
  readonly taskID: string
  readonly expectedVersion: number
  readonly challenge?: string
  readonly generation?: number
  readonly termsDigest?: string
  readonly deployment?: "single-host-same-location"
}

export interface WatchGrantSource {
  /** One explicit prepare, confirm or downgrade. Resolves with the raw answer. */
  call(request: WatchGrantCallRequest): Promise<unknown>
}

/** The controlled TUI-only delegation grant channel; never the model tool. */
export interface WatchDelegationCallRequest {
  readonly operation: "prepare" | "confirm" | "revoke"
  readonly sessionID: string
  readonly parentTaskID: string
  readonly expectedVersion: number
  readonly targetSessionID: string
  readonly mode?: "alert" | "limited-correction"
  readonly deployment?: "single-host-same-location"
  readonly challenge?: string
  readonly generation?: number
  readonly termsDigest?: string
  readonly scopeDirectory?: string
  readonly scopePeerScope?: string
}

/** Which direct children to read: direct child tasks under this parent. */
export interface WatchDelegationViewRequest {
  readonly sessionID: string
  readonly parentTaskID: string
}

export interface WatchDelegationSource {
  /** One explicit prepare, confirm or revoke. Resolves with the raw answer. */
  call(request: WatchDelegationCallRequest): Promise<unknown>
  /** One read-only direct child snapshot. Resolves with the raw answer. */
  read(request: WatchDelegationViewRequest): Promise<unknown>
}

/** The watch state, as the plugin at this location answers for it. */
export interface WatchSource {
  /** One read-only snapshot. Resolves with the raw answer. */
  read(request: WatchReadRequest): Promise<unknown>
  /** One explicit enrollment, pause or end. Resolves with the raw answer. */
  call(request: WatchCallRequest): Promise<unknown>
  /** Called when the plugin says a fresh snapshot would say something else. */
  onChange(listener: () => void): () => void
}

/** How much the toast's message stands out. */
export type ToastVariant = "info" | "success" | "warning" | "error"

/** One command this plugin puts on the keyboard: the palette and a slash name. */
export interface TuiCommand {
  /** Stable command and config keybind identifier. */
  readonly id: string
  readonly title: string
  readonly group: string
  /** The prompt slash name, without the slash. */
  readonly slash: string
  /** Keeps the slash command's raw input and hands it to `run`. */
  readonly arguments?: boolean
  readonly run: (input?: string) => void
}

/** What the view may ask of the TUI it runs inside. */
export interface TuiPort {
  readonly palette: () => TuiPalette
  readonly roster: RosterSource
  /** The watched task at this TUI's own location. */
  readonly watch: WatchSource
  /** The controlled grant review channel at this TUI's own location. */
  readonly watchGrant: WatchGrantSource
  /** The controlled delegation review channel at this TUI's own location. */
  readonly watchDelegation?: WatchDelegationSource
  /** Moves the session into a scope and reports the applied one. */
  setScope(sessionID: string, scope: string): Promise<unknown>
  /** A short message in the host's toast area, for a command with no dialog. */
  toast(message: string, variant?: ToastVariant): void
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
  // Built per call: an `AbortSignal.timeout` starts counting when it is made,
  // so one made here would be long expired by the time a dialog opens.
  const call = () => ({
    location: context.location ?? context.data.location.default(),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })

  return {
    palette: () => ({
      base: context.theme.text.base,
      muted: context.theme.text.muted,
      error: context.theme.text.feedback.error.base,
    }),

    roster: {
      read: (request) => client.roster(request, call()),
      onChange: (listener) => client.events.on("changed", () => listener()),
    },

    watch: {
      read: (request) =>
        client.watch(
          {
            operation: "show",
            sessionID: request.sessionID,
            ...(request.taskID === undefined ? {} : { taskID: request.taskID }),
          },
          call(),
        ),
      call: (request) =>
        client.watch(
          {
            operation: request.operation,
            sessionID: request.sessionID,
            ...(request.taskID === undefined ? {} : { taskID: request.taskID }),
            ...(request.alertID === undefined ? {} : { alertID: request.alertID }),
            ...(request.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.expectedVersion }),
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            ...(request.goal === undefined ? {} : { goal: request.goal }),
            ...(request.targetSessionID === undefined
              ? {}
              : { targetSessionID: request.targetSessionID }),
            ...(request.mode === undefined ? {} : { mode: request.mode }),
          },
          call(),
        ),
      onChange: (listener) => client.events.on("watchChanged", () => listener()),
    },

    watchGrant: {
      call: (request) =>
        client.watchGrant(
          {
            operation: request.operation,
            sessionID: request.sessionID,
            taskID: request.taskID,
            expectedVersion: request.expectedVersion,
            ...(request.challenge === undefined ? {} : { challenge: request.challenge }),
            ...(request.generation === undefined ? {} : { generation: request.generation }),
            ...(request.termsDigest === undefined ? {} : { termsDigest: request.termsDigest }),
            ...(request.deployment === undefined ? {} : { deployment: request.deployment }),
          },
          call(),
        ),
    },

    watchDelegation: {
      call: (request) =>
        client.watchDelegation(
          {
            operation: request.operation,
            sessionID: request.sessionID,
            parentTaskID: request.parentTaskID,
            expectedVersion: request.expectedVersion,
            targetSessionID: request.targetSessionID,
            ...(request.mode === undefined ? {} : { mode: request.mode }),
            ...(request.deployment === undefined ? {} : { deployment: request.deployment }),
            ...(request.challenge === undefined ? {} : { challenge: request.challenge }),
            ...(request.generation === undefined ? {} : { generation: request.generation }),
            ...(request.termsDigest === undefined ? {} : { termsDigest: request.termsDigest }),
            ...(request.scopeDirectory === undefined ? {} : { scopeDirectory: request.scopeDirectory }),
            ...(request.scopePeerScope === undefined ? {} : { scopePeerScope: request.scopePeerScope }),
          },
          call(),
        ),
      read: (request) =>
        client.watchDelegationView(
          {
            sessionID: request.sessionID,
            parentTaskID: request.parentTaskID,
          },
          call(),
        ),
    },

    setScope: (sessionID, scope) => client.setScope({ sessionID, scope }, call()),

    toast: (message, variant = "info") => context.ui.toast.show({ message, variant }),

    currentSession: () => {
      // The route is the direct answer inside a session. With tabs, the route
      // can still be `home` while a session tab is the one on screen, and that
      // tab is the session the reader means by "this one".
      const route = context.ui.router.current()
      const sessionID =
        route.type === "session" ? route.sessionID : activeTabSessionID(context)
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
            slash:
              input.arguments === true
                ? { name: input.slash, arguments: true }
                : { name: input.slash },
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

/** The session whose tab is active, when tabs are enabled and one is. */
function activeTabSessionID(context: Plugin.Context): string | undefined {
  if (!context.ui.tabs.enabled()) return undefined
  return context.ui.tabs.list().find((tab) => tab.active)?.sessionID
}
