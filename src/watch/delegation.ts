/**
 * Pure direct-child delegation policy.
 *
 * A watched task may be a parent's own task or a task the parent delegated to
 * one child. Delegation is not implied by a correction grant, by a model
 * message or by the child being idle: it needs its own controlled grant, the
 * host's direct-parent fact, one location and one visibility scope. This module
 * only names and checks those facts; the ledger records them and the service
 * composes them with the host. It never prompts, generates or interrupts.
 */

import { createHash } from "node:crypto"

import {
  canonicalJson,
  readBoundedText,
  readIdentifier,
  WATCH_CORRECTION_TERMS,
  type Checked,
  type WatchMode,
  type WatchTaskRecord,
} from "../domain/watch.ts"

/** The controlled-surface delegation summary; kept short and separate from the correction terms. */
export const WATCH_DELEGATION_TERMS =
  "Direct-child delegation: one host-verified direct child, one level, in the parent task's location and scope. It sets the child's maximum mode; a limited grant derives that child's correction grant at enrollment but sends nothing and bypasses no gate. It covers no later children, cross-scope work or transfer. Revocation stops new enrollment and correction without retracting accepted messages or resetting spent attempts. Unknown parentage, location, scope or changed relationship is alert-only."

export type DelegationState = "granted" | "revoked"

/**
 * One controlled delegation grant. `parentTaskVersion` records the task
 * version reviewed on the controlled surface; a later task version from a
 * report does not silently widen or regenerate the grant.
 */
export interface DelegationGrantRecord {
  readonly grantID: string
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly parentTaskVersion: number
  /** The activation that confirmed the controlled grant. */
  readonly ownerActivation: string
  readonly mode: WatchMode
  readonly state: DelegationState
  readonly version: number
  readonly generation: number
  readonly scopeTargetSessionID: string
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly deployment?: "single-host-same-location"
  readonly reviewSummary: string
  readonly termsDigest: string
  readonly confirmationID: string
  readonly grantedAt: number
  readonly revokedAt?: number
}

/** The short-lived challenge that only the controlled surface receives. */
export interface DelegationChallenge {
  readonly challenge: string
  readonly parentTaskID: string
  readonly expectedVersion: number
  readonly generation: number
  readonly mode: WatchMode
  readonly targetSessionID: string
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly deployment?: "single-host-same-location"
  readonly termsDigest: string
  readonly reviewSummary: string
  readonly expiresAt: number
}

/** The host's own record of one session; no field here is model-supplied. */
export interface DelegationSessionFact {
  readonly id: string
  /** The host's direct-parent field; absent means "not proven direct". */
  readonly parentID?: string
  readonly directory: string
}

export interface DelegationEnrollmentRequest {
  readonly parentTaskID: string
  readonly targetSessionID: string
  readonly mode: WatchMode
  readonly requestID: string
  readonly goal: string
}

export interface DelegationExistingChild {
  readonly task: WatchTaskRecord
  /** True only when the ledger already links this task to the same grant. */
  readonly delegatedByThisGrant: boolean
}

export interface DelegationEnrollmentFacts {
  readonly parentTask: WatchTaskRecord
  readonly parent: DelegationSessionFact | null
  readonly child: DelegationSessionFact | null
  readonly parentScope: string | null
  readonly childScope: string | null
  readonly grant: DelegationGrantRecord | null
  readonly existingChild: DelegationExistingChild | null
  readonly ownerActivation: string
  readonly closing: boolean
}

export interface DelegationGrantFacts {
  readonly parentTask: WatchTaskRecord
  readonly callerSessionID: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly targetSessionID: string
  readonly mode: WatchMode
  readonly parent: DelegationSessionFact | null
  readonly child: DelegationSessionFact | null
  readonly parentScope: string | null
  readonly childScope: string | null
  readonly existingGrant: DelegationGrantRecord | null
  readonly closing: boolean
}

