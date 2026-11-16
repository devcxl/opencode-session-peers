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
  WATCH_CORRECTION_DEFAULT_POLICY,
  WATCH_CORRECTION_TERMS,
  isCorrectionAttemptOpen,
  readGoal,
  readIdentifier,
  type WatchActivityView,
  type WatchAlertRecord,
  type WatchAlertsView,
  type WatchEvidence,
  type WatchObservationView,
  type WatchFailure,
  type WatchFailureCode,
  type WatchCorrectionPolicy,
  type WatchMode,
  type WatchReportKind,
  type WatchTaskRecord,
  type WatchTaskView,
} from "../domain/watch.ts"
import type { CorrectionExecutorAuthority } from "./executor.ts"
import {
  openWatchLedger,
  type CorrectionGrantChallenge,
  type UpsertWatchAlertInput,
  type WatchLedger,
  type WatchLedgerErrorCode,
} from "./ledger.ts"
import { watchAlertView, watchCapability, watchControls, watchTaskView } from "./view.ts"

export interface WatchOutcome {
  readonly ok: boolean
  readonly task: WatchTaskView | null
  readonly capability: ReturnType<typeof watchCapability>
  readonly controls: ReturnType<typeof watchControls>
  /** Persisted alerts for the task, including resolved history and real availability. */
  readonly alerts: WatchAlertsView
  readonly failure: WatchFailure | null
  readonly created: boolean
  readonly duplicate: boolean
  readonly changed: boolean
}

/** The observer's current reading, injected into the public payload. */
export interface WatchObservationSource {
  observationFor(taskID: string): WatchObservationView | null
  activityFor(taskID: string): WatchActivityView | null
  /** Re-sample the current session/permissions/waits before a final decision. */
  refresh(taskID: string): Promise<WatchObservationView | null>
}

export interface WatchReceiptOutcome {
  readonly ok: boolean
  readonly task: WatchTaskView | null
  readonly capability: ReturnType<typeof watchCapability>
  readonly controls: ReturnType<typeof watchControls>
  readonly alerts: WatchAlertsView
  readonly failure: WatchFailure | null
  readonly continuePermit: boolean
  readonly duplicate: boolean
  readonly seen: boolean
  readonly refusalReason: string | null
}

export interface WatchGrantOutcome {
  readonly ok: boolean
  /** Only the prepare response carries the opaque challenge. */
  readonly challenge: CorrectionGrantChallenge | null
  readonly task: WatchTaskView | null
  readonly capability: ReturnType<typeof watchCapability>
  readonly controls: ReturnType<typeof watchControls>
  readonly failure: WatchFailure | null
}

export interface WatchLedgerStatus {
  readonly available: boolean
  /** The exact cause when the ledger is not usable; `null` when it is. */
  readonly reason: string | null
  /** Facts read from the actual embedded runtime, never from an external Bun. */
  readonly sqliteVersion: string | null
  readonly journalMode: string | null
  readonly synchronous: number | null
  readonly busyTimeoutMs: number | null
  readonly filesystem: string | null
  readonly appVersion: string | null
  readonly platform: string | null
  readonly arch: string | null
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
  ack(input: { readonly callerSessionID: string; readonly alertID: string }): WatchOutcome
  /** The executing session's receipt for one known correction attempt. */
  receipt(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly attemptID: string
    readonly correlation: string
  }): WatchReceiptOutcome
  /** The one serial executor's ledger authority; absent when the ledger is unavailable. */
  correctionAuthority(): CorrectionExecutorAuthority | undefined
  /** Synchronously close mutations before waiting for in-flight executor work. */
  beginClosing(): void
  /** Synchronous closing state for post-await fences. */
  isClosing(): boolean
  /** Controlled TUI grant review/confirmation; never a model tool path. */
  prepareGrant(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly expectedVersion: number
    readonly deployment: "single-host-same-location"
  }): WatchGrantOutcome
  confirmGrant(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly expectedVersion: number
    readonly generation: number
    readonly termsDigest: string
    readonly challenge: string
    readonly deployment: "single-host-same-location"
  }): WatchGrantOutcome
  downgradeGrant(input: {
    readonly callerSessionID: string
    readonly taskID: string
    readonly expectedVersion: number
  }): WatchGrantOutcome
  /** Tasks the observer may sample; empty when the ledger is unavailable. */
  liveTasks(): readonly WatchTaskRecord[]
  upsertAlert(input: UpsertWatchAlertInput): { readonly alert: WatchAlertRecord; readonly created: boolean; readonly escalated: boolean } | undefined
  resolveAlert(input: { readonly taskId: string; readonly dedupeKey: string; readonly at: number }): boolean
  /** Active alerts for one task; empty when none or the ledger cannot answer. */
  alertsFor(taskID: string): WatchAlertsView
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
  /** Public host identity; used for the capability/runtime gates, not ownership. */
  readonly runtime?: {
    readonly appName: string
    readonly appVersion: string
    readonly platform: string
    readonly arch: string
  }
  readonly now?: () => number
  /** The effective bounded-attempt policy; defaults to the documented values. */
  readonly policy?: WatchCorrectionPolicy
  /** Test seam for the ledger's runtime gate; production leaves it undefined. */
  readonly sqliteVersion?: string
  /** A successful mutation happened; the RPC surface may nudge its readers. */
  readonly onChanged?: () => void
  /**
   * Whether this location still serves the session. The normal-context notice
   * must not read a machine-wide task from another directory.
   */
  readonly sessionAtLocation?: (sessionID: string) => Promise<boolean>
  /** The observer's current reading for the gate; absent before the observer starts. */
  readonly observationFor?: (taskID: string) => WatchObservationView | null
}

