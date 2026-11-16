/**
 * A TuiPort fake and the bounded payload fixtures the watch UI tests share.
 *
 * It records the calls the plugin makes through the public port and hands the
 * test the dialog renderer the host would show. It knows nothing about the
 * plugin's internals, so a test can assert user-visible reads, controls,
 * toasts and screens without binding to a private helper.
 */

import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"

import { WATCH_CORRECTION_TERMS } from "../src/domain/watch.ts"
import { WATCH_DELEGATION_TERMS } from "../src/watch/delegation.ts"
import type {
  DelegationChallengeView,
  WatchDelegationGrantPayload,
  WatchDelegationViewPayload,
  WatchGrantChallengeView,
  WatchGrantPayload,
  WatchPayload,
} from "../src/rpc.ts"
import type {
  TuiCommand,
  TuiPalette,
  TuiPort,
  ToastVariant,
  WatchCallRequest,
  WatchDelegationCallRequest,
  WatchDelegationViewRequest,
  WatchGrantCallRequest,
  WatchReadRequest,
} from "../src/host/tui.ts"

export const SELF = "ses_self0000"

export const palette: TuiPalette = {
  base: RGBA.fromHex("#cdd6f4"),
  muted: RGBA.fromHex("#7f849c"),
  error: RGBA.fromHex("#f38ba8"),
}

type Task = NonNullable<WatchPayload["task"]>
type Correction = Task["correction"]
export type Attempt = Correction["history"][number]
export type Gate = Correction["gates"][number]
export type Observation = NonNullable<WatchPayload["observation"]>
export type Activity = NonNullable<WatchPayload["activity"]>
export type Alert = WatchPayload["alerts"]["items"][number]
export type AlertsView = WatchPayload["alerts"]
export type Wait = Observation["waits"][number]

export function control(enabled = true, reason: string | null = null) {
  return { enabled, reason }
}

function capability(): WatchPayload["capability"] {
  return {
    mode: "alert",
    monitoring: "observer-alerts",
    automaticDetection: "partial",
    automaticDetectionReason:
      "Observes local execution lifecycle, target activity and same-location waits; it does not prove goal progress.",
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
    acknowledge: control(),
    resume: control(false, "Resume is not implemented in this build."),
    correction: control(false, "Correction is not implemented in this build."),
    transfer: control(false, "Transfer is not implemented in this build."),
    ...overrides,
  }
}

export function ledger(overrides: Partial<WatchPayload["ledger"]> = {}): WatchPayload["ledger"] {
  return {
    available: true,
    reason: null,
    sqliteVersion: "3.51.3",
    journalMode: "wal",
    synchronous: 2,
    busyTimeoutMs: 1_000,
    appVersion: "2.3.0",
    platform: "linux",
    arch: "x64",
    ...overrides,
  }
}

export function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptID: "attempt_0001",
    ordinal: 1,
    phase: "reserved",
    reservedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
    claimedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    unknownAt: null,
    abortedAt: null,
    seen: null,
    receipt: null,
    recovery: null,
    stopReason: null,
    ...overrides,
  }
}

export function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    gate: "grant",
    ok: false,
    reason: "the grant is not active",
    observed: null,
    required: "an explicit limited-correction grant",
    ...overrides,
  }
}

export function correction(overrides: Partial<Correction> = {}): Correction {
  return {
    authorization: {
      mode: "alert",
      state: "not-granted",
      deployment: "unknown",
      version: 1,
      reviewSummary: null,
      grantedAt: null,
    },
    actual: "unavailable",
    actualReason: "The automatic executor is not enabled in this build.",
    attempts: { used: 0, limit: 3 },
    executionPolicy: "bounded-three-attempt",
    policy: {
      observationMs: 5 * 60_000,
      windowMs: 20 * 60_000,
      windowStartedAt: null,
      windowEndsAt: null,
      nextAttemptAt: null,
    },
    phase: "idle",
    pending: null,
    last: null,
    history: [],
    stop: null,
    gates: [],
    businessCompleted: false,
    controls: {
      grant: control(true),
      downgrade: control(false, "no correction grant is active"),
    },
    ...overrides,
  }
}

export function task(overrides: Partial<Task> = {}): Task {
  const base: Task = {
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
    correction: correction(),
    pause: null,
    lastReport: null,
    createdAt: Date.UTC(2026, 10, 16, 4, 0, 0),
    updatedAt: Date.UTC(2026, 10, 16, 4, 30, 0),
    completedAt: null,
    endedAt: null,
  }
  const merged: { -readonly [K in keyof Task]: Task[K] } = { ...base, ...overrides }
  if (overrides.mode === undefined) merged.mode = merged.correction.authorization.mode
  if (overrides.attempts === undefined) merged.attempts = merged.correction.attempts
  if (overrides.taskState === undefined && merged.correction.businessCompleted) {
    merged.taskState = "completed"
  }
  return merged
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    state: "active",
    reason: null,
    observedAt: Date.UTC(2026, 10, 16, 4, 34, 0),
    baselineAt: Date.UTC(2026, 10, 16, 4, 30, 0),
    idleSince: null,
    trusted: true,
    waits: [],
    waitsPartial: false,
    waitsTruncated: false,
    effective: { idleMs: 120_000, runningSilentMs: 600_000, waitOverdueMs: 1_800_000 },
    ...overrides,
  }
}

export function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    lastAt: Date.UTC(2026, 10, 16, 4, 32, 0),
    kind: "text",
    judgement: "not-judged",
    ...overrides,
  }
}

