/**
 * The watchdog's domain vocabulary and pure validation.
 *
 * A watched task is explicitly enrolled; a session being idle is not a task.
 * This file knows nothing about SQLite, opencode or the plugin context: it
 * names the states, bounds the text a model may submit, and says which evidence
 * a state change needs. The authority for a task is the security ledger
 * (`src/watch/ledger.ts`); these types are the shape its callers share.
 */

export type WatchTaskID = string
export type WatchSessionID = string

/** The user's selected supervision mode; capability says what this build can honour. */
export type WatchMode = "alert" | "limited-correction"

/** The supervision lifecycle, separate from what the business task is doing. */
export type WatchState = "active" | "paused" | "ended"

/** What the executing session last said about the business task. */
export type WatchedTaskState = "not-started" | "in-progress" | "waiting" | "blocked" | "completed"

export type WatchReportKind = "begin" | "progress" | "waiting" | "blocked" | "completed"

export type WatchWaitKind = "human" | "peer" | "permission" | "form" | "child" | "other"

/** A bounded, normalized report body. Absent fields are omitted, never empty strings. */
export interface WatchEvidence {
  readonly summary?: string
  readonly reference?: string
  readonly waitKind?: WatchWaitKind
  readonly waitFor?: string
  readonly reason?: string
  /** Stable id for a reported wait; defaults to the report id. */
  readonly waitID?: string
  /** Optional deadline for a reported wait; absent means the configured fallback. */
  readonly waitUntil?: number
  /** A later report may clear only this matching reported wait. */
  readonly clearsWaitID?: string
  /** Short evidence for the matched response/termination; not fetched or verified externally. */
  readonly clearEvidence?: string
}

export interface WatchReportedWait {
  readonly waitID: string
  readonly waitKind: WatchWaitKind
  readonly waitFor: string
  readonly reason: string
  readonly reference: string
  readonly waitUntil?: number
  readonly at: number
  readonly clearedAt?: number
  readonly clearEvidence?: string
}

export interface WatchReportRecord {
  readonly reportID: string
  readonly kind: WatchReportKind
  readonly evidence: WatchEvidence
  readonly at: number
  readonly version: number
}

/** A task as the ledger stores it. Not a wire shape: it carries the owner activation. */
export interface WatchTaskRecord {
  readonly taskID: WatchTaskID
  readonly initiatorSessionID: WatchSessionID
  readonly targetSessionID: WatchSessionID
  readonly goal: string
  readonly mode: WatchMode
  readonly watchState: WatchState
  readonly taskState: WatchedTaskState
  readonly version: number
  readonly generation: number
  /** Permanent correction attempts already spent; this build may spend at most the first automatically. */
  readonly attemptsUsed: number
  /** The activation that enrolled the task; a later activation only observes it. */
  readonly ownerActivation: string
  /** Bounded reported waits, including recently cleared ones; host waits are separate facts. */
  readonly reportedWaits: readonly WatchReportedWait[]
  readonly lastReport?: WatchReportRecord
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly endedAt?: number
}

/** Which activation is looking at the task, said without exposing the activation value. */
export type WatchOwnership = "this-instance" | "another-activation"

/**
 * Whether the executing session has ever reported. Enrollment alone is not
 * readiness: no report means the protocol may not have reached a model turn.
 */
export type WatchParticipation = "not-seen" | "seen"

/** How many corrective attempts the task has spent, and its hard cap. */
export interface WatchAttempts {
  readonly used: number
  readonly limit: number
}

/**
 * The user's correction authorization and the automatic send capability are
 * separate facts. A grant does not make a send eligible, and a busy/waiting
 * target does not mean the user never granted anything.
 */
export type WatchCorrectionGrantState = "not-granted" | "pending-confirmation" | "granted" | "revoked"
export type WatchCorrectionActual = "unavailable" | "ready"