interface LedgerState {
  readonly ledger?: WatchLedger
  readonly failure?: { readonly code: WatchLedgerErrorCode; readonly detail: string }
}

export function createWatchApplication(options: WatchApplicationOptions): WatchApplication {
  let state: LedgerState | undefined
  let closing = false
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

  const capabilityFor = (task: WatchTaskView | null) =>
    watchCapability(task?.mode ?? "alert", task?.correction.actual ?? "unavailable")

  const alertsFor = (taskID: string): WatchAlertsView => {
    const current = ensure()
    if (current.ledger === undefined) {
      const reason = `${current.failure?.code ?? "ledger_error"}: ${current.failure?.detail ?? "unknown"}`
      return emptyWatchAlerts(false, reason)
    }
    const listed = current.ledger.alerts(taskID)
    if (!listed.ok) return emptyWatchAlerts(false, `${listed.code}: ${listed.detail}`)
    return {
      items: listed.value.alerts.map(watchAlertView),
      unread: listed.value.unread,
      total: listed.value.total,
      active: listed.value.active,
      truncated: listed.value.truncated,
      available: true,
      reason: null,
    }
  }

  const taskView = (
    record: WatchTaskRecord,
    ledger: WatchLedger,
  ): { readonly view: WatchTaskView } | { readonly failure: WatchFailure } => {
    const snapshot = ledger.correction(record.taskID)
    if (!snapshot.ok) return { failure: mapLedgerFailure(snapshot.code, snapshot.detail) }
    return {
      view: watchTaskView(
        record,
        options.activationID,
        snapshot.value,
        {
          appVersion: options.runtime?.appVersion ?? null,
          platform: options.runtime?.platform ?? null,
          arch: options.runtime?.arch ?? null,
          sqliteVersion: ledger.sqliteVersion,
          journalMode: ledger.journalMode,
          synchronous: ledger.synchronous,
          busyTimeoutMs: ledger.busyTimeoutMs,
          filesystem: ledger.filesystem,
        },
        options.observationFor?.(record.taskID) ?? null,
        closed,
        options.now?.() ?? Date.now(),
        options.policy ?? WATCH_CORRECTION_DEFAULT_POLICY,
      ),
    }
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
    let task: WatchTaskView | null = null
    if (shown.value !== null) {
      const built = taskView(shown.value, current.ledger)
      if ("failure" in built) return { outcome: failureOutcome(built.failure), ledger: current.ledger }
      task = built.view
    }
    return {
      outcome: {
        ok: true,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        alerts: task === null ? emptyWatchAlerts(true, null) : alertsFor(task.taskID),
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
      if (current.ledger === undefined) {
        return {
          available: false,
          reason: `${current.failure?.code ?? "ledger_error"}: ${current.failure?.detail ?? "unknown"}`,
          sqliteVersion: null,
          journalMode: null,
          synchronous: null,
          busyTimeoutMs: null,
          filesystem: null,
          appVersion: options.runtime?.appVersion ?? null,
          platform: options.runtime?.platform ?? null,
          arch: options.runtime?.arch ?? null,
        }
      }
      return {
        available: true,
        reason: null,
        sqliteVersion: current.ledger.sqliteVersion,
        journalMode: current.ledger.journalMode,
        synchronous: current.ledger.synchronous,
        busyTimeoutMs: current.ledger.busyTimeoutMs,
        filesystem: current.ledger.filesystem,
        appVersion: options.runtime?.appVersion ?? null,
        platform: options.runtime?.platform ?? null,
        arch: options.runtime?.arch ?? null,
      }
    },

    show(input) {
      const sessionID = readIdentifier(input.sessionID, "sessionID")
      if (!sessionID.ok) return failureOutcome(invalid(sessionID.reason))
      const taskID = input.taskID === undefined ? undefined : readIdentifier(input.taskID, "taskID")
      if (taskID !== undefined && !taskID.ok) return failureOutcome(invalid(taskID.reason))
      return view(sessionID.value, taskID?.value).outcome
    },

    enroll(input) {
      if (closing) return failureOutcome(closingFailure())
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
      const built = taskView(enrolled.value.task, current.ledger)
      if ("failure" in built) return failureOutcome(built.failure)
      const task = built.view
      return {
        ok: true,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        alerts: alertsFor(task.taskID),
        failure: null,
        created: enrolled.value.created,
        duplicate: false,
        changed: enrolled.value.created,
      }
    },

    report(input) {
      if (closing) return failureOutcome(closingFailure())
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
      if (!reported.value.duplicate) {
        notify()
        if (input.kind === "progress" && input.evidence.reference !== undefined) {
          tryRecovery(current.ledger, reported.value.task, caller.value, input.reportID, input.evidence.reference, options.now?.() ?? Date.now(), notify)
        }
      }
      const built = taskView(reported.value.task, current.ledger)
      if ("failure" in built) return failureOutcome(built.failure)
      const task = built.view
      return {
        ok: true,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        alerts: alertsFor(task.taskID),
        failure: null,
        created: false,
        duplicate: reported.value.duplicate,
        changed: !reported.value.duplicate,
      }
    },

    receipt(input) {
      if (closing) return receiptFailure(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return receiptFailure(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return receiptFailure(invalid(taskID.reason))
      const attemptID = readIdentifier(input.attemptID, "attemptID")
      if (!attemptID.ok) return receiptFailure(invalid(attemptID.reason))
      const correlation = readIdentifier(input.correlation, "correlation")
      if (!correlation.ok) return receiptFailure(invalid(correlation.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return receiptFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const received = current.ledger.recordCorrectionReceipt({
        taskId: taskID.value,
        reservationId: attemptID.value,
        callerSessionId: caller.value,
        currentActivationId: options.activationID,
        correlation: correlation.value,
        at: options.now?.() ?? Date.now(),
      })
      if (!received.ok) return receiptFailure(mapLedgerFailure(received.code, received.detail))
      if (!received.value.duplicate) notify()
      const shown = current.ledger.show({ taskID: taskID.value, sessionID: caller.value })
      if (!shown.ok) return receiptFailure(mapLedgerFailure(shown.code, shown.detail))
      if (shown.value === null) return receiptFailure(invalid("the receipt has no visible task"))
      const built = taskView(shown.value, current.ledger)
      if ("failure" in built) return receiptFailure(built.failure)
      return {
        ok: true,
        task: built.view,
        capability: capabilityFor(built.view),
        controls: watchControls(built.view),
        alerts: alertsFor(shown.value.taskID),
        failure: null,
        continuePermit: received.value.continuePermit,
        duplicate: received.value.duplicate,
        seen: received.value.seen,
        refusalReason: received.value.refusalReason,
      }
    },

    correctionAuthority() {
      const current = ensure()
      const ledger = current.ledger
      if (ledger === undefined) return undefined
      return {
        liveTasks() {
          const listed = ledger.listActive()
          return listed.ok ? listed.value : []
        },
        snapshot(taskID) {
          const snapshot = ledger.correction(taskID)
          return snapshot.ok ? snapshot.value : undefined
        },
        reserve(input) {
          return ledger.reserveCorrection(input)
        },
        claim(input) {
          return ledger.claimCorrection(input)
        },
        outcome(input) {
          return ledger.recordCorrectionOutcome(input)
        },
        abort(input) {
          return ledger.abortCorrection(input)
        },
        onChanged: notify,
      }
    },

    beginClosing() {
      closing = true
    },

    isClosing() {
      return closing
    },

    control(input) {
      if (closing) return failureOutcome(closingFailure())
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
      const built = taskView(controlled.value.task, current.ledger)
      if ("failure" in built) return failureOutcome(built.failure)
      const task = built.view
      return {
        ok: true,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        alerts: alertsFor(task.taskID),
        failure: null,
        created: false,
        duplicate: false,
        changed: controlled.value.changed,
      }
    },

    ack(input) {
      if (closing) return failureOutcome(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return failureOutcome(invalid(caller.reason))
      const alertID = readIdentifier(input.alertID, "alertID")
      if (!alertID.ok) return failureOutcome(invalid(alertID.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return failureOutcome(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const acked = current.ledger.ackAlert({
        alertID: alertID.value,
        callerSessionId: caller.value,
        at: options.now?.() ?? Date.now(),
      })
      if (!acked.ok) return failureOutcome(mapLedgerFailure(acked.code, acked.detail))
      if (acked.value.changed) notify()
      const shown = current.ledger.show({ taskID: acked.value.alert.taskID, sessionID: caller.value })
      if (!shown.ok) return failureOutcome(mapLedgerFailure(shown.code, shown.detail))
      if (shown.value === null) return failureOutcome(invalid("the alert has no visible task"))
      const built = taskView(shown.value, current.ledger)
      if ("failure" in built) return failureOutcome(built.failure)
      const task = built.view
      return {
        ok: true,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        alerts: alertsFor(task.taskID),
        failure: null,
        created: false,
        duplicate: false,
        changed: acked.value.changed,
      }
    },

    prepareGrant(input) {
      if (closing) return grantFailure(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return grantFailure(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return grantFailure(invalid(taskID.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return grantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const prepared = current.ledger.prepareCorrectionGrant({
        taskId: taskID.value,
        callerSessionId: caller.value,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        reviewSummary: WATCH_CORRECTION_TERMS,
        deployment: input.deployment,
        at: options.now?.() ?? Date.now(),
      })
      if (!prepared.ok) return grantFailure(mapLedgerFailure(prepared.code, prepared.detail))
      const shown = current.ledger.show({ taskID: taskID.value, sessionID: caller.value })
      if (!shown.ok) return grantFailure(mapLedgerFailure(shown.code, shown.detail))
      const built = shown.value === null ? undefined : taskView(shown.value, current.ledger)
      if (built !== undefined && "failure" in built) return grantFailure(built.failure)
      const task = built?.view ?? null
      return {
        ok: true,
        challenge: prepared.value,
        task,
        capability: capabilityFor(task),
        controls: watchControls(task),
        failure: null,
      }
    },

    confirmGrant(input) {
      if (closing) return grantFailure(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return grantFailure(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return grantFailure(invalid(taskID.reason))
      const challenge = readIdentifier(input.challenge, "challenge")
      if (!challenge.ok) return grantFailure(invalid(challenge.reason))
      const termsDigest = readIdentifier(input.termsDigest, "termsDigest")
      if (!termsDigest.ok) return grantFailure(invalid(termsDigest.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return grantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const confirmed = current.ledger.confirmCorrectionGrant({
        challenge: challenge.value,
        taskId: taskID.value,
        callerSessionId: caller.value,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        generation: input.generation,
        termsDigest: termsDigest.value,
        deployment: input.deployment,
        at: options.now?.() ?? Date.now(),
      })
      if (!confirmed.ok) return grantFailure(mapLedgerFailure(confirmed.code, confirmed.detail))
      notify()
      const built = taskView(confirmed.value.task, current.ledger)
      if ("failure" in built) return grantFailure(built.failure)
      return {
        ok: true,
        challenge: null,
        task: built.view,
        capability: capabilityFor(built.view),
        controls: watchControls(built.view),
        failure: null,
      }
    },

    downgradeGrant(input) {
      if (closing) return grantFailure(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return grantFailure(invalid(caller.reason))
      const taskID = readIdentifier(input.taskID, "taskID")
      if (!taskID.ok) return grantFailure(invalid(taskID.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return grantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const downgraded = current.ledger.downgradeCorrection({
        taskId: taskID.value,
        callerSessionId: caller.value,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        at: options.now?.() ?? Date.now(),
      })
      if (!downgraded.ok) return grantFailure(mapLedgerFailure(downgraded.code, downgraded.detail))
      notify()
      const built = taskView(downgraded.value.task, current.ledger)
      if ("failure" in built) return grantFailure(built.failure)
      return {
        ok: true,
        challenge: null,
        task: built.view,
        capability: capabilityFor(built.view),
        controls: watchControls(built.view),
        failure: null,
      }
    },

    liveTasks() {
      const current = ensure()
      if (current.ledger === undefined) return []
      const listed = current.ledger.listActive()
      return listed.ok ? listed.value : []
    },

    upsertAlert(input) {
      const current = ensure()
      if (current.ledger === undefined) return undefined
      const result = current.ledger.upsertAlert(input)
      return result.ok ? result.value : undefined
    },

    resolveAlert(input) {
      const current = ensure()
      if (current.ledger === undefined) return false
      const result = current.ledger.resolveAlert(input)
      return result.ok ? result.value.changed : false
    },

    alertsFor,

    async notificationFor(sessionID) {
      if (options.sessionAtLocation === undefined) return undefined
      if (!(await options.sessionAtLocation(sessionID))) return undefined
      const current = ensure()
      if (current.ledger === undefined) return undefined
      const shown = current.ledger.show({ sessionID })
      if (!shown.ok || shown.value === null) return undefined
      const task = shown.value
      if (task.watchState === "ended" || task.taskState === "completed") return undefined
      const built = taskView(task, current.ledger)
      if ("failure" in built) return undefined
      return protocolNotice(built.view)
    },

    dispose() {
      closing = true
      closed = true
      state?.ledger?.close()
      state = undefined
    },
  }
}

function protocolNotice(task: WatchTaskView): string {
  const correction = task.correction
  const stop =
    correction.stop === null
      ? ""
      : ` Stop: ${correction.stop.reason}${correction.stop.missingEvidence === null ? "" : ` (${correction.stop.missingEvidence})`}.`
  const pending =
    correction.pending === null
      ? ""
      : " If a correction prompt for this task arrived, use its concrete taskID, attemptID and correlation with the `receipt` operation. The correlation is never in this notice or in `show`; a receipt is not recovery."
  return [
    "[session-peers watch]",
    `A watched task is enrolled for this session: ${task.taskID} (state version ${task.version}).`,
    `Task state: ${task.taskState}. Supervision: ${task.watchState}. Authorization: ${task.mode === "alert" ? "alert-only" : "limited-correction"}.`,
    `Automatic correction: ${correction.actual}; ${correction.actualReason}${stop}`,
    "Automatic policy: up to three permanent attempts for this task, with a fixed problem window and post-attempt observation; no quota reset.",
    correction.actual === "ready"
      ? "Each queue still requires every safety and time-policy gate; manual correction, resume and transfer remain unavailable."
      : "The automatic gate is closed, so no queue is sent; this is a verified-runtime/protocol gate, not a missing code path.",
    "The task goal is not repeated in this system notice; read it with",
    `peers({ action: "watch", watch: { operation: "show", taskID: ${JSON.stringify(task.taskID)} } }) when needed.`,
    "This notice is not a request to start a new turn. Report only a real state change or new result:",
    `peers({ action: "watch", watch: { operation: "report", taskID: ${JSON.stringify(task.taskID)}, expectedVersion: ${task.version}, reportId: "<new id>", kind: "begin|progress|waiting|blocked|completed", evidence: { ... } } })`,
    "begin needs no evidence; progress/completed need summary and reference; waiting needs waitKind, waitFor, reason and reference; blocked needs reason.",
    "A waiting report may add waitID and waitUntil; a later report clears only the named wait with clearsWaitID plus clearEvidence.",
    "Reporting completion ends supervision because the task is done. Do not repeat completed side effects to report." + pending,
  ].join("\n")
}

function closingFailure(): WatchFailure {
  return { code: "E_WATCH_UNAVAILABLE", reason: "The watch application is closing; no action was taken." }
}

function invalid(reason: string): WatchFailure {
  return { code: "E_WATCH_INVALID", reason }
}

function unsupported(reason: string): WatchFailure {
  return { code: "E_WATCH_UNSUPPORTED", reason }
}

function receiptFailure(failure: WatchFailure): WatchReceiptOutcome {
  return {
    ok: false,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    alerts: emptyWatchAlerts(false, failure.reason),
    failure,
    continuePermit: false,
    duplicate: false,
    seen: false,
    refusalReason: null,
  }
}

function tryRecovery(
  ledger: WatchLedger,
  task: WatchTaskRecord,
  callerSessionId: string,
  reportID: string,
  reference: string,
  at: number,
  notify: () => void,
): void {
  const snapshot = ledger.correction(task.taskID)
  if (!snapshot.ok) return
  const receipted = snapshot.value.attempts.find(
    (attempt) => attempt.phase === "receipted" && isCorrectionAttemptOpen(attempt),
  )
  if (receipted === undefined) return
  const recovered = ledger.recordCorrectionRecovery({
    taskId: task.taskID,
    reservationId: receipted.reservationID,
    callerSessionId,
    progressReportId: reportID,
    resultReference: reference,
    generation: task.generation,
    at,
  })
  if (recovered.ok) notify()
}

function grantFailure(failure: WatchFailure): WatchGrantOutcome {
  return {
    ok: false,
    challenge: null,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    failure,
  }
}

function failureOutcome(failure: WatchFailure): WatchOutcome {
  return {
    ok: false,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    alerts: emptyWatchAlerts(false, failure.reason),
    failure,
    created: false,
    duplicate: false,
    changed: false,
  }
}

export function emptyWatchAlerts(available: boolean, reason: string | null): WatchAlertsView {
  return { items: [], unread: 0, total: 0, active: 0, truncated: false, available, reason }
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
    case "unknown_wait":
      return make("E_WATCH_NOT_FOUND", `No active reported wait matches "${detail}".`)
    case "not_granted":
      return make("E_WATCH_UNSUPPORTED", `No active correction grant matches this task. (${detail})`)
    case "grant_pending":
      return make("E_WATCH_STALE", `A correction grant challenge is already pending; re-read the task. (${detail})`)
    case "grant_expired":
      return make("E_WATCH_STALE", `The correction challenge is expired or already consumed. Prepare a new one. (${detail})`)
    case "grant_active":
      return make("E_WATCH_INVALID_TRANSITION", `An active correction grant already exists; downgrade it first. (${detail})`)
    case "attempt_limit":
      return make("E_WATCH_INVALID_TRANSITION", `The task has spent all three permanent correction attempts. (${detail})`)
    case "pending_attempt":
      return make("E_WATCH_INVALID_TRANSITION", `The task still has an unresolved correction attempt. (${detail})`)
    case "session_unresolved":
      return make("E_WATCH_INVALID_TRANSITION", `An older task for this session still has an unresolved correction attempt. (${detail})`)
    case "claim_taken":
      return make("E_WATCH_STALE", `The one send slot for that reservation is already claimed. (${detail})`)
    case "stale_owner":
      return make("E_WATCH_STALE", `The current activation does not own that task or reservation. (${detail})`)
    case "stale_generation":
      return make("E_WATCH_STALE", `The task or reservation generation changed. (${detail})`)
    case "not_claimable":
      return make("E_WATCH_INVALID_TRANSITION", `The correction attempt cannot take that action now. (${detail})`)
    case "receipt_conflict":
      return make("E_WATCH_REPORT_CONFLICT", `That correction receipt does not match the reservation. (${detail})`)
    case "recovery_evidence_missing":
      return make("E_WATCH_INVALID_TRANSITION", `Recovery evidence is missing or reused. (${detail})`)
    case "unknown_alert":
      return make("E_WATCH_NOT_FOUND", `No persistent alert matches "${detail}".`)
    case "wait_limit":
      return make("E_WATCH_INVALID_TRANSITION", "Too many active reported waits; clear one before adding another.")
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