export function wait(overrides: Partial<Wait> = {}): Wait {
  return {
    waitID: "wait_0001",
    source: "permission",
    object: "the reviewer",
    reason: "approval is required",
    reference: "GH-60",
    startedAt: Date.UTC(2026, 10, 16, 4, 20, 0),
    deadline: Date.UTC(2026, 10, 16, 4, 40, 0),
    status: "active",
    clearEvidence: null,
    denyEvidence: null,
    ...overrides,
  }
}

export function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    alertID: "alert_0001",
    taskID: "task_0001",
    kind: "idle",
    state: "unread",
    summary: "No new activity for longer than the idle threshold.",
    reason: "The last activity was 2m ago.",
    nextStep:
      "Inspect the task and its evidence; acknowledge the alert after reading it. This build cannot correct or resume the task for you.",
    plainText: "No new activity for longer than the idle threshold. The last activity was 2m ago.",
    firstAt: Date.UTC(2026, 10, 16, 4, 33, 0),
    updatedAt: Date.UTC(2026, 10, 16, 4, 34, 0),
    readAt: null,
    escalatedAt: null,
    resolvedAt: null,
    ...overrides,
  }
}

export function alertsView(
  items: readonly Alert[],
  overrides: Partial<AlertsView> = {},
): AlertsView {
  const unread = items.filter((item) => item.state === "unread").length
  const active = items.filter((item) => item.resolvedAt === null).length
  return {
    items,
    unread,
    total: items.length,
    active,
    truncated: false,
    available: true,
    reason: null,
    ...overrides,
  }
}

export function grantChallenge(
  overrides: Partial<WatchGrantChallengeView> = {},
): WatchGrantChallengeView {
  return {
    challenge: "challenge-once",
    taskID: "task_0001",
    expectedVersion: 3,
    generation: 1,
    termsDigest: "terms-digest",
    reviewSummary: WATCH_CORRECTION_TERMS,
    deployment: "single-host-same-location",
    expiresAt: Date.UTC(2026, 10, 16, 4, 45, 0),
    ...overrides,
  }
}

export function grantPayload(overrides: Partial<WatchGrantPayload> = {}): WatchGrantPayload {
  return {
    ok: true,
    challenge: null,
    task: task(),
    capability: capability(),
    controls: controls(),
    failure: null,
    ...overrides,
  }
}

export function delegationChallenge(
  overrides: Partial<DelegationChallengeView> = {},
): DelegationChallengeView {
  return {
    challenge: "challenge-delegation-nonce",
    parentTaskID: "task_0001",
    expectedVersion: 3,
    generation: 1,
    mode: "alert",
    targetSessionID: "ses_child_0001",
    scopeDirectory: "/tmp/opencode/project",
    scopePeerScope: "project-a",
    termsDigest: "delegation-terms-digest",
    reviewSummary: WATCH_DELEGATION_TERMS,
    expiresAt: Date.UTC(2026, 10, 16, 4, 45, 0),
    ...overrides,
  }
}

export function delegationGrantPayload(
  overrides: Partial<WatchDelegationGrantPayload> = {},
): WatchDelegationGrantPayload {
  return {
    ok: true,
    challenge: null,
    grant: null,
    task: task(),
    capability: capability(),
    controls: controls(),
    review: {
      delegationTerms: WATCH_DELEGATION_TERMS,
      correctionTerms: WATCH_CORRECTION_TERMS,
      deploymentRequired: false,
    },
    failure: null,
    ...overrides,
  }
}

export function delegationViewPayload(
  overrides: Partial<WatchDelegationViewPayload> = {},
): WatchDelegationViewPayload {
  return {
    ok: true,
    parentTaskID: "task_0001",
    parentSessionID: SELF,
    grants: [],
    children: [],
    failure: null,
    ...overrides,
  }
}

export function payload(overrides: Partial<WatchPayload> = {}): WatchPayload {
  return {
    enabled: true,
    ledger: ledger(),
    task: task(),
    capability: capability(),
    controls: controls(),
    observation: observation(),
    activity: activity(),
    alerts: alertsView([]),
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
  readonly grant?: (request: WatchGrantCallRequest) => Promise<unknown>
  readonly delegation?: (request: WatchDelegationCallRequest) => Promise<unknown>
  readonly delegationView?: (request: WatchDelegationViewRequest) => Promise<unknown>
  /** When true, omits the `watchDelegation` source completely to test graceful degradation. */
  readonly omitDelegation?: boolean
}

export function fakePort(options: FakeOptions = {}) {
  const reads: WatchReadRequest[] = []
  const calls: WatchCallRequest[] = []
  const grantCalls: WatchGrantCallRequest[] = []
  const delegationCalls: WatchDelegationCallRequest[] = []
  const delegationReads: WatchDelegationViewRequest[] = []
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
    watchGrant: {
      call: (request) => {
        grantCalls.push(request)
        return options.grant?.(request) ?? Promise.resolve({})
      },
    },
    ...(options.omitDelegation
      ? {}
      : {
          watchDelegation: {
            call: (request: WatchDelegationCallRequest) => {
              delegationCalls.push(request)
              return options.delegation?.(request) ?? Promise.resolve(delegationGrantPayload())
            },
            read: (request: WatchDelegationViewRequest) => {
              delegationReads.push(request)
              return (
                options.delegationView?.(request) ??
                Promise.resolve(delegationViewPayload({ parentTaskID: request.parentTaskID }))
              )
            },
          },
        }),
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
    grantCalls,
    delegationCalls,
    delegationReads,
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
  }, { width: 100, height: 60 })
  await setup.flush()
  return setup
}

export function commandOf(fake: ReturnType<typeof fakePort>): TuiCommand {
  const command = fake.commands.find((candidate) => candidate.slash === "peers-watch")
  if (command === undefined) throw new Error("the watch command was not registered")
  return command
}