/** The persisted phase of one permanent attempt. */
export type WatchCorrectionAttemptPhase =
  | "reserved"
  | "sending"
  | "accepted"
  | "rejected"
  | "unknown"
  | "receipted"
  | "recovered"
  | "aborted"

/** Why an automatic send is not eligible now; never a judgement of the goal. */
export type WatchCorrectionStopReason =
  | "grant-missing"
  | "grant-pending"
  | "grant-expired"
  | "attempt-limit"
  | "session-unresolved"
  | "reservation-pending"
  | "sending-unaccounted"
  | "accepted-without-receipt"
  | "unknown-result"
  | "first-attempt-policy"
  | "receipted-awaiting-recovery"
  | "attempt-aborted"
  | "closing"
  | "rejected"
  | "recovered"
  | "runtime-unsupported"
  | "single-host-unconfirmed"
  | "owner-mismatch"
  | "cross-location"
  | "protocol-unseen"
  | "task-paused"
  | "task-ended"
  | "task-completed"
  | "observation-untrusted"
  | "normal-wait"
  | "observation-gap"
  | "executor-unavailable"

export interface WatchCorrectionAttemptView {
  /** Stable reservation id; never a model-provided proof token. */
  readonly attemptID: string
  readonly ordinal: number
  readonly phase: WatchCorrectionAttemptPhase
  readonly reservedAt: number
  readonly claimedAt: number | null
  readonly acceptedAt: number | null
  readonly rejectedAt: number | null
  readonly unknownAt: number | null
  readonly abortedAt: number | null
  /** The target saw a known instruction; no permit necessarily followed. */
  readonly seen: { readonly at: number; readonly reason: string | null } | null
  readonly receipt: WatchCorrectionReceiptView | null
  readonly recovery: WatchCorrectionRecoveryView | null
  readonly stopReason: WatchCorrectionStopReason | null
}

export interface WatchCorrectionReceiptView {
  /** When the target recorded that it saw the correction; no token is exposed. */
  readonly at: number
  /** When this receipt issued the one continue permit; null means no permit. */
  readonly continuePermitIssuedAt: number | null
  /** Why a recorded receipt refused further business continuation. */
  readonly refusalReason: string | null
}

/** Recovery needs a new progress report and its matching new result reference. */
export interface WatchCorrectionRecoveryView {
  readonly progressReportID: string
  readonly resultReference: string
  readonly at: number
}

export interface WatchCorrectionGrantView {
  readonly mode: WatchMode
  readonly state: WatchCorrectionGrantState
  /** The explicit deployment declaration, or `unknown` before one is stored. */
  readonly deployment: "single-host-same-location" | "unknown"
  /** Increments on grant, downgrade or revocation; never resets attempts. */
  readonly version: number
  readonly reviewSummary: string | null
  readonly grantedAt: number | null
}

export interface WatchCorrectionGrantRecord {
  readonly grantID: string
  readonly taskID: string
  readonly mode: WatchMode
  readonly state: "granted" | "revoked"
  readonly version: number
  readonly generation: number
  readonly scopeTargetSessionID: string
  readonly reviewSummary: string
  readonly deployment: "single-host-same-location"
  readonly termsDigest: string
  readonly confirmationID: string
  readonly grantedAt: number
  readonly revokedAt?: number
}

export interface WatchCorrectionAttemptRecord {
  readonly reservationID: string
  readonly taskID: string
  readonly ordinal: number
  readonly phase: WatchCorrectionAttemptPhase
  readonly reservedAt: number
  readonly claimedAt?: number
  readonly claimedByActivation?: string
  readonly claimedGeneration?: number
  readonly acceptedAt?: number
  readonly rejectedAt?: number
  readonly unknownAt?: number
  readonly abortedAt?: number
  readonly receiptID?: string
  readonly receiptAt?: number
  readonly receiptPermitAt?: number
  readonly receiptRefusalReason?: string
  readonly admissionID?: string
  readonly lastSeenAt?: number
  readonly lastSeenReason?: string
  readonly receiptCallerSessionID?: string
  readonly receiptGeneration?: number
  readonly recoveryReportID?: string
  readonly recoveryReference?: string
  readonly recoveredAt?: number
  readonly stopReason?: WatchCorrectionStopReason
}