export type DelegationGate =
  | "closing"
  | "grant"
  | "grant-active"
  | "mode"
  | "parent-task"
  | "parent-origin"
  | "parent-version"
  | "owner"
  | "target"
  | "child"
  | "direct-parent"
  | "location"
  | "scope"
  | "child-state"

export type DelegationStopReason =
  | "closing"
  | "grant-missing"
  | "grant-revoked"
  | "grant-stale"
  | "grant-active"
  | "mode-not-granted"
  | "parent-unknown"
  | "parent-task-inactive"
  | "parent-task-completed"
  | "parent-not-self"
  | "parent-version-stale"
  | "owner-mismatch"
  | "target-not-granted"
  | "child-unknown"
  | "parent-not-direct"
  | "location-mismatch"
  | "scope-mismatch"
  | "child-busy"
  | "child-completed"
  | "authority-unknown"

export interface DelegationGateView {
  readonly gate: DelegationGate
  readonly ok: boolean
  readonly reason: string | null
  readonly observed: string | null
  readonly required: string | null
}

export interface DelegationGateResult {
  readonly allowed: boolean
  readonly stopReason: DelegationStopReason | null
  readonly missingEvidence: string | null
  readonly gates: readonly DelegationGateView[]
  /** The child's business work already started before this enrollment. */
  readonly late: boolean
}

/** The durable link from one child task to the controlled grant that created it. */
export interface DelegatedTaskLink {
  readonly taskID: string
  readonly grantID: string
  readonly grantVersion: number
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly targetSessionID: string
  readonly verifiedParentID: string
  readonly verifiedDirectory: string
  readonly verifiedScope: string
  readonly verifiedScopeSource: "recorded" | "configured"
  readonly verifiedAt: number
}

/**
 * The atomic ledger facts a fresh delegated-authority check starts from. Host
 * facts are deliberately absent: they are read after this snapshot and are
 * never stored here as proof.
 */
export interface DelegatedAuthoritySnapshot {
  readonly task: WatchTaskRecord
  readonly link: DelegatedTaskLink | null
  readonly grant: DelegationGrantRecord | null
  readonly parentTask: WatchTaskRecord | null
}

export interface DelegatedChildRecord {
  readonly task: WatchTaskRecord
  readonly link: DelegatedTaskLink
}

export interface DelegatedAuthorityResult {
  /** False for an ordinary self-enrolled task: its existing behavior is unchanged. */
  readonly required: boolean
  readonly allowed: boolean
  readonly stopReason: DelegationStopReason | null
  readonly missingEvidence: string | null
  readonly gates: readonly DelegationGateView[]
}

/**
 * Checks the durable link against the current source grant and parent task.
 * The caller adds fresh host facts; this function never treats a stored
 * directory, scope or parentID as a current host fact.
 */
