/**
 * The watchdog application: the one place a watch use case is performed.
 *
 * Tool actions, the RPC surface and the `/peers-watch` command all call this
 * object; none of them re-implements validation, ownership or state changes.
 * The application owns the lazy ledger handle, maps ledger failures to the
 * public failure codes, and supplies the text a normal model context may carry.
 */

import {
  CORRECTION_UNAVAILABLE_REASON,
  DELEGATION_UNAVAILABLE_REASON,
  readGoal,
  readIdentifier,
  type WatchEvidence,
  type WatchFailure,
  type WatchFailureCode,
  type WatchMode,
  type WatchReportKind,
  type WatchTaskView,
} from "../domain/watch.ts"
import { openWatchLedger, type WatchLedger, type WatchLedgerErrorCode } from "./ledger.ts"
import { watchCapability, watchControls, watchTaskView } from "./view.ts"

export interface WatchOutcome {
  readonly ok: boolean
  readonly task: WatchTaskView | null
  readonly capability: ReturnType<typeof watchCapability>
  readonly controls: ReturnType<typeof watchControls>
  readonly failure: WatchFailure | null
  readonly created: boolean
  readonly duplicate: boolean
  readonly changed: boolean
}

export interface WatchLedgerStatus {
  readonly available: boolean
  /** The exact cause when the ledger is not usable; `null` when it is. */
  readonly reason: string | null
}

export interface WatchApplication {
  status(): WatchLedgerStatus
  show(input: { readonly sessionID: string; readonly taskID?: string }): WatchOutcome
  enroll(input: {
    readonly callerSessionID: string
    readonly requestID: string
    readonly goal: string
    readonly targetSessionID?: string
    readonly mode?: WatchMode | string
  }): WatchOutcome
  report(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly expectedVersion: number
    readonly reportID: string
    readonly kind: WatchReportKind
    readonly evidence: WatchEvidence
  }): WatchOutcome
  control(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly expectedVersion: number
    readonly operation: "pause" | "end"
  }): WatchOutcome
  /**
   * The line to append to a normal model context, or `undefined` when this
   * session has no local task that should hear from the watchdog. This never
   * prompts, and a session served by another location gets nothing.
   */
  notificationFor(sessionID: string): Promise<string | undefined>
  dispose(): void
}

export interface WatchApplicationOptions {
  /** The fixed plugin-owned path. The caller never accepts this from a model. */
  readonly ledgerPath: string
  /** This plugin instance's activation; enrollment records it, a reload does not adopt it. */
  readonly activationID: string
  readonly now?: () => number
  /** Test seam for the ledger's runtime gate; production leaves it undefined. */
  readonly sqliteVersion?: string
  /** A successful mutation happened; the RPC surface may nudge its readers. */
  readonly onChanged?: () => void
  /**
   * Whether this location still serves the session. The normal-context notice
   * must not read a machine-wide task from another directory.
   */
  readonly sessionAtLocation?: (sessionID: string) => Promise<boolean>
}

interface LedgerState {
  readonly ledger?: WatchLedger
  readonly failure?: { readonly code: WatchLedgerErrorCode; readonly detail: string }
}