export interface WatchCorrectionSnapshot {
  readonly grant: WatchCorrectionGrantRecord | null
  readonly attempts: readonly WatchCorrectionAttemptRecord[]
  /** An older task for the same target still has an unresolved attempt. */
  readonly sessionUnresolved: boolean
}

export const WATCH_CORRECTION_TERMS =
  "Correction grant terms: limited correction with at most three permanent attempts in total; this build's automatic executor may use only the first attempt; automatic sends require one OpenCode service, the same OS user and the same location; the explicit deployment statement is a declaration, not proof that no other service is running; the controlled RPC is not same-user human authentication; any unsupported or uncertain condition means alert-only; a safety pause never stops business work; reading, receipt, recovery, reload, transfer or re-granting never resets spent attempts."

/**
 * A short-lived challenge returned only to the controlled TUI surface by the
 * prepare call. It is not human proof, never enters the model context or the
 * normal task snapshot, and is consumed by the matching confirm call.
 */
export interface WatchCorrectionChallenge {
  readonly challenge: string
  readonly taskID: string
  readonly expectedVersion: number
  readonly generation: number
  readonly termsDigest: string
  readonly reviewSummary: string
  readonly expiresAt: number
}

export type WatchCorrectionGate =
  | "grant"
  | "attempts"
  | "pending-attempt"
  | "business-unfinished"
  | "task-active"
  | "session-unresolved"
  | "runtime"
  | "single-host"
  | "location"
  | "owner-generation"
  | "protocol"
  | "observation"
  | "waits"
  | "closing"
  | "executor"

export interface WatchCorrectionGateView {
  readonly gate: WatchCorrectionGate
  readonly ok: boolean
  readonly reason: string | null
  /** The fact this build actually has, bounded and redacted. */
  readonly observed: string | null
  /** What the gate requires; never a claim that the build meets it. */
  readonly required: string | null
}

export interface WatchCorrectionControls {
  /** Requesting a grant starts a controlled review; it never grants by itself. */
  readonly grant: WatchControl
  readonly downgrade: WatchControl
}

export interface WatchCorrectionView {
  readonly authorization: WatchCorrectionGrantView
  /** What this build can really do now, distinct from the granted mode. */
  readonly actual: WatchCorrectionActual
  readonly actualReason: string
  readonly attempts: WatchAttempts
  /** This build may use only the first automatic attempt; the ledger keeps three. */
  readonly executionPolicy: "first-attempt-only"
  /** The current attempt phase, or `idle` when no attempt is in flight. */
  readonly phase: WatchCorrectionAttemptPhase | "idle"
  readonly pending: WatchCorrectionAttemptView | null
  readonly last: WatchCorrectionAttemptView | null
  readonly history: readonly WatchCorrectionAttemptView[]
  readonly stop: { readonly reason: WatchCorrectionStopReason; readonly missingEvidence: string | null } | null
  readonly gates: readonly WatchCorrectionGateView[]
  /** Business completion is independent of supervision and correction. */
  readonly businessCompleted: boolean
  readonly controls: WatchCorrectionControls
}

/** Why supervision is paused; this build only produces `manual`. */
export interface WatchPause {
  readonly kind: "manual" | "safety"
  readonly reason: string
}

/** What the panel shows for one task. Plain data, safe as an RPC answer. */
export interface WatchTaskView {
  readonly taskID: WatchTaskID
  readonly initiatorSessionID: WatchSessionID
  readonly targetSessionID: WatchSessionID
  readonly goal: string
  readonly mode: WatchMode
  readonly watchState: WatchState
  readonly taskState: WatchedTaskState
  readonly version: number
  readonly generation: number
  readonly ownership: WatchOwnership
  readonly participation: WatchParticipation
  readonly attempts: WatchAttempts
  readonly correction: WatchCorrectionView
  readonly pause: WatchPause | null
  readonly lastReport: WatchReportView | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
  readonly endedAt: number | null
}