export function delegatedAuthorityGate(
  snapshot: DelegatedAuthoritySnapshot,
  facts: {
    readonly parent: DelegationSessionFact | null
    readonly child: DelegationSessionFact | null
    readonly parentScope: string | null
    readonly childScope: string | null
    readonly ownerActivation: string
    readonly closing: boolean
  },
): DelegatedAuthorityResult {
  if (snapshot.link === null) {
    return { required: false, allowed: true, stopReason: null, missingEvidence: null, gates: [] }
  }
  const link = snapshot.link
  const grant = snapshot.grant
  const parentTask = snapshot.parentTask
  if (grant === null) {
    return {
      required: true,
      allowed: false,
      stopReason: "grant-missing",
      missingEvidence: "the source delegation grant no longer exists",
      gates: [gate("grant", false, "missing", "the source delegation grant")],
    }
  }
  if (parentTask === null) {
    return {
      required: true,
      allowed: false,
      stopReason: "parent-unknown",
      missingEvidence: "the parent task no longer exists",
      gates: [gate("parent-task", false, "missing", "the parent task")],
    }
  }
  if (grant.state !== "granted") {
    return {
      required: true,
      allowed: false,
      stopReason: "grant-revoked",
      missingEvidence: "the source delegation grant is not active",
      gates: [gate("grant", false, grant.state, "an active source delegation grant")],
    }
  }
  const expectedDigest = delegationTermsDigest({
    parentTaskID: grant.parentTaskID,
    parentSessionID: grant.parentSessionID,
    targetSessionID: grant.scopeTargetSessionID,
    mode: grant.mode,
    directory: grant.scopeDirectory,
    peerScope: grant.scopePeerScope,
    ownerActivation: grant.ownerActivation,
    generation: grant.generation,
    version: grant.parentTaskVersion,
  })
  if (grant.termsDigest !== expectedDigest) {
    return {
      required: true,
      allowed: false,
      stopReason: "grant-stale",
      missingEvidence: "the delegation or correction terms changed; the old grant cannot continue",
      gates: [gate("grant", false, "digest-changed", "the current canonical delegation and correction terms")],
    }
  }
  const linkFresh =
    link.grantID === grant.grantID &&
    link.grantVersion === grant.version &&
    link.parentTaskID === grant.parentTaskID &&
    link.parentSessionID === grant.parentSessionID &&
    link.targetSessionID === snapshot.task.targetSessionID &&
    link.verifiedDirectory === grant.scopeDirectory &&
    link.verifiedScope === grant.scopePeerScope
  if (!linkFresh) {
    return {
      required: true,
      allowed: false,
      stopReason: "grant-stale",
      missingEvidence: "the child task's delegation link no longer matches its source grant",
      gates: [
        gate(
          "grant",
          false,
          `link=${link.grantID}@${link.grantVersion}; grant=${grant.grantID}@${grant.version}`,
          "a link bound to the current source grant version",
        ),
      ],
    }
  }
  const result = delegationEnrollmentGate(
    {
      parentTask,
      parent: facts.parent,
      child: facts.child,
      parentScope: facts.parentScope,
      childScope: facts.childScope,
      grant,
      // Reading a completed child is allowed; the correction gate separately
      // refuses a completed business task. This gate only says whether the
      // delegation authorization still covers the child.
      existingChild: null,
      ownerActivation: facts.ownerActivation,
      closing: facts.closing,
    },
    {
      parentTaskID: link.parentTaskID,
      targetSessionID: snapshot.task.targetSessionID,
      mode: snapshot.task.mode,
      requestID: `authority-${snapshot.task.taskID}`,
      goal: snapshot.task.goal,
    },
  )
  return {
    required: true,
    allowed: result.allowed,
    stopReason: result.stopReason,
    missingEvidence: result.missingEvidence,
    gates: result.gates,
  }
}

export function readDelegationMode(value: unknown): Checked<WatchMode> {
  if (value === "alert" || value === "limited-correction") return { ok: true, value }
  return { ok: false, reason: "mode must be alert or limited-correction" }
}

export function readDelegationScope(value: unknown, field: string): Checked<string> {
  return readBoundedText(value, field, 128)
}

/**
 * Stable terms digest for the controlled challenge; not a secret. It binds both
 * canonical texts and the parent/target/mode/scope/owner/generation/version, so
 * a later correction-terms or delegation-scope change cannot reuse an old
 * challenge.
 */
export function delegationTermsDigest(input: {
  readonly parentTaskID: string
  readonly parentSessionID: string
  readonly targetSessionID: string
  readonly mode: WatchMode
  readonly directory: string
  readonly peerScope: string
  readonly ownerActivation: string
  readonly generation: number
  readonly version: number
}): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        WATCH_DELEGATION_TERMS,
        WATCH_CORRECTION_TERMS,
        input.parentTaskID,
        input.parentSessionID,
        input.targetSessionID,
        input.mode,
        input.directory,
        input.peerScope,
        input.ownerActivation,
        input.generation,
        input.version,
      ]),
    )
    .digest("hex")
}