export function createWatchApplication(options: WatchApplicationOptions): WatchApplication {
  let state: LedgerState | undefined
  let closed = false

  const ensure = (): LedgerState => {
    if (state !== undefined) return state
    if (closed) {
      state = { failure: { code: "io_error", detail: "the watch application has been disposed" } }
      return state
    }
    const opened = openWatchLedger({
      path: options.ledgerPath,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sqliteVersion === undefined ? {} : { sqliteVersion: options.sqliteVersion }),
    })
    state = opened.ok
      ? { ledger: opened.ledger }
      : { failure: { code: opened.code, detail: opened.detail } }
    return state
  }

  const view = (sessionID: string, taskID?: string): { outcome: WatchOutcome; ledger?: WatchLedger } => {
    const current = ensure()
    if (current.ledger === undefined) {
      return {
        outcome: failureOutcome(
          mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"),
        ),
      }
    }
    const shown = current.ledger.show({ sessionID, ...(taskID === undefined ? {} : { taskID }) })
    if (!shown.ok) {
      return { outcome: failureOutcome(mapLedgerFailure(shown.code, shown.detail)), ledger: current.ledger }
    }
    const task = shown.value === null ? null : watchTaskView(shown.value, options.activationID)
    return {
      outcome: {
        ok: true,
        task,
        capability: watchCapability(),
        controls: watchControls(task),
        failure: null,
        created: false,
        duplicate: false,
        changed: false,
      },
      ledger: current.ledger,
    }
  }

  const notify = () => {
    try {
      options.onChanged?.()
    } catch {
      // A UI nudge is not part of the mutation; the ledger commit already holds.
    }
  }

  return {
    status() {
      const current = ensure()
      return current.ledger === undefined
        ? { available: false, reason: `${current.failure?.code ?? "ledger_error"}: ${current.failure?.detail ?? "unknown"}` }
        : { available: true, reason: null }
    },

    show(input) {
      const sessionID = readIdentifier(input.sessionID, "sessionID")
      if (!sessionID.ok) return failureOutcome(invalid(sessionID.reason))
      const taskID = input.taskID === undefined ? undefined : readIdentifier(input.taskID, "taskID")
      if (taskID !== undefined && !taskID.ok) return failureOutcome(invalid(taskID.reason))
      return view(sessionID.value, taskID?.value).outcome
    },

    enroll(input) {
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return failureOutcome(invalid(caller.reason))
      if (input.mode !== undefined && input.mode !== "alert") {
        return failureOutcome(unsupported(CORRECTION_UNAVAILABLE_REASON))
      }
      let targetID = caller.value
      if (input.targetSessionID !== undefined) {
        const target = readIdentifier(input.targetSessionID, "targetSessionID")
        if (!target.ok) return failureOutcome(invalid(target.reason))
        targetID = target.value
      }
      if (targetID !== caller.value) {
        return failureOutcome(unsupported(DELEGATION_UNAVAILABLE_REASON))
      }
      const requestID = readIdentifier(input.requestID, "requestID")
      if (!requestID.ok) return failureOutcome(invalid(requestID.reason))
      const goal = readGoal(input.goal)
      if (!goal.ok) return failureOutcome(invalid(goal.reason))

      const current = ensure()
      if (current.ledger === undefined) {
        return failureOutcome(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const enrolled = current.ledger.enroll({
        requestId: requestID.value,
        initiatorSessionId: caller.value,
        targetSessionId: targetID,
        goal: goal.value,
        mode: "alert",
        ownerActivation: options.activationID,
      })
      if (!enrolled.ok) return failureOutcome(mapLedgerFailure(enrolled.code, enrolled.detail))
      if (enrolled.value.created) notify()
      const task = watchTaskView(enrolled.value.task, options.activationID)
      return {
        ok: true,
        task,
        capability: watchCapability(),
        controls: watchControls(task),
        failure: null,
        created: enrolled.value.created,
        duplicate: false,
        changed: enrolled.value.created,
      }
    },

    report(input) {
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return failureOutcome(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return failureOutcome(invalid(taskID.reason))
      const reportID = readIdentifier(input.reportID, "reportID")
      if (!reportID.ok) return failureOutcome(invalid(reportID.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return failureOutcome(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const reported = current.ledger.report({
        taskId: taskID.value,
        callerSessionId: caller.value,
        expectedVersion: input.expectedVersion,
        reportId: reportID.value,
        kind: input.kind,
        evidence: input.evidence,
      })
      if (!reported.ok) return failureOutcome(mapLedgerFailure(reported.code, reported.detail))
      if (!reported.value.duplicate) notify()
      const task = watchTaskView(reported.value.task, options.activationID)
      return {
        ok: true,
        task,
        capability: watchCapability(),
        controls: watchControls(task),
        failure: null,
        created: false,
        duplicate: reported.value.duplicate,
        changed: !reported.value.duplicate,
      }
    },

    control(input) {
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return failureOutcome(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return failureOutcome(invalid(taskID.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return failureOutcome(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const controlled = current.ledger.control({
        taskId: taskID.value,
        callerSessionId: caller.value,
        expectedVersion: input.expectedVersion,
        operation: input.operation,
      })
      if (!controlled.ok) return failureOutcome(mapLedgerFailure(controlled.code, controlled.detail))
      if (controlled.value.changed) notify()
      const task = watchTaskView(controlled.value.task, options.activationID)
      return {
        ok: true,
        task,
        capability: watchCapability(),
        controls: watchControls(task),
        failure: null,
        created: false,
        duplicate: false,
        changed: controlled.value.changed,
      }
    },

    async notificationFor(sessionID) {
      if (options.sessionAtLocation === undefined) return undefined
      if (!(await options.sessionAtLocation(sessionID))) return undefined
      const current = ensure()
      if (current.ledger === undefined) return undefined
      const shown = current.ledger.show({ sessionID })
      if (!shown.ok || shown.value === null) return undefined
      const task = shown.value
      if (task.watchState === "ended" || task.taskState === "completed") return undefined
      return protocolNotice(task)
    },

    dispose() {
      closed = true
      state?.ledger?.close()
      state = undefined
    },
  }
}

function protocolNotice(task: { readonly taskID: string; readonly version: number; readonly watchState: string; readonly taskState: string }): string {
  return [
    "[session-peers watch]",
    `A watched task is enrolled for this session: ${task.taskID} (state version ${task.version}).`,
    `Task state: ${task.taskState}. Supervision: ${task.watchState}. Authorization: alert-only.`,
    "The task goal is not repeated in this system notice; read it with",
    `peers({ action: "watch", watch: { operation: "show", taskID: ${JSON.stringify(task.taskID)} } }) when needed.`,
    "Automatic correction is unavailable in this build. This notice is not a request to start a new turn.",
    "If the task is still yours, report only a real state change or new result:",
    `peers({ action: "watch", watch: { operation: "report", taskID: ${JSON.stringify(task.taskID)}, expectedVersion: ${task.version}, reportId: "<new id>", kind: "begin|progress|waiting|blocked|completed", evidence: { ... } } })`,
    "begin needs no evidence; progress and completed need evidence.summary and evidence.reference; waiting needs evidence.waitKind, evidence.waitFor, evidence.reason and evidence.reference; blocked needs evidence.reason.",
    "Reporting completion ends supervision because the task is done. Do not repeat completed side effects to report.",
  ].join("\n")
}

function invalid(reason: string): WatchFailure {
  return { code: "E_WATCH_INVALID", reason }
}

function unsupported(reason: string): WatchFailure {
  return { code: "E_WATCH_UNSUPPORTED", reason }
}

function failureOutcome(failure: WatchFailure): WatchOutcome {
  return {
    ok: false,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    failure,
    created: false,
    duplicate: false,
    changed: false,
  }
}

export function mapLedgerFailure(code: WatchLedgerErrorCode, detail: string): WatchFailure {
  const make = (failureCode: WatchFailureCode, reason: string): WatchFailure => ({ code: failureCode, reason, detail })
  switch (code) {
    case "invalid_input":
      return make("E_WATCH_INVALID", `The watch request is invalid: ${detail}`)
    case "session_conflict":
      return make("E_WATCH_SESSION_BUSY", `That session already has a live watched task. Pause and end it before enrolling another. (${detail})`)
    case "request_conflict":
      return make("E_WATCH_REQUEST_CONFLICT", `That request id was already used with different parameters. Use the original request or a new id. (${detail})`)
    case "ledger_missing":
      return make(
        "E_WATCH_UNAVAILABLE",
        `The watch ledger identity exists but its database is missing or empty; it is not recreated. (${detail})`,
      )
    case "unknown_task":
      return make("E_WATCH_NOT_FOUND", `No watched task matches "${detail}".`)
    case "caller_mismatch":
      return make("E_WATCH_CALLER_MISMATCH", `This session is not allowed to perform that watch operation. (${detail})`)
    case "stale_version":
      return make("E_WATCH_STALE", `The watch state changed since it was read. Re-read the task and retry. (${detail})`)
    case "report_conflict":
      return make("E_WATCH_REPORT_CONFLICT", `That report id was already used with different evidence. Use a new report id for a new report. (${detail})`)
    case "invalid_transition":
      return make("E_WATCH_INVALID_TRANSITION", `The watched task cannot make that transition: ${detail}`)
    case "ended":
      return make("E_WATCH_ENDED", `The watch has ended; its task state is history, not something to continue. (${detail})`)
    case "conflict":
      return make("E_WATCH_SESSION_BUSY", `A concurrent enrollment or state change won the race; re-read the task. (${detail})`)
    case "lock_timeout":
      return make("E_WATCH_UNAVAILABLE", `The watch ledger is locked by another process; no state was changed. (${detail})`)
    case "state_unknown":
      return make(
        "E_WATCH_UNAVAILABLE",
        `The watch ledger commit completed, but its files could not be secured afterwards (${detail}). The task state may already have changed; re-read the task before retrying. No automatic retry was attempted.`,
      )
    default:
      return make(
        "E_WATCH_UNAVAILABLE",
        `The watch ledger is unavailable (${code}: ${detail}). No watched task was created or changed.`,
      )
  }
}