export interface WatchReportView {
  readonly reportID: string
  readonly kind: WatchReportKind
  readonly evidence: WatchEvidence
  readonly at: number
  readonly version: number
}

/** A persistent observation problem; one row per task and continuing problem. */
export type WatchAlertKind =
  | "idle"
  | "blocked"
  | "running-silent"
  | "wait-overdue"
  | "observation-unknown"
  | "approval-rejected"

export type WatchAlertState = "unread" | "read"

export interface WatchAlertRecord {
  readonly alertID: string
  readonly taskID: string
  readonly dedupeKey: string
  readonly kind: WatchAlertKind
  readonly state: WatchAlertState
  readonly summary: string
  readonly reason: string
  readonly firstAt: number
  readonly updatedAt: number
  readonly readAt?: number
  readonly escalatedAt?: number
  readonly resolvedAt?: number
}

export interface WatchAlertView {
  readonly alertID: string
  readonly taskID: string
  readonly kind: WatchAlertKind
  readonly state: WatchAlertState
  /** Short, redacted diagnostic; never the goal, raw output or credentials. */
  readonly summary: string
  readonly reason: string
  /** A safe user action; this build only offers inspection/ack, never correction. */
  readonly nextStep: string
  readonly plainText: string
  readonly firstAt: number
  readonly updatedAt: number
  readonly readAt: number | null
  readonly escalatedAt: number | null
  readonly resolvedAt: number | null
}

/** One wait that is (or was) suppressing idle detection. */
export type WatchWaitSource = "permission" | "form" | "retry" | "ask" | "reported"

export type WatchWaitStatus = "active" | "overdue" | "cleared" | "denied" | "unknown"

export interface WatchWaitView {
  readonly waitID: string
  readonly source: WatchWaitSource
  readonly object: string
  readonly reason: string
  readonly reference: string | null
  readonly startedAt: number
  readonly deadline: number | null
  readonly status: WatchWaitStatus
  readonly clearEvidence: string | null
  readonly denyEvidence: string | null
}

/** What the observer currently knows about a task's execution, not its business success. */
export type WatchObservationState =
  | "active"
  | "idle-candidate"
  | "running-silence"
  | "normal-waiting"
  | "blocked"
  | "unknown"
  | "unavailable"

export interface WatchEffectiveThresholds {
  readonly idleMs: number
  readonly runningSilentMs: number
  readonly waitOverdueMs: number
}

export interface WatchObservationView {
  readonly state: WatchObservationState
  /** Why the observation is unknown/degraded; `null` when the state is trusted. */
  readonly reason: string | null
  /** The last observation sample. */
  readonly observedAt: number | null
  /** When the current continuous idle/running period began, according to this observer. */
  readonly baselineAt: number | null
  /** The last terminal execution observed; never a claim about pre-observation history. */
  readonly idleSince: number | null
  /** True only when local execution evidence and all required snapshots are present. */
  readonly trusted: boolean
  readonly waits: readonly WatchWaitView[]
  /** A permission/form/ask source was incomplete, so absence of a wait is not proof. */
  readonly waitsPartial: boolean
  /** The bounded wait list dropped entries. */
  readonly waitsTruncated: boolean
  readonly effective: WatchEffectiveThresholds
}

export interface WatchActivityView {
  /** When this target last produced its own output, step or tool activity. */
  readonly lastAt: number | null
  readonly kind: "text" | "reasoning" | "step" | "tool" | "shell" | "execution" | null
  /** Continuous activity is not evidence of goal progress; this build never judges it. */
  readonly judgement: "not-judged"
}

export interface WatchAlertsView {
  readonly items: readonly WatchAlertView[]
  readonly unread: number
  readonly total: number
  /** Unresolved alerts, regardless of whether `items` had to be truncated. */
  readonly active: number
  /** The bounded list dropped recorded alerts. */
  readonly truncated: boolean
  readonly available: boolean
  readonly reason: string | null
}