/** Whether a concrete enrollment request is inside its controlled grant. */
export function delegationEnrollmentGate(
  facts: DelegationEnrollmentFacts,
  request: DelegationEnrollmentRequest,
): DelegationGateResult {
  const parentTask = facts.parentTask
  const parent = facts.parent
  const child = facts.child
  const grant = facts.grant
  const gates: DelegationGateView[] = []

  gates.push(
    gate(
      "closing",
      !facts.closing,
      facts.closing ? "closing" : "open",
      "an open watch application",
    ),
  )
  if (facts.closing) return stop(gates, "closing", false)

  const parentKnown = request.parentTaskID === parentTask.taskID && parent !== null && parent.id === parentTask.targetSessionID
  gates.push(
    gate(
      "parent-task",
      parentKnown,
      parentKnown ? parentTask.taskID : `request=${request.parentTaskID}; host=${parent?.id ?? "unknown"}`,
      "the enrolled parent task and its host-verified parent session",
    ),
  )
  if (!parentKnown) return stop(gates, "parent-unknown", false)

  const grantFresh =
    grant !== null &&
    grant.state === "granted" &&
    grant.parentTaskID === parentTask.taskID &&
    grant.parentSessionID === parentTask.targetSessionID &&
    grant.ownerActivation === parentTask.ownerActivation &&
    grant.generation === parentTask.generation &&
    grant.parentTaskVersion <= parentTask.version
  gates.push(
    gate(
      "grant",
      grant !== null && grant.state === "granted",
      grant === null ? "none" : `${grant.state} version ${grant.version} generation ${grant.generation}`,
      "an active controlled delegation grant",
    ),
  )
  gates.push(
    gate(
      "grant-active",
      grantFresh,
      grant === null
        ? "none"
        : `${grant.parentTaskID}/${grant.parentSessionID}; parent task version ${parentTask.version}, granted at ${grant.parentTaskVersion}`,
      "a grant bound to this parent task and current generation",
    ),
  )
  if (grant === null) return stop(gates, "grant-missing", false)
  if (grant.state !== "granted") return stop(gates, "grant-revoked", false)
  if (!grantFresh) return stop(gates, "grant-stale", false)

  const targetGranted = grant.scopeTargetSessionID === request.targetSessionID
  gates.push(
    gate(
      "target",
      targetGranted,
      targetGranted ? request.targetSessionID : `grant=${grant.scopeTargetSessionID}; request=${request.targetSessionID}`,
      "the one concrete child named by the grant",
    ),
  )
  if (!targetGranted) return stop(gates, "target-not-granted", false)

  const requestedMode = readDelegationMode(request.mode)
  const modeAllowed = requestedMode.ok && modeRank(requestedMode.value) <= modeRank(grant.mode)
  gates.push(
    gate(
      "mode",
      modeAllowed,
      requestedMode.ok ? `${requestedMode.value} within ${grant.mode}` : requestedMode.reason,
      "a mode no wider than the controlled grant",
    ),
  )
  if (!modeAllowed) return stop(gates, "mode-not-granted", false)

  const parentSelf = parentTask.initiatorSessionID === parentTask.targetSessionID
  gates.push(
    gate("parent-origin", parentSelf, parentSelf ? "self-enrolled" : "delegated", "a self-enrolled parent task; no recursion"),
  )
  if (!parentSelf) return stop(gates, "parent-not-self", false)

  if (parentTask.taskState === "completed") {
    gates.push(gate("parent-task", false, "completed", "an unfinished parent task"))
    return stop(gates, "parent-task-completed", false)
  }
  if (parentTask.watchState !== "active") {
    gates.push(gate("parent-task", false, parentTask.watchState, "an active parent watch"))
    return stop(gates, "parent-task-inactive", false)
  }

  const ownerOk = parentTask.ownerActivation === facts.ownerActivation
  gates.push(
    gate("owner", ownerOk, ownerOk ? "this activation" : "another activation", "the current owner activation"),
  )
  if (!ownerOk) return stop(gates, "owner-mismatch", false)

  const childKnown = child !== null && child.id === request.targetSessionID
  gates.push(
    gate(
      "child",
      childKnown,
      childKnown ? child.id : "unknown or another session",
      "a child session the host still knows",
    ),
  )
  if (!childKnown) return stop(gates, "child-unknown", false)

  const direct = child.parentID === parent.id
  gates.push(
    gate(
      "direct-parent",
      direct,
      child.parentID === undefined ? "host reports no parent" : `parentID=${child.parentID}`,
      "the host's one-hop parentID equal to the parent session",
    ),
  )
  if (!direct) return stop(gates, "parent-not-direct", false)

  const locationOk = parent.directory === grant.scopeDirectory && child.directory === grant.scopeDirectory
  gates.push(
    gate(
      "location",
      locationOk,
      `${parent.directory} / ${child.directory}; grant=${grant.scopeDirectory}`,
      "one location for the parent, child and grant",
    ),
  )
  if (!locationOk) return stop(gates, "location-mismatch", false)

  const scopeKnown = facts.parentScope !== null && facts.childScope !== null
  const scopeOk =
    scopeKnown && facts.parentScope === grant.scopePeerScope && facts.childScope === grant.scopePeerScope
  gates.push(
    gate(
      "scope",
      scopeOk,
      `${facts.parentScope ?? "unknown"} / ${facts.childScope ?? "unknown"}; grant=${grant.scopePeerScope}`,
      "one visibility scope for the parent, child and grant",
    ),
  )
  if (!scopeOk) return stop(gates, "scope-mismatch", false)

  const existing = facts.existingChild
  let late = false
  if (existing !== null) {
    if (existing.task.taskState === "completed" || existing.task.watchState === "ended") {
      gates.push(gate("child-state", false, `${existing.task.taskState}/${existing.task.watchState}`, "an unfinished child"))
      return stop(gates, "child-completed", false)
    }
    const live = existing.task.watchState === "active" || existing.task.watchState === "paused"
    if (live && !existing.delegatedByThisGrant) {
      gates.push(gate("child-state", false, "another authorization", "this delegation grant's own child task"))
      return stop(gates, "child-busy", false)
    }
    late = existing.task.taskState !== "not-started" || existing.task.lastReport !== undefined
    gates.push(
      gate(
        "child-state",
        true,
        late ? "already started; enrollment does not wake it" : "not started",
        "a child that is not finished; no extra prompt is sent",
      ),
    )
  } else {
    gates.push(gate("child-state", true, "no existing task", "no previous child task to adopt or replay"))
  }

  return { allowed: true, stopReason: null, missingEvidence: null, gates, late }
}

