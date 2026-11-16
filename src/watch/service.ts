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
  type Checked,
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
import {
  delegationEnrollmentGate,
  delegationGrantGate,
  readDelegationMode,
  readDelegationScope,
  WATCH_DELEGATION_TERMS,
  type DelegationChallenge,
  type DelegationStopReason,
} from "./delegation.ts"
import { delegatedChildView, delegationGrantView, type WatchDelegationView } from "./delegation-view.ts"
import type { DelegatedAuthorityCheck, DelegationAuthority } from "./delegation-authority.ts"
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

/** The independent controlled delegation review; no model tool can reach it. */
export interface WatchDelegationGrantOutcome {
  readonly ok: boolean
  readonly challenge: DelegationChallenge | null
  readonly grant: ReturnType<typeof delegationGrantView> | null
  readonly task: WatchTaskView | null
  readonly capability: ReturnType<typeof watchCapability>
  readonly controls: ReturnType<typeof watchControls>
  readonly review: {
    readonly delegationTerms: string
    readonly correctionTerms: string
    readonly deploymentRequired: boolean
    /** True only for a limited grant, which derives the child correction grant. */
    readonly derivesCorrectionGrant: boolean
  }
  readonly failure: WatchFailure | null
}

/** The typed fresh verdict a parent/executor must await before a delegated action. */
export interface DelegatedAuthorityVerdict {
  readonly required: boolean
  readonly allowed: boolean
  readonly reason: string | null
  readonly check: DelegatedAuthorityCheck | null
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
  /** Enroll one host-verified direct child under an active controlled delegation grant. */
  delegate(input: {
    readonly callerSessionID: string
    readonly parentTaskID: string
    readonly targetSessionID: string
    readonly requestID: string
    readonly goal: string
    readonly mode?: WatchMode | string
    readonly expectedVersion: number
  }): Promise<WatchOutcome>
  /** Controlled-surface delegation review; never a model tool path. */
  prepareDelegationGrant(input: {
    readonly callerSessionID: string
    readonly parentTaskID: string
    readonly expectedVersion: number
    readonly targetSessionID: string
    readonly mode: WatchMode | string
    readonly deployment?: "single-host-same-location"
  }): Promise<WatchDelegationGrantOutcome>
  confirmDelegationGrant(input: {
    readonly callerSessionID: string
    readonly parentTaskID: string
    readonly expectedVersion: number
    readonly generation: number
    readonly targetSessionID: string
    readonly mode: WatchMode | string
    readonly scopeDirectory: string
    readonly scopePeerScope: string
    readonly termsDigest: string
    readonly challenge: string
    readonly deployment?: "single-host-same-location"
  }): Promise<WatchDelegationGrantOutcome>
  revokeDelegationGrant(input: {
    readonly callerSessionID: string
    readonly parentTaskID: string
    readonly targetSessionID: string
    readonly expectedVersion: number
  }): Promise<WatchDelegationGrantOutcome>
  /** The parent's active, read-only child view. It never prompts. */
  delegationView(input: {
    readonly sessionID: string
    readonly parentTaskID: string
  }): Promise<WatchDelegationView>
  /**
   * Fresh delegated authority for a reserve/claim/receipt caller. A self task
   * needs no check; a delegated task with no helper is refused, not opened.
   */
  checkDelegatedAuthority(taskID: string): Promise<DelegatedAuthorityVerdict>
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
  }): Promise<WatchReceiptOutcome>
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
  /**
   * Fresh delegated-child checks; absent means a delegated action is refused.
   * A factory receives the application's own ledger handle, so a caller does
   * not open a second authority database or pass a stale handle.
   */
  readonly delegation?:
    | DelegationAuthority
    | ((ledger: Pick<WatchLedger, "delegatedAuthority">) => DelegationAuthority)
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
    const shown =
      taskID === undefined
        ? current.ledger.ownTask(sessionID)
        : current.ledger.show({ sessionID, taskID })
    if (!shown.ok) {
      return { outcome: failureOutcome(mapLedgerFailure(shown.code, shown.detail)), ledger: current.ledger }
    }
    let task: WatchTaskView | null = null
    if (shown.value !== null) {
      if (isDelegatedChild(current.ledger, shown.value, sessionID)) {
        return {
          outcome: failureOutcome({
            code: "E_WATCH_UNSUPPORTED",
            reason:
              "A delegated child's details are available only through the delegation view after a fresh authority check.",
          }),
          ledger: current.ledger,
        }
      }
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

  let delegationInstance: DelegationAuthority | undefined
  const delegationFor = (ledger: WatchLedger): DelegationAuthority | undefined => {
    if (options.delegation === undefined) return undefined
    if (typeof options.delegation !== "function") return options.delegation
    delegationInstance ??= options.delegation(ledger)
    return delegationInstance
  }

  const checkDelegated = async (taskID: string): Promise<DelegatedAuthorityVerdict> => {
    const current = ensure()
    if (current.ledger === undefined) {
      return {
        required: true,
        allowed: false,
        reason: `ledger ${current.failure?.code ?? "ledger_error"}`,
        check: null,
      }
    }
    const snapshot = current.ledger.delegatedAuthority(taskID)
    if (!snapshot.ok) {
      return { required: true, allowed: false, reason: `ledger ${snapshot.code}`, check: null }
    }
    if (snapshot.value.link === null) {
      return { required: false, allowed: true, reason: null, check: null }
    }
    if (closing) return { required: true, allowed: false, reason: "closing", check: null }
    const delegation = delegationFor(current.ledger)
    if (delegation === undefined) {
      return { required: true, allowed: false, reason: "delegation-guard-unavailable", check: null }
    }
    try {
      const check = await delegation.check(taskID)
      return {
        required: check.required,
        allowed: check.allowed,
        reason: check.allowed ? null : (check.missingEvidence ?? check.stopReason ?? "delegated authority is not valid"),
        check,
      }
    } catch {
      return { required: true, allowed: false, reason: "delegation-guard-failed", check: null }
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

    async delegate(input) {
      if (closing) return failureOutcome(closingFailure())
      const caller = readIdentifier(input.callerSessionID, "callerSessionID")
      if (!caller.ok) return failureOutcome(invalid(caller.reason))
      const parentTaskID = readIdentifier(input.parentTaskID, "parentTaskID")
      if (!parentTaskID.ok) return failureOutcome(invalid(parentTaskID.reason))
      const target = readIdentifier(input.targetSessionID, "targetSessionID")
      if (!target.ok) return failureOutcome(invalid(target.reason))
      const requestID = readIdentifier(input.requestID, "requestID")
      if (!requestID.ok) return failureOutcome(invalid(requestID.reason))
      const goal = readGoal(input.goal)
      if (!goal.ok) return failureOutcome(invalid(goal.reason))
      const mode = readDelegationMode(input.mode ?? "alert")
      if (!mode.ok) return failureOutcome(invalid(mode.reason))
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        return failureOutcome(invalid("expectedVersion must be a positive integer"))
      }
      const current = ensure()
      if (current.ledger === undefined) {
        return failureOutcome(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const delegation = delegationFor(current.ledger)
      if (delegation === undefined) {
        return failureOutcome(unsupported("The delegated-authority guard is not wired at this location; no child was enrolled."))
      }
      const parentShown = current.ledger.show({ sessionID: caller.value, taskID: parentTaskID.value })
      if (!parentShown.ok) return failureOutcome(mapLedgerFailure(parentShown.code, parentShown.detail))
      if (parentShown.value === null) {
        return failureOutcome({ code: "E_WATCH_NOT_FOUND", reason: "No parent task matches that id for this session." })
      }
      const parentTask = parentShown.value
      const grantResult = current.ledger.delegationGrantFor({
        parentTaskID: parentTask.taskID,
        targetSessionID: target.value,
      })
      if (!grantResult.ok) return failureOutcome(mapLedgerFailure(grantResult.code, grantResult.detail))
      const children = current.ledger.listDelegatedChildren(parentTask.taskID)
      if (!children.ok) return failureOutcome(mapLedgerFailure(children.code, children.detail))
      // A completed/ended child is history: an explicit new delegation may
      // create a new task, and a repeated request is resolved by the ledger's
      // idempotency below. Only a live task can occupy the child's one slot.
      const existingLink = children.value.find(
        (entry) =>
          entry.task.targetSessionID === target.value &&
          (entry.task.watchState === "active" || entry.task.watchState === "paused"),
      )
      const existingChild =
        existingLink === undefined
          ? null
          : {
              task: existingLink.task,
              delegatedByThisGrant:
                grantResult.value !== null && existingLink.link.grantID === grantResult.value.grantID,
            }

      const [parentFacts, childFacts] = await Promise.all([
        delegation.facts(parentTask.targetSessionID),
        delegation.facts(target.value),
      ])
      if (closing) return failureOutcome(closingFailure())
      const gate = delegationEnrollmentGate(
        {
          parentTask,
          parent: parentFacts.session,
          child: childFacts.session,
          parentScope: parentFacts.scope?.scope ?? null,
          childScope: childFacts.scope?.scope ?? null,
          grant: grantResult.value,
          existingChild,
          ownerActivation: options.activationID,
          closing,
        },
        {
          parentTaskID: parentTask.taskID,
          targetSessionID: target.value,
          mode: mode.value,
          requestID: requestID.value,
          goal: goal.value,
        },
      )
      if (!gate.allowed) {
        return failureOutcome(delegationFailure(gate.stopReason, gate.missingEvidence))
      }
      if (parentFacts.session === null || childFacts.session === null || childFacts.scope === null) {
        return failureOutcome(delegationFailure("authority-unknown", "fresh host facts disappeared before enrollment"))
      }
      if (grantResult.value === null) {
        return failureOutcome(delegationFailure("grant-missing", "the delegation grant disappeared before enrollment"))
      }
      const enrolled = current.ledger.delegatedEnroll({
        requestId: requestID.value,
        initiatorSessionId: caller.value,
        targetSessionId: target.value,
        parentTaskId: parentTask.taskID,
        goal: goal.value,
        mode: mode.value,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        grantId: grantResult.value.grantID,
        grantVersion: grantResult.value.version,
        verifiedParentId: parentFacts.session.id,
        verifiedDirectory: childFacts.session.directory,
        verifiedScope: childFacts.scope.scope,
        verifiedScopeSource: childFacts.scope.source,
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
        duplicate: !enrolled.value.created,
        changed: enrolled.value.created,
      }
    },

    async prepareDelegationGrant(input) {
      if (closing) return delegationGrantFailure(closingFailure())
      const validation = readDelegationGrantRequest(input)
      if (!validation.ok) return delegationGrantFailure(invalid(validation.reason))
      const current = ensure()
      if (current.ledger === undefined) {
        return delegationGrantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const delegation = delegationFor(current.ledger)
      if (delegation === undefined) {
        return delegationGrantFailure(unsupported("The delegated-authority guard is not wired at this location; no challenge was prepared."))
      }
      const parent = current.ledger.show({ sessionID: validation.value.callerSessionID, taskID: validation.value.parentTaskID })
      if (!parent.ok) return delegationGrantFailure(mapLedgerFailure(parent.code, parent.detail))
      if (parent.value === null) {
        return delegationGrantFailure({ code: "E_WATCH_NOT_FOUND", reason: "No parent task matches that id for this session." })
      }
      const existing = current.ledger.delegationGrantFor({
        parentTaskID: validation.value.parentTaskID,
        targetSessionID: validation.value.targetSessionID,
      })
      if (!existing.ok) return delegationGrantFailure(mapLedgerFailure(existing.code, existing.detail))
      const [parentFacts, childFacts] = await Promise.all([
        delegation.facts(parent.value.targetSessionID),
        delegation.facts(validation.value.targetSessionID),
      ])
      if (closing) return delegationGrantFailure(closingFailure())
      const gate = delegationGrantGate({
        parentTask: parent.value,
        callerSessionID: validation.value.callerSessionID,
        ownerActivation: options.activationID,
        expectedVersion: validation.value.expectedVersion,
        targetSessionID: validation.value.targetSessionID,
        mode: validation.value.mode,
        parent: parentFacts.session,
        child: childFacts.session,
        parentScope: parentFacts.scope?.scope ?? null,
        childScope: childFacts.scope?.scope ?? null,
        existingGrant: existing.value,
        closing,
      })
      if (!gate.allowed) {
        return delegationGrantFailure(delegationFailure(gate.stopReason, gate.missingEvidence))
      }
      if (childFacts.session === null || childFacts.scope === null) {
        return delegationGrantFailure(delegationFailure("authority-unknown", "fresh host facts disappeared before the review"))
      }
      const prepared = current.ledger.prepareDelegationGrant({
        taskId: parent.value.taskID,
        callerSessionId: validation.value.callerSessionID,
        ownerActivation: options.activationID,
        expectedVersion: validation.value.expectedVersion,
        targetSessionId: validation.value.targetSessionID,
        mode: validation.value.mode,
        scopeDirectory: childFacts.session.directory,
        scopePeerScope: childFacts.scope.scope,
        ...(validation.value.deployment === undefined ? {} : { deployment: validation.value.deployment }),
        at: options.now?.() ?? Date.now(),
      })
      if (!prepared.ok) return delegationGrantFailure(mapLedgerFailure(prepared.code, prepared.detail))
      const built = taskView(parent.value, current.ledger)
      if ("failure" in built) return delegationGrantFailure(built.failure)
      return {
        ...delegationGrantSuccess(built.view),
        challenge: prepared.value,
        review: {
          delegationTerms: WATCH_DELEGATION_TERMS,
          correctionTerms: WATCH_CORRECTION_TERMS,
          deploymentRequired: validation.value.mode === "limited-correction",
          derivesCorrectionGrant: validation.value.mode === "limited-correction",
        },
      }
    },

    async confirmDelegationGrant(input) {
      if (closing) return delegationGrantFailure(closingFailure())
      const challenge = readIdentifier(input.challenge, "challenge")
      if (!challenge.ok) return delegationGrantFailure(invalid(challenge.reason))
      const parentTaskID = readIdentifier(input.parentTaskID, "parentTaskID")
      if (!parentTaskID.ok) return delegationGrantFailure(invalid(parentTaskID.reason))
      const target = readIdentifier(input.targetSessionID, "targetSessionID")
      if (!target.ok) return delegationGrantFailure(invalid(target.reason))
      const scopeDirectory = readDelegationScopeText(input.scopeDirectory, "scopeDirectory")
      if (!scopeDirectory.ok) return delegationGrantFailure(invalid(scopeDirectory.reason))
      const scopePeerScope = readDelegationScopeText(input.scopePeerScope, "scopePeerScope")
      if (!scopePeerScope.ok) return delegationGrantFailure(invalid(scopePeerScope.reason))
      const termsDigest = readIdentifier(input.termsDigest, "termsDigest")
      if (!termsDigest.ok) return delegationGrantFailure(invalid(termsDigest.reason))
      const mode = readDelegationMode(input.mode)
      if (!mode.ok) return delegationGrantFailure(invalid(mode.reason))
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        return delegationGrantFailure(invalid("expectedVersion must be a positive integer"))
      }
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
        return delegationGrantFailure(invalid("generation must be a positive integer"))
      }
      const current = ensure()
      if (current.ledger === undefined) {
        return delegationGrantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const confirmed = current.ledger.confirmDelegationGrant({
        challenge: challenge.value,
        taskId: parentTaskID.value,
        callerSessionId: input.callerSessionID,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        generation: input.generation,
        targetSessionId: target.value,
        mode: mode.value,
        scopeDirectory: scopeDirectory.value,
        scopePeerScope: scopePeerScope.value,
        termsDigest: termsDigest.value,
        ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
        at: options.now?.() ?? Date.now(),
      })
      if (!confirmed.ok) return delegationGrantFailure(mapLedgerFailure(confirmed.code, confirmed.detail))
      notify()
      const built = taskView(confirmed.value.task, current.ledger)
      if ("failure" in built) return delegationGrantFailure(built.failure)
      return {
        ...delegationGrantSuccess(built.view),
        challenge: null,
        grant: delegationGrantView(confirmed.value.grant),
        review: {
          delegationTerms: WATCH_DELEGATION_TERMS,
          correctionTerms: WATCH_CORRECTION_TERMS,
          deploymentRequired: mode.value === "limited-correction",
          derivesCorrectionGrant: mode.value === "limited-correction",
        },
      }
    },

    async revokeDelegationGrant(input) {
      if (closing) return delegationGrantFailure(closingFailure())
      const parentTaskID = readIdentifier(input.parentTaskID, "parentTaskID")
      if (!parentTaskID.ok) return delegationGrantFailure(invalid(parentTaskID.reason))
      const target = readIdentifier(input.targetSessionID, "targetSessionID")
      if (!target.ok) return delegationGrantFailure(invalid(target.reason))
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        return delegationGrantFailure(invalid("expectedVersion must be a positive integer"))
      }
      const current = ensure()
      if (current.ledger === undefined) {
        return delegationGrantFailure(mapLedgerFailure(current.failure?.code ?? "ledger_error", current.failure?.detail ?? "unknown"))
      }
      const revoked = current.ledger.revokeDelegationGrant({
        parentTaskId: parentTaskID.value,
        targetSessionId: target.value,
        callerSessionId: input.callerSessionID,
        ownerActivation: options.activationID,
        expectedVersion: input.expectedVersion,
        at: options.now?.() ?? Date.now(),
      })
      if (!revoked.ok) return delegationGrantFailure(mapLedgerFailure(revoked.code, revoked.detail))
      if (revoked.value.changed) notify()
      const shown = current.ledger.show({ sessionID: input.callerSessionID, taskID: parentTaskID.value })
      if (!shown.ok) return delegationGrantFailure(mapLedgerFailure(shown.code, shown.detail))
      const built = shown.value === null ? undefined : taskView(shown.value, current.ledger)
      if (built !== undefined && "failure" in built) return delegationGrantFailure(built.failure)
      return {
        ...delegationGrantSuccess(built?.view ?? null),
        challenge: null,
        grant: delegationGrantView(revoked.value.grant),
        review: {
          delegationTerms: WATCH_DELEGATION_TERMS,
          correctionTerms: WATCH_CORRECTION_TERMS,
          deploymentRequired: revoked.value.grant.mode === "limited-correction",
          derivesCorrectionGrant: revoked.value.grant.mode === "limited-correction",
        },
      }
    },

    async delegationView(input) {
      const sessionID = readIdentifier(input.sessionID, "sessionID")
      if (!sessionID.ok) return delegationViewFailure("E_WATCH_INVALID", sessionID.reason, "")
      const parentTaskID = readIdentifier(input.parentTaskID, "parentTaskID")
      if (!parentTaskID.ok) return delegationViewFailure("E_WATCH_INVALID", parentTaskID.reason, "")
      const current = ensure()
      if (current.ledger === undefined) {
        return delegationViewFailure(
          "E_WATCH_UNAVAILABLE",
          current.failure?.detail ?? "the watch ledger is unavailable",
          parentTaskID.value,
        )
      }
      const parent = current.ledger.show({ sessionID: sessionID.value, taskID: parentTaskID.value })
      if (!parent.ok) return delegationViewFailure("E_WATCH_UNAVAILABLE", parent.detail, parentTaskID.value)
      if (parent.value === null) return delegationViewFailure("E_WATCH_NOT_FOUND", "no such parent task", parentTaskID.value)
      const parentTask = parent.value
      if (
        parentTask.initiatorSessionID !== sessionID.value ||
        parentTask.targetSessionID !== sessionID.value
      ) {
        return delegationViewFailure(
          "E_WATCH_UNSUPPORTED",
          "only the parent's own self-enrolled task has a delegation view",
          parentTaskID.value,
        )
      }
      const grants = current.ledger.delegationGrantsFor(parentTask.taskID)
      if (!grants.ok) return delegationViewFailure("E_WATCH_UNAVAILABLE", grants.detail, parentTask.taskID)
      const children = current.ledger.listDelegatedChildren(parentTask.taskID)
      if (!children.ok) return delegationViewFailure("E_WATCH_UNAVAILABLE", children.detail, parentTask.taskID)
      const views = []
      for (const child of children.value) {
        const verdict = await checkDelegated(child.task.taskID)
        if (closing) return delegationViewFailure("E_WATCH_UNAVAILABLE", "the watch application is closing", parentTask.taskID)
        const grant = grants.value.find((entry) => entry.grantID === child.link.grantID) ?? null
        const checked =
          verdict.check ??
          deniedAuthorityCheck({
            taskID: child.task.taskID,
            targetSessionID: child.task.targetSessionID,
            taskVersion: child.task.version,
            generation: child.task.generation,
            parentTaskID: child.link.parentTaskID,
            grantID: child.link.grantID,
            grantVersion: child.link.grantVersion,
            reason: verdict.reason ?? "delegated authority is unavailable",
            checkedAt: options.now?.() ?? Date.now(),
          })
        let taskViewValue: WatchTaskView | null = null
        let alerts: WatchAlertsView | null = null
        if (checked.required && checked.allowed) {
          const built = taskView(child.task, current.ledger)
          if (!("failure" in built)) {
            taskViewValue = built.view
            alerts = alertsFor(child.task.taskID)
          }
        }
        views.push(
          delegatedChildView({
            taskID: child.task.taskID,
            parentTaskID: child.link.parentTaskID,
            parentSessionID: child.link.parentSessionID,
            targetSessionID: child.task.targetSessionID,
            grant,
            checked,
            task: taskViewValue,
            alerts,
          }),
        )
      }
      return {
        ok: true,
        parentTaskID: parentTask.taskID,
        parentSessionID: parentTask.targetSessionID,
        grants: grants.value.map(delegationGrantView),
        children: views,
        failure: null,
      }
    },

    checkDelegatedAuthority(taskID) {
      const id = readIdentifier(taskID, "taskID")
      if (!id.ok) {
        return Promise.resolve({ required: true, allowed: false, reason: id.reason, check: null })
      }
      return checkDelegated(id.value)
    },

    async receipt(input) {
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
      let authorityRefusalReason: string | undefined
      const link = current.ledger.delegatedTaskLink(taskID.value)
      if (!link.ok) return receiptFailure(mapLedgerFailure(link.code, link.detail))
      if (link.value !== null) {
        const verdict = await checkDelegated(taskID.value)
        if (closing) return receiptFailure(closingFailure())
        if (!verdict.allowed) {
          authorityRefusalReason = `delegation-${verdict.reason ?? "authority-unknown"}`
        }
      }
      const received = current.ledger.recordCorrectionReceipt({
        taskId: taskID.value,
        reservationId: attemptID.value,
        callerSessionId: caller.value,
        currentActivationId: options.activationID,
        correlation: correlation.value,
        ...(authorityRefusalReason === undefined ? {} : { authorityRefusalReason }),
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
      if (isDelegatedChild(current.ledger, controlled.value.task, caller.value)) {
        return redactedDelegatedOutcome(controlled.value.changed)
      }
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
      if (isDelegatedChild(current.ledger, shown.value, caller.value)) {
        return redactedDelegatedOutcome(acked.value.changed)
      }
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
      // Only the session's own target task belongs in its next normal context;
      // a parent does not receive a delegated child's notice through this hook.
      const shown = current.ledger.ownTask(sessionID)
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

/**
 * A successful control/ack for a delegated child must not return the child's
 * goal or report rows to the parent before the delegation view re-authorizes
 * them. The mutation facts are kept; the content is not.
 */
function redactedDelegatedOutcome(changed: boolean): WatchOutcome {
  return {
    ok: true,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    alerts: emptyWatchAlerts(true, null),
    failure: null,
    created: false,
    duplicate: false,
    changed,
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

function isDelegatedChild(ledger: WatchLedger, task: WatchTaskRecord, sessionID: string): boolean {
  if (task.targetSessionID === sessionID) return false
  const link = ledger.delegatedTaskLink(task.taskID)
  // A failed link read cannot prove this is an ordinary self task; redact.
  return !link.ok || link.value !== null
}

function readDelegationScopeText(value: string, field: string): Checked<string> {
  return readDelegationScope(value, field)
}

interface DelegationGrantRequest {
  readonly callerSessionID: string
  readonly parentTaskID: string
  readonly expectedVersion: number
  readonly targetSessionID: string
  readonly mode: WatchMode
  readonly deployment?: "single-host-same-location"
}

function readDelegationGrantRequest(input: {
  readonly callerSessionID: string
  readonly parentTaskID: string
  readonly expectedVersion: number
  readonly targetSessionID: string
  readonly mode: WatchMode | string
  readonly deployment?: "single-host-same-location"
}): Checked<DelegationGrantRequest> {
  const caller = readIdentifier(input.callerSessionID, "callerSessionID")
  if (!caller.ok) return caller
  const parent = readIdentifier(input.parentTaskID, "parentTaskID")
  if (!parent.ok) return parent
  const target = readIdentifier(input.targetSessionID, "targetSessionID")
  if (!target.ok) return target
  const mode = readDelegationMode(input.mode)
  if (!mode.ok) return mode
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { ok: false, reason: "expectedVersion must be a positive integer" }
  }
  if (input.deployment !== undefined && input.deployment !== "single-host-same-location") {
    return { ok: false, reason: "deployment must be single-host-same-location" }
  }
  return {
    ok: true,
    value: {
      callerSessionID: caller.value,
      parentTaskID: parent.value,
      expectedVersion: input.expectedVersion,
      targetSessionID: target.value,
      mode: mode.value,
      ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
    },
  }
}

function delegationFailure(stopReason: DelegationStopReason | null, missingEvidence: string | null): WatchFailure {
  const reason = missingEvidence ?? stopReason ?? "the delegation request is not allowed"
  switch (stopReason) {
    case "parent-not-direct":
    case "parent-unknown":
      return {
        code: "E_WATCH_CALLER_MISMATCH",
        reason: `The host does not prove the requested direct parent: ${reason}`,
      }
    case "grant-stale":
    case "parent-version-stale":
    case "authority-unknown":
      return { code: "E_WATCH_STALE", reason: `The delegation facts changed or are unknown: ${reason}` }
    case "closing":
      return closingFailure()
    case "parent-not-self":
      return {
        code: "E_WATCH_INVALID_TRANSITION",
        reason: `Only a self-enrolled parent task may delegate, one level: ${reason}`,
      }
    case "child-completed":
    case "child-busy":
      return { code: "E_WATCH_INVALID_TRANSITION", reason: `The child cannot be enrolled now: ${reason}` }
    case "grant-active":
      return { code: "E_WATCH_INVALID_TRANSITION", reason: `A delegation grant is already active: ${reason}` }
    default:
      return { code: "E_WATCH_UNSUPPORTED", reason: `The delegation request is refused: ${reason}` }
  }
}

function delegationGrantFailure(failure: WatchFailure): WatchDelegationGrantOutcome {
  return {
    ok: false,
    challenge: null,
    grant: null,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    review: {
      delegationTerms: WATCH_DELEGATION_TERMS,
      correctionTerms: WATCH_CORRECTION_TERMS,
      deploymentRequired: false,
      derivesCorrectionGrant: false,
    },
    failure,
  }
}

function delegationGrantSuccess(task: WatchTaskView | null): WatchDelegationGrantOutcome {
  return {
    ok: true,
    challenge: null,
    grant: null,
    task,
    capability: watchCapability(task?.mode ?? "alert", task?.correction.actual ?? "unavailable"),
    controls: watchControls(task),
    review: {
      delegationTerms: WATCH_DELEGATION_TERMS,
      correctionTerms: WATCH_CORRECTION_TERMS,
      deploymentRequired: false,
      derivesCorrectionGrant: false,
    },
    failure: null,
  }
}

function delegationViewFailure(code: string, reason: string, parentTaskID: string): WatchDelegationView {
  return {
    ok: false,
    parentTaskID,
    parentSessionID: "",
    grants: [],
    children: [],
    failure: { code, reason },
  }
}

function deniedAuthorityCheck(input: {
  readonly taskID: string
  readonly targetSessionID: string
  readonly taskVersion: number
  readonly generation: number
  readonly parentTaskID: string
  readonly grantID: string | null
  readonly grantVersion: number | null
  readonly reason: string
  readonly checkedAt: number
}): DelegatedAuthorityCheck {
  return {
    required: true,
    allowed: false,
    stopReason: "authority-unknown",
    missingEvidence: input.reason,
    gates: [],
    taskID: input.taskID,
    targetSessionID: input.targetSessionID,
    taskVersion: input.taskVersion,
    generation: input.generation,
    parentTaskID: input.parentTaskID,
    parentVersion: null,
    grantID: input.grantID,
    grantVersion: input.grantVersion,
    scopeSource: "unknown",
    checkedAt: input.checkedAt,
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