/**
 * What this build can actually do, as distinct from the mode the user chose.
 * Observation and alerts are always available. Automatic correction is
 * `first-attempt` only when the task's own gate is ready on a verified runtime;
 * it is not inferred from the selected mode. Manual correction, delegation,
 * transfer and resume remain unavailable, and safety pause is a displayed
 * state rather than a resume/takeover capability.
 */
export interface WatchCapability {
  readonly mode: WatchMode
  readonly monitoring: "observer-alerts"
  readonly automaticDetection: "partial"
  readonly automaticDetectionReason: string
  readonly correction: "unavailable" | "first-attempt"
  readonly correctionReason: string
  readonly delegation: "unavailable"
  readonly delegationReason: string
  readonly transfer: "unavailable"
  readonly transferReason: string
  readonly recovery: "unavailable"
  readonly recoveryReason: string
  readonly safetyPause: "unavailable"
  readonly safetyPauseReason: string
}

export interface WatchControl {
  readonly enabled: boolean
  readonly reason: string | null
}

/** The controls the panel may show; disabled ones carry the reason they are disabled. */
export interface WatchControls {
  readonly pause: WatchControl
  readonly end: WatchControl
  readonly acknowledge: WatchControl
  readonly resume: WatchControl
  readonly correction: WatchControl
  readonly transfer: WatchControl
}

export type WatchFailureCode =
  | "E_WATCH_DISABLED"
  | "E_WATCH_UNAVAILABLE"
  | "E_WATCH_INVALID"
  | "E_WATCH_UNSUPPORTED"
  | "E_WATCH_NOT_FOUND"
  | "E_WATCH_SESSION_BUSY"
  | "E_WATCH_REQUEST_CONFLICT"
  | "E_WATCH_CALLER_MISMATCH"
  | "E_WATCH_STALE"
  | "E_WATCH_REPORT_CONFLICT"
  | "E_WATCH_INVALID_TRANSITION"
  | "E_WATCH_ENDED"

export interface WatchFailure {
  readonly code: WatchFailureCode
  readonly reason: string
  /** A machine-readable ledger cause, when the failure came from the ledger. */
  readonly detail?: string
}

export const WATCH_LIMITS = {
  goal: 2_000,
  summary: 2_000,
  reference: 1_000,
  waitFor: 500,
  reason: 1_000,
  id: 128,
} as const

/** The hard cap the parent specification fixes for one watched task. */
export const WATCH_CORRECTION_LIMIT = 3
export const WATCH_ALERT_SUMMARY_LIMIT = 300
export const WATCH_ALERT_REASON_LIMIT = 500

export const CORRECTION_UNAVAILABLE_REASON =
  "The automatic correction code path exists, but its runtime/protocol tuple is not verified (or the task gate is closed); no queue is sent. Manual correction, resume and transfer remain unavailable."
export const MANUAL_CORRECTION_UNAVAILABLE_REASON =
  "Manual correction is not implemented in this build; only the gated first automatic attempt, when the runtime is verified, can queue a correction."
export const DELEGATION_UNAVAILABLE_REASON =
  "Child-task delegation is not open in this build; enroll the calling session itself."
export const TRANSFER_UNAVAILABLE_REASON =
  "Watch ownership transfer is not implemented in this build."
export const RECOVERY_UNAVAILABLE_REASON =
  "Automatic resume and ownership recovery are not implemented in this build. A correction receipt followed by new progress and a new result reference can confirm recovery evidence for an existing attempt, but it does not resume a session or transfer ownership."
export const SAFETY_PAUSE_UNAVAILABLE_REASON =
  "A safety pause can be displayed when another activation owns the task, but resume, ownership takeover and a quiescence proof are not implemented in this build; manual pause/end remain the only controls."

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const WAIT_KINDS: readonly WatchWaitKind[] = ["human", "peer", "permission", "form", "child", "other"]

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

