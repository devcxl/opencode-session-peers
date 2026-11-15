/**
 * A TuiPort fake and the small payload fixtures the watch UI tests share.
 *
 * It records the calls the plugin makes through the public port and hands the
 * test the dialog renderer the host would show. It knows nothing about the
 * plugin's internals, so a test can assert user-visible reads, controls,
 * toasts and screens without binding to a private helper.
 */

import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"

import type { WatchPayload } from "../src/rpc.ts"
import type {
  TuiCommand,
  TuiPalette,
  TuiPort,
  ToastVariant,
  WatchCallRequest,
  WatchReadRequest,
} from "../src/host/tui.ts"

export const SELF = "ses_self0000"

export const palette: TuiPalette = {
  base: RGBA.fromHex("#cdd6f4"),
  muted: RGBA.fromHex("#7f849c"),
  error: RGBA.fromHex("#f38ba8"),
}

type Task = NonNullable<WatchPayload["task"]>

export function control(enabled = true, reason: string | null = null) {
  return { enabled, reason }
}

function capability(): WatchPayload["capability"] {
  return {
    mode: "alert",
    monitoring: "participant-reports-only",
    automaticDetection: "unavailable",
    automaticDetectionReason: "No supported execution signal is available in this build.",
    correction: "unavailable",
    correctionReason: "Finite correction is not implemented in this build.",
    delegation: "unavailable",
    delegationReason: "Child-task delegation is not open in this build.",
    transfer: "unavailable",
    transferReason: "Watch ownership transfer is not implemented in this build.",
    recovery: "unavailable",
    recoveryReason: "Resume and recovery confirmation are not implemented in this build.",
    safetyPause: "unavailable",
    safetyPauseReason:
      "Watch safety pause is not implemented in this build; only a manual pause can occur.",
  }
}

export function controls(overrides: Partial<WatchPayload["controls"]> = {}): WatchPayload["controls"] {
  return {
    pause: control(),
    end: control(),
    resume: control(false, "Resume is not implemented in this build."),
    correction: control(false, "Correction is not implemented in this build."),
    transfer: control(false, "Transfer is not implemented in this build."),
    ...overrides,
  }
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    taskID: "task_0001",
    initiatorSessionID: SELF,
    targetSessionID: SELF,
    goal: "finish the migration",
    mode: "alert",
    watchState: "active",
    taskState: "in-progress",
    version: 3,
    generation: 1,
    ownership: "this-instance",
    participation: "seen",
    attempts: { used: 0, limit: 3 },
    pause: null,
    lastReport: null,
    createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
    updatedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
    completedAt: null,
    endedAt: null,
    ...overrides,
  }
}

export function payload(overrides: Partial<WatchPayload> = {}): WatchPayload {
  return {
    enabled: true,
    ledger: { available: true, reason: null },
    task: task(),
    capability: capability(),
    controls: controls(),
    failure: null,
    ...overrides,
  }
}

export function panelPayload(
  sessionID: string,
  taskID: string,
  watchState: "active" | "paused" = "active",
): WatchPayload {
  return payload({
    task: task({
      taskID,
      initiatorSessionID: sessionID,
      targetSessionID: sessionID,
      watchState,
      version: watchState === "active" ? 3 : 4,
      pause:
        watchState === "paused" ? { kind: "manual", reason: "paused by the user" } : null,
    }),
  })
}

export interface FakeOptions {
  readonly sessionID?: string | undefined
  readonly read?: (request: WatchReadRequest) => Promise<unknown>
  readonly call?: (request: WatchCallRequest) => Promise<unknown>
}

export function fakePort(options: FakeOptions = {}) {
  const reads: WatchReadRequest[] = []
  const calls: WatchCallRequest[] = []
  const toasts: { message: string; variant: ToastVariant | undefined }[] = []
  const commands: TuiCommand[] = []
  const dialogSets: { size: string; centered: boolean }[] = []
  let shown: Parameters<TuiPort["dialog"]["show"]>[0] | undefined
  let onClose: (() => void) | undefined
  let listener: (() => void) | undefined
  let rosterReads = 0
  let dialogShows = 0
  let currentSessionID = Object.prototype.hasOwnProperty.call(options, "sessionID")
    ? options.sessionID
    : SELF

  const port: TuiPort = {
    palette: () => palette,
    roster: {
      read: async () => {
        rosterReads += 1
        return {}
      },
      onChange: () => () => {},
    },
    watch: {
      read: (request) => {
        reads.push(request)
        return options.read?.(request) ?? Promise.resolve(payload())
      },
      call: (request) => {
        calls.push(request)
        return options.call?.(request) ?? Promise.resolve(payload())
      },
      onChange: (on) => {
        listener = on
        return () => {
          listener = undefined
        }
      },
    },
    setScope: async () => ({}),
    toast: (message, variant) => {
      toasts.push({ message, variant })
    },
    currentSession: () => ({
      sessionID: currentSessionID,
      directory: "/work/alpha",
    }),
    command: (command) => {
      commands.push(command)
    },
    dialog: {
      show: (render, close) => {
        dialogShows += 1
        shown = render
        onClose = close
      },
      set: (presentation) => {
        dialogSets.push(presentation)
      },
    },
  }

  return {
    port,
    reads,
    calls,
    toasts,
    commands,
    dialogSets,
    shown: () => shown,
    dialogShows: () => dialogShows,
    rosterReads: () => rosterReads,
    setSession: (sessionID: string | undefined) => {
      currentSessionID = sessionID
    },
    close: () => onClose?.(),
    announce: () => listener?.(),
    subscribed: () => listener !== undefined,
  }
}

export const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export async function mountPanel(fake: ReturnType<typeof fakePort>) {
  const setup = await testRender(() => {
    const render = fake.shown()
    if (render === undefined) throw new Error("the panel was not opened")
    return render()
  }, { width: 100, height: 40 })
  await setup.flush()
  return setup
}

export function commandOf(fake: ReturnType<typeof fakePort>): TuiCommand {
  const command = fake.commands.find((candidate) => candidate.slash === "peers-watch")
  if (command === undefined) throw new Error("the watch command was not registered")
  return command
}
