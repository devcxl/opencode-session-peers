/**
 * The independent child-delegation view contract.
 *
 * It deliberately does not change `WatchTaskView` or `watchTaskSchema`: the
 * existing task panel keeps its shape, while this view wraps one authorized
 * child task plus the delegation source. An unauthorized child returns only
 * identifiers and grant metadata; goal, reports and alerts are absent.
 */

import type { WatchAlertsView, WatchMode, WatchTaskView } from "../domain/watch.ts"
import type { DelegationGrantRecord } from "./delegation.ts"
import type { DelegatedAuthorityCheck } from "./delegation-authority.ts"

export interface DelegationGrantView {
  readonly grantID: string
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly mode: WatchMode
  readonly state: "granted" | "revoked"
  readonly version: number
  readonly generation: number
  readonly targetSessionID: string
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly reviewSummary: string
  readonly deployment: "single-host-same-location" | null
  readonly grantedAt: number
  readonly revokedAt: number | null
}

export interface DelegatedChildAuthorization {
  readonly allowed: boolean
  /** A bounded reason; never the child's goal or report content. */
  readonly reason: string | null
  readonly grantID: string | null
  readonly grantVersion: number | null
  readonly mode: WatchMode | null
  readonly scopeDirectory: string | null
  readonly scopePeerScope: string | null
  /** Whether the scope came from a roster record, this instance's config, or was unknown. */
  readonly scopeSource: "recorded" | "configured" | "unknown"
  readonly checkedAt: number
}

export interface DelegatedChildView {
  readonly taskID: string
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly targetSessionID: string
  readonly authorized: boolean
  readonly authorization: DelegatedChildAuthorization
  /** Present only when the fresh authority check allowed the read. */
  readonly task: WatchTaskView | null
  readonly alerts: WatchAlertsView | null
}

export interface WatchDelegationFailure {
  readonly code: string
  readonly reason: string
}

export interface WatchDelegationView {
  readonly ok: boolean
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly grants: readonly DelegationGrantView[]
  readonly children: readonly DelegatedChildView[]
  readonly failure: WatchDelegationFailure | null
}

export function delegationGrantView(record: DelegationGrantRecord): DelegationGrantView {
  return {
    grantID: record.grantID,
    parentTaskID: record.parentTaskID,
    parentSessionID: record.parentSessionID,
    mode: record.mode,
    state: record.state,
    version: record.version,
    generation: record.generation,
    targetSessionID: record.scopeTargetSessionID,
    scopeDirectory: record.scopeDirectory,
    scopePeerScope: record.scopePeerScope,
    reviewSummary: record.reviewSummary,
    deployment: record.deployment ?? null,
    grantedAt: record.grantedAt,
    revokedAt: record.revokedAt ?? null,
  }
}

/**
 * One child in the parent's view. The caller supplies the built task view only
 * after the fresh check; this function cannot turn a denied check into content.
 */
export function delegatedChildView(input: {
  readonly taskID: string
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly targetSessionID: string
  readonly grant: DelegationGrantRecord | null
  readonly checked: DelegatedAuthorityCheck
  readonly task: WatchTaskView | null
  readonly alerts: WatchAlertsView | null
}): DelegatedChildView {
  const authorized = input.checked.required && input.checked.allowed
  return {
    taskID: input.taskID,
    parentTaskID: input.parentTaskID,
    parentSessionID: input.parentSessionID,
    targetSessionID: input.targetSessionID,
    authorized,
    authorization: {
      allowed: authorized,
      reason: authorized ? null : (input.checked.missingEvidence ?? input.checked.stopReason),
      grantID: input.checked.grantID ?? input.grant?.grantID ?? null,
      grantVersion: input.checked.grantVersion ?? input.grant?.version ?? null,
      mode: input.grant?.mode ?? null,
      scopeDirectory: input.grant?.scopeDirectory ?? null,
      scopePeerScope: input.grant?.scopePeerScope ?? null,
      scopeSource: input.checked.scopeSource,
      checkedAt: input.checked.checkedAt,
    },
    task: authorized ? input.task : null,
    alerts: authorized ? input.alerts : null,
  }
}