/** A bounded, stable identifier, as both task ids and idempotency keys must be. */
export function readIdentifier(value: unknown, field: string): Checked<string> {
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, reason: `${field} must not be empty` }
  if (trimmed.length > WATCH_LIMITS.id) {
    return { ok: false, reason: `${field} must be at most ${WATCH_LIMITS.id} characters` }
  }
  if (!ID.test(trimmed)) {
    return { ok: false, reason: `${field} must start with a letter or digit and contain only letters, digits, . _ : -` }
  }
  return { ok: true, value: trimmed }
}

export function readGoal(value: unknown): Checked<string> {
  if (typeof value !== "string") return { ok: false, reason: "goal must be a string" }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, reason: "goal must not be empty" }
  if (trimmed.length > WATCH_LIMITS.goal) {
    return { ok: false, reason: `goal must be at most ${WATCH_LIMITS.goal} characters` }
  }
  return { ok: true, value: trimmed }
}

export function readReportKind(value: unknown): Checked<WatchReportKind> {
  if (value === "begin" || value === "progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return { ok: true, value }
  }
  return { ok: false, reason: "kind must be one of begin, progress, waiting, blocked, completed" }
}

/**
 * Evidence is what makes a report more than a claim: beginning needs nothing,
 * progress and completion need a result summary and a reference, a wait needs
 * its kind, object and reason, and a block needs its reason.
 */
export function readEvidence(kind: WatchReportKind, value: unknown): Checked<WatchEvidence> {
  if (value === undefined || value === null) {
    if (kind === "begin") return { ok: true, value: {} }
    return { ok: false, reason: `a ${kind} report needs evidence` }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "evidence must be an object" }
  }
  const record = value as Record<string, unknown>

  const summary = optionalText(record["summary"], "summary", WATCH_LIMITS.summary)
  if (!summary.ok) return summary
  const reference = optionalText(record["reference"], "reference", WATCH_LIMITS.reference)
  if (!reference.ok) return reference
  const waitFor = optionalText(record["waitFor"], "waitFor", WATCH_LIMITS.waitFor)
  if (!waitFor.ok) return waitFor
  const reason = optionalText(record["reason"], "reason", WATCH_LIMITS.reason)
  if (!reason.ok) return reason
  const waitID = optionalIdentifier(record["waitID"], "waitID")
  if (!waitID.ok) return waitID
  const clearsWaitID = optionalIdentifier(record["clearsWaitID"], "clearsWaitID")
  if (!clearsWaitID.ok) return clearsWaitID
  const clearEvidence = optionalText(record["clearEvidence"], "clearEvidence", WATCH_LIMITS.reason)
  if (!clearEvidence.ok) return clearEvidence
  const waitUntil = optionalInteger(record["waitUntil"], "waitUntil")
  if (!waitUntil.ok) return waitUntil

  let waitKind: WatchWaitKind | undefined
  if (record["waitKind"] !== undefined) {
    if (typeof record["waitKind"] !== "string" || !WAIT_KINDS.includes(record["waitKind"] as WatchWaitKind)) {
      return { ok: false, reason: "waitKind must be one of human, peer, permission, form, child, other" }
    }
    waitKind = record["waitKind"] as WatchWaitKind
  }

  const evidence: WatchEvidence = {
    ...(summary.value === undefined ? {} : { summary: summary.value }),
    ...(reference.value === undefined ? {} : { reference: reference.value }),
    ...(waitKind === undefined ? {} : { waitKind }),
    ...(waitFor.value === undefined ? {} : { waitFor: waitFor.value }),
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    ...(waitID.value === undefined ? {} : { waitID: waitID.value }),
    ...(waitUntil.value === undefined ? {} : { waitUntil: waitUntil.value }),
    ...(clearsWaitID.value === undefined ? {} : { clearsWaitID: clearsWaitID.value }),
    ...(clearEvidence.value === undefined ? {} : { clearEvidence: clearEvidence.value }),
  }

  if (evidence.clearsWaitID !== undefined && evidence.clearEvidence === undefined) {
    return { ok: false, reason: "clearsWaitID needs a non-empty clearEvidence" }
  }

  switch (kind) {
    case "begin":
      return { ok: true, value: evidence }
    case "progress":
      if (evidence.summary === undefined || evidence.reference === undefined) {
        return { ok: false, reason: "a progress report needs evidence.summary and evidence.reference" }
      }
      return { ok: true, value: evidence }
    case "waiting":
      if (
        evidence.waitKind === undefined ||
        evidence.waitFor === undefined ||
        evidence.reason === undefined ||
        evidence.reference === undefined
      ) {
        return {
          ok: false,
          reason: "a waiting report needs evidence.waitKind, evidence.waitFor, evidence.reason and evidence.reference",
        }
      }
      return { ok: true, value: evidence }
    case "blocked":
      if (evidence.reason === undefined) {
        return { ok: false, reason: "a blocked report needs evidence.reason" }
      }
      return { ok: true, value: evidence }
    case "completed":
      if (evidence.summary === undefined || evidence.reference === undefined) {
        return { ok: false, reason: "a completed report needs evidence.summary and evidence.reference" }
      }
      return { ok: true, value: evidence }
  }
}