/** Whether the controlled surface may prepare/confirm a delegation grant now. */
export function delegationGrantGate(facts: DelegationGrantFacts): DelegationGateResult {
  const parentTask = facts.parentTask
  const parent = facts.parent
  const child = facts.child
  const gates: DelegationGateView[] = []

  gates.push(
    gate("closing", !facts.closing, facts.closing ? "closing" : "open", "an open watch application"),
  )
  if (facts.closing) return stop(gates, "closing", false)

  const callerOk =
    facts.callerSessionID === parentTask.initiatorSessionID &&
    facts.ownerActivation === parentTask.ownerActivation
  gates.push(
    gate(
      "owner",
      callerOk,
      `${facts.callerSessionID === parentTask.initiatorSessionID ? "initiator" : "not initiator"}; ${facts.ownerActivation === parentTask.ownerActivation ? "owner" : "not owner"}`,
      "the task initiator and current owner activation",
    ),
  )
  if (!callerOk) return stop(gates, "owner-mismatch", false)

  const versionOk = facts.expectedVersion === parentTask.version
  gates.push(
    gate(
      "parent-version",
      versionOk,
      `expected ${facts.expectedVersion}; actual ${parentTask.version}`,
      "the parent task version reviewed on the controlled surface",
    ),
  )
  if (!versionOk) return stop(gates, "parent-version-stale", false)

  const parentSelf = parentTask.initiatorSessionID === parentTask.targetSessionID
  gates.push(
    gate("parent-origin", parentSelf, parentSelf ? "self-enrolled" : "delegated", "a self-enrolled parent task; no recursion"),
  )
  if (!parentSelf) return stop(gates, "parent-not-self", false)

  if (parentTask.taskState === "completed") {
    gates.push(gate("parent-task", false, "completed", "an unfinished parent task"))
    return stop(gates, "parent-task-completed", false)
  }
  if (parentTask.watchState !== "active") {
    gates.push(gate("parent-task", false, parentTask.watchState, "an active parent watch"))
    return stop(gates, "parent-task-inactive", false)
  }

  if (facts.existingGrant?.state === "granted") {
    gates.push(gate("grant-active", false, `${facts.existingGrant.state} version ${facts.existingGrant.version}`, "a revoked grant or none"))
    return stop(gates, "grant-active", false)
  }
  gates.push(gate("grant-active", true, "none active", "a revoked grant or none"))

  const mode = readDelegationMode(facts.mode)
  gates.push(gate("mode", mode.ok, mode.ok ? mode.value : mode.reason, "alert or limited-correction"))
  if (!mode.ok) return stop(gates, "mode-not-granted", false)

  const parentKnown = parent !== null && parent.id === parentTask.targetSessionID
  gates.push(
    gate(
      "parent-task",
      parentKnown,
      parent === null ? "unknown" : parent.id,
      "the host-known parent session",
    ),
  )
  if (!parentKnown) return stop(gates, "parent-unknown", false)

  const childKnown = child !== null && child.id === facts.targetSessionID
  gates.push(
    gate("child", childKnown, childKnown ? child.id : "unknown or another session", "a child session the host still knows"),
  )
  if (!childKnown) return stop(gates, "child-unknown", false)

  const direct = child.parentID === parent.id
  gates.push(
    gate(
      "direct-parent",
      direct,
      child.parentID === undefined ? "host reports no parent" : `parentID=${child.parentID}`,
      "the host's one-hop parentID equal to the parent session",
    ),
  )
  if (!direct) return stop(gates, "parent-not-direct", false)

  const locationOk = parent.directory === child.directory
  gates.push(
    gate("location", locationOk, `${parent.directory} / ${child.directory}`, "one location for the parent and child"),
  )
  if (!locationOk) return stop(gates, "location-mismatch", false)

  const scopeKnown = facts.parentScope !== null && facts.childScope !== null
  const scopeOk = scopeKnown && facts.parentScope === facts.childScope
  gates.push(
    gate(
      "scope",
      scopeOk,
      `${facts.parentScope ?? "unknown"} / ${facts.childScope ?? "unknown"}`,
      "one visibility scope for the parent and child",
    ),
  )
  if (!scopeOk) return stop(gates, "scope-mismatch", false)

  return { allowed: true, stopReason: null, missingEvidence: null, gates, late: false }
}

function modeRank(mode: WatchMode): number {
  return mode === "alert" ? 0 : 1
}

function gate(
  name: DelegationGate,
  ok: boolean,
  observed: string | null,
  required: string,
): DelegationGateView {
  return { gate: name, ok, reason: ok ? null : `requires ${required}`, observed, required }
}

function stop(
  gates: readonly DelegationGateView[],
  reason: DelegationStopReason,
  late: boolean,
): DelegationGateResult {
  return {
    allowed: false,
    stopReason: reason,
    missingEvidence: gates.find((item) => !item.ok)?.reason ?? null,
    gates,
    late,
  }
}

/** One bounded id, such as a grant or request id, as the ledger stores it. */
export function readDelegationIdentifier(value: unknown, field: string): Checked<string> {
  return readIdentifier(value, field)
}