function optionalIdentifier(value: unknown, field: string): Checked<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  const checked = readIdentifier(value, field)
  if (!checked.ok) return checked
  return { ok: true, value: checked.value }
}

function optionalInteger(value: unknown, field: string): Checked<number | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, reason: `${field} must be a positive integer timestamp` }
  }
  return { ok: true, value }
}

function optionalText(value: unknown, field: string, maximum: number): Checked<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, value: undefined }
  if (trimmed.length > maximum) return { ok: false, reason: `${field} must be at most ${maximum} characters` }
  return { ok: true, value: trimmed }
}

export function readAlertKind(value: unknown): Checked<WatchAlertKind> {
  if (
    value === "idle" ||
    value === "blocked" ||
    value === "running-silent" ||
    value === "wait-overdue" ||
    value === "observation-unknown" ||
    value === "approval-rejected"
  ) {
    return { ok: true, value }
  }
  return { ok: false, reason: "alert kind is not supported" }
}

export function readBoundedText(value: unknown, field: string, maximum: number): Checked<string> {
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, reason: `${field} must not be empty` }
  if (trimmed.length > maximum) return { ok: false, reason: `${field} must be at most ${maximum} characters` }
  return { ok: true, value: trimmed }
}

/** Stable JSON for idempotency comparisons: object keys are sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

/** The parameters that make two enrollments the same request or a conflict. */
export function enrollmentFingerprint(input: {
  readonly initiatorSessionId: string
  readonly targetSessionId: string
  readonly goal: string
  readonly mode: WatchMode
}): string {
  return canonicalJson([input.initiatorSessionId, input.targetSessionId, input.goal, input.mode])
}

/** What a report next does to the business task, or why it cannot. */
export function nextTaskState(
  current: WatchedTaskState,
  kind: WatchReportKind,
): Checked<WatchedTaskState> {
  if (current === "completed") {
    return { ok: false, reason: "the watched task is already completed" }
  }
  switch (kind) {
    case "begin":
      if (current !== "not-started") return { ok: false, reason: "the task has already begun" }
      return { ok: true, value: "in-progress" }
    case "progress":
      if (current === "not-started") return { ok: false, reason: "report begin before progress" }
      return { ok: true, value: "in-progress" }
    case "waiting":
      if (current === "not-started") return { ok: false, reason: "report begin before waiting" }
      return { ok: true, value: "waiting" }
    case "blocked":
      if (current === "not-started") return { ok: false, reason: "report begin before blocked" }
      return { ok: true, value: "blocked" }
    case "completed":
      return { ok: true, value: "completed" }
  }
}
