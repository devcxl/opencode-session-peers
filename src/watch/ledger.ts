/**
 * The watchdog's security ledger: the only authority for a watched task.
 *
 * It is a plugin-private SQLite database, not `ctx.storage`. The host storage
 * namespace is a discovery surface; it must never decide authorization, quota,
 * ownership or whether a task still exists.
 *
 * The ledger is deliberately conservative. Opening validates a fixed canonical
 * path, the SQLite build, the ledger identity, the schema/protocol versions and
 * the stored path. Any mismatch closes the database and reports a code the
 * caller can show; it never repairs, copies or recreates an old task. Writes
 * run in `BEGIN IMMEDIATE` transactions with unique constraints, so two
 * processes can race for the same session without both succeeding.
 */

import { createHash, randomUUID } from "node:crypto"
import {
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { Database } from "bun:sqlite"

import {
  canonicalJson,
  enrollmentFingerprint,
  nextTaskState,
  readAlertKind,
  readBoundedText,
  readEvidence,
  readGoal,
  readIdentifier,
  readReportKind,
  WATCH_ALERT_REASON_LIMIT,
  WATCH_ALERT_SUMMARY_LIMIT,
  WATCH_CORRECTION_LIMIT,
  WATCH_CORRECTION_TERMS,
  WATCH_LIMITS,
  WATCH_MIN_SQLITE,
  type WatchAlertKind,
  type WatchAlertRecord,
  type WatchAlertState,
  type WatchCorrectionAttemptPhase,
  type WatchCorrectionAttemptRecord,
  type WatchCorrectionGrantRecord,
  type WatchCorrectionSnapshot,
  type WatchCorrectionStopReason,
  type WatchEvidence,
  type WatchMode,
  type WatchReportKind,
  type WatchReportedWait,
  type WatchState,
  type WatchTaskRecord,
  type WatchedTaskState,
} from "../domain/watch.ts"
import type {
  DelegatedAuthoritySnapshot,
  DelegatedChildRecord,
  DelegatedTaskLink,
  DelegationChallenge,
  DelegationGrantRecord,
} from "./delegation.ts"
import {
  DELEGATION_DDL,
  DELEGATION_REQUIRED_TABLES,
  LedgerDelegationFailure,
  REQUIRED_DELEGATED_TASK_COLUMNS,
  REQUIRED_DELEGATION_CHALLENGE_COLUMNS,
  REQUIRED_DELEGATION_GRANT_COLUMNS,
  assertDelegatedCorrectionAuthority,
  assertDelegationIntegrity,
  confirmDelegationGrant,
  delegatedAuthority,
  delegatedEnroll,
  delegatedTaskLink,
  delegationGrantFor,
  delegationGrantsFor,
  listDelegatedChildren,
  prepareDelegationGrant,
  revokeDelegationGrant,
  type ConfirmDelegationGrantInput,
  type DelegatedEnrollInput,
  type DelegatedEnrollResult,
  type DelegationLedgerHost,
  type PrepareDelegationGrantInput,
  type RevokeDelegationGrantInput,
} from "./ledger-delegation.ts"

export type {
  ConfirmDelegationGrantInput,
  DelegatedEnrollInput,
  DelegatedEnrollResult,
  PrepareDelegationGrantInput,
  RevokeDelegationGrantInput,
} from "./ledger-delegation.ts"

export const WATCH_LEDGER_SCHEMA_VERSION = 10
export const WATCH_LEDGER_PROTOCOL_VERSION = 1

export type WatchLedgerErrorCode =
  | "invalid_input"
  | "unsafe_path"
  | "readonly"
  | "corrupt"
  | "unsupported_schema"
  | "ledger_path_mismatch"
  | "ledger_mismatch"
  | "ledger_missing"
  | "unsafe_sqlite"
  | "lock_timeout"
  | "io_error"
  | "conflict"
  | "session_conflict"
  | "request_conflict"
  | "unknown_task"
  | "unknown_alert"
  | "unknown_wait"
  | "wait_limit"
  | "caller_mismatch"
  | "stale_version"
  | "report_conflict"
  | "invalid_transition"
  | "ended"
  | "not_active"
  | "state_unknown"
  | "not_granted"
  | "grant_pending"
  | "grant_expired"
  | "attempt_limit"
  | "pending_attempt"
  | "session_unresolved"
  | "claim_taken"
  | "stale_owner"
  | "stale_generation"
  | "not_claimable"
  | "receipt_conflict"
  | "recovery_evidence_missing"
  | "grant_active"
  | "ledger_error"

export type LedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WatchLedgerErrorCode; readonly detail: string }

export interface OpenWatchLedgerOptions {
  /** Absolute path to the plugin's own database file. Never a model-provided path. */
  readonly path: string
  readonly busyTimeoutMs?: number
  /** Bounded retries for a cold start that loses the first write race. */
  readonly openAttempts?: number
  /**
   * Test seam for the version gate. The host adapter leaves this out and reads
   * the embedded runtime; a caller cannot lower the production requirement.
   */
  readonly sqliteVersion?: string
  readonly now?: () => number
}

export type OpenWatchLedgerResult =
  | { readonly ok: true; readonly ledger: WatchLedger }
  | { readonly ok: false; readonly code: WatchLedgerErrorCode; readonly detail: string }

export interface EnrollWatchTaskInput {
  readonly requestId: string
  readonly initiatorSessionId: string
  readonly targetSessionId: string
  readonly goal: string
  readonly mode: WatchMode
  readonly ownerActivation: string
}

export interface ReportWatchTaskInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly expectedVersion: number
  readonly reportId: string
  readonly kind: WatchReportKind
  readonly evidence: WatchEvidence
}

export interface ControlWatchTaskInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly expectedVersion: number
  readonly operation: "pause" | "end"
}

export interface UpsertWatchAlertInput {
  readonly taskId: string
  readonly dedupeKey: string
  readonly kind: WatchAlertKind
  readonly summary: string
  readonly reason: string
  readonly at: number
  /** The observer may request the one bounded escalation for this problem. */
  readonly escalate?: boolean
}

export interface WatchAlertsSnapshot {
  readonly alerts: readonly WatchAlertRecord[]
  readonly total: number
  readonly unread: number
  readonly active: number
  readonly truncated: boolean
}

export interface WatchAlertAckInput {
  readonly alertID: string
  readonly callerSessionId: string
  readonly at: number
}

export interface PrepareCorrectionGrantInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly reviewSummary: string
  /** Required explicit deployment declaration; no secret default. */
  readonly deployment: "single-host-same-location"
  readonly at: number
  /** Short challenge lifetime, bounded by the ledger. */
  readonly ttlMs?: number
}

export interface ConfirmCorrectionGrantInput {
  readonly challenge: string
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly generation: number
  readonly termsDigest: string
  readonly deployment: "single-host-same-location"
  readonly at: number
}

export interface DowngradeCorrectionInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly at: number
}

export interface ReserveCorrectionInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly generation: number
  readonly reservationId: string
  readonly at: number
}

export interface ClaimCorrectionInput {
  readonly taskId: string
  readonly reservationId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly generation: number
  readonly at: number
}

export interface RecordCorrectionOutcomeInput {
  readonly taskId: string
  readonly reservationId: string
  readonly ownerActivation: string
  readonly outcome: "accepted" | "rejected" | "unknown"
  /** The host admission id when the outcome is accepted. */
  readonly admissionID?: string
  readonly at: number
}

export interface RecordCorrectionReceiptInput {
  readonly taskId: string
  readonly reservationId: string
  readonly callerSessionId: string
  /** The activation currently serving the target; a reload cannot inherit a permit. */
  readonly currentActivationId: string
  /** The opaque correlation bound when the reservation was made. Never a caller-chosen id. */
  readonly correlation: string
  readonly at: number
}

export interface AbortCorrectionInput {
  readonly taskId: string
  readonly reservationId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly generation: number
  readonly at: number
}

export interface RecordCorrectionRecoveryInput {
  readonly taskId: string
  readonly reservationId: string
  readonly callerSessionId: string
  readonly progressReportId: string
  readonly resultReference: string
  readonly generation: number
  readonly at: number
}

export interface CorrectionGrantChallenge {
  readonly challenge: string
  readonly taskID: string
  readonly expectedVersion: number
  readonly generation: number
  readonly termsDigest: string
  readonly reviewSummary: string
  readonly deployment: "single-host-same-location"
  readonly expiresAt: number
}

export interface WatchLedger {
  readonly ledgerId: string
  readonly path: string
  /** The SQLite version the ledger accepted; useful for the capability panel. */
  readonly sqliteVersion: string
  readonly journalMode: string
  readonly synchronous: number
  readonly busyTimeoutMs: number
  readonly filesystem: string
  enroll(input: EnrollWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly created: boolean }>
  show(input: { readonly taskID?: string; readonly sessionID: string }): LedgerResult<WatchTaskRecord | null>
  report(input: ReportWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly duplicate: boolean }>
  control(input: ControlWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly changed: boolean }>
  /** Active tasks the observer may sample; paused tasks create no new alerts. */
  listActive(): LedgerResult<readonly WatchTaskRecord[]>
  alerts(taskID: string): LedgerResult<WatchAlertsSnapshot>
  upsertAlert(input: UpsertWatchAlertInput): LedgerResult<{
    readonly alert: WatchAlertRecord
    readonly created: boolean
    readonly escalated: boolean
  }>
  resolveAlert(input: {
    readonly taskId: string
    readonly dedupeKey: string
    readonly at: number
  }): LedgerResult<{ readonly changed: boolean }>
  ackAlert(input: WatchAlertAckInput): LedgerResult<{ readonly alert: WatchAlertRecord; readonly changed: boolean }>
  /** Create a short-lived controlled-surface challenge; never shown to the model. */
  prepareCorrectionGrant(input: PrepareCorrectionGrantInput): LedgerResult<CorrectionGrantChallenge>
  /** Consume one challenge and record a grant; a repeated challenge cannot grant twice. */
  confirmCorrectionGrant(input: ConfirmCorrectionGrantInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: WatchCorrectionGrantRecord
    readonly created: boolean
  }>
  /** Downgrade to alert-only without touching permanent attempt history. */
  downgradeCorrection(input: DowngradeCorrectionInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: WatchCorrectionGrantRecord | null
    readonly changed: boolean
  }>
  /** Permanently reserve the next attempt number. No refund path exists. */
  reserveCorrection(input: ReserveCorrectionInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly attempt: WatchCorrectionAttemptRecord
    readonly created: boolean
  }>
  /** Claim the one send slot for a reservation; reopening cannot claim it again. */
  claimCorrection(input: ClaimCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly claimed: boolean
    /** Only the successful claim receives the opaque dispatch correlation. */
    readonly correlation: string
  }>
  /** Merge a delivery outcome monotonically; never reopens the claimed slot. */
  recordCorrectionOutcome(input: RecordCorrectionOutcomeInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly changed: boolean
  }>
  /** Record the first receipt for an attempt; duplicates never issue a second permit. */
  recordCorrectionReceipt(input: RecordCorrectionReceiptInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly continuePermit: boolean
    readonly duplicate: boolean
    readonly seen: boolean
    readonly refusalReason: string | null
  }>
  abortCorrection(input: AbortCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly aborted: boolean
  }>
  /** Confirm recovery from a new progress report and its matching new result. */
  recordCorrectionRecovery(input: RecordCorrectionRecoveryInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly recovered: boolean
  }>
  /** Read grants and permanent attempts without exposing the challenge nonce. */
  correction(taskID: string): LedgerResult<WatchCorrectionSnapshot>
  /** Controlled direct-child delegation grant; never reachable from a model tool call. */
  prepareDelegationGrant(input: PrepareDelegationGrantInput): LedgerResult<DelegationChallenge>
  confirmDelegationGrant(input: ConfirmDelegationGrantInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: DelegationGrantRecord
    readonly created: boolean
  }>
  revokeDelegationGrant(input: RevokeDelegationGrantInput): LedgerResult<{
    readonly grant: DelegationGrantRecord
    readonly changed: boolean
    readonly childTaskIDs: readonly string[]
  }>
  /** Enroll one child task under an active delegation grant in the same transaction. */
  delegatedEnroll(input: DelegatedEnrollInput): LedgerResult<DelegatedEnrollResult>
  delegationGrantFor(input: {
    readonly parentTaskID: string
    readonly targetSessionID: string
  }): LedgerResult<DelegationGrantRecord | null>
  delegationGrantsFor(parentTaskID: string): LedgerResult<readonly DelegationGrantRecord[]>
  delegatedTaskLink(taskID: string): LedgerResult<DelegatedTaskLink | null>
  /** Atomic ledger facts for a fresh delegated-authority check. */
  delegatedAuthority(taskID: string): LedgerResult<DelegatedAuthoritySnapshot>
  listDelegatedChildren(parentTaskID: string): LedgerResult<readonly DelegatedChildRecord[]>
  close(): void
}

class LedgerFailure extends Error {
  constructor(
    readonly code: WatchLedgerErrorCode,
    readonly detail: string,
  ) {
    super(detail)
    this.name = "LedgerFailure"
  }
}

interface TaskRow {
  readonly task_id: string
  readonly ledger_id: string
  readonly initiator_session_id: string
  readonly target_session_id: string
  readonly goal: string
  readonly mode: string
  readonly watch_state: string
  readonly task_state: string
  readonly version: number
  readonly generation: number
  readonly attempts_used: number
  readonly owner_activation: string
  readonly last_report_id: string | null
  readonly last_report_kind: string | null
  readonly last_report_evidence: string | null
  readonly last_report_at: number | null
  readonly last_report_version: number | null
  readonly created_at: number
  readonly updated_at: number
  readonly completed_at: number | null
  readonly ended_at: number | null
}

interface ReportRow {
  readonly report_id: string
  readonly kind: string
  readonly evidence: string
  readonly created_at: number
  readonly version: number
}

interface ReportedWaitRow {
  readonly task_id: string
  readonly wait_id: string
  readonly wait_kind: string
  readonly wait_for: string
  readonly wait_reason: string
  readonly wait_reference: string
  readonly wait_until: number | null
  readonly wait_at: number
  readonly cleared_at: number | null
  readonly clear_evidence: string | null
}

interface CorrectionGrantRow {
  readonly task_id: string
  readonly grant_id: string
  readonly mode: string
  readonly state: string
  readonly version: number
  readonly generation: number
  readonly scope_target_session_id: string
  readonly review_summary: string
  readonly deployment_statement: string
  readonly terms_digest: string
  readonly confirmation_id: string
  readonly source_delegation_grant_id: string | null
  readonly source_delegation_grant_version: number | null
  readonly granted_at: number
  readonly revoked_at: number | null
}

interface CorrectionChallengeRow {
  readonly challenge: string
  readonly task_id: string
  readonly expected_version: number
  readonly generation: number
  readonly caller_session_id: string
  readonly owner_activation: string
  readonly deployment_statement: string
  readonly terms_digest: string
  readonly review_summary: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

interface CorrectionAttemptRow {
  readonly reservation_id: string
  readonly task_id: string
  readonly attempt_no: number
  readonly state: string
  readonly reserved_at: number
  readonly owner_activation: string
  readonly grant_id: string
  readonly grant_version: number
  readonly reservation_generation: number
  readonly scope_target_session_id: string
  readonly reserved_task_version: number
  readonly correlation: string
  readonly claimed_at: number | null
  readonly claimed_by_activation: string | null
  readonly claimed_generation: number | null
  readonly accepted_at: number | null
  readonly rejected_at: number | null
  readonly unknown_at: number | null
  readonly aborted_at: number | null
  readonly receipt_id: string | null
  readonly receipt_at: number | null
  readonly receipt_caller_session_id: string | null
  readonly receipt_generation: number | null
  readonly receipt_permit_at: number | null
  readonly receipt_refusal_reason: string | null
  readonly last_seen_at: number | null
  readonly last_seen_reason: string | null
  readonly admission_id: string | null
  readonly recovery_report_id: string | null
  readonly recovery_reference: string | null
  readonly recovered_at: number | null
  readonly closed_at: number | null
  readonly closed_reason: string | null
  readonly stop_reason: string | null
}

interface AlertRow {
  readonly alert_id: string
  readonly task_id: string
  readonly dedupe_key: string
  readonly kind: string
  readonly state: string
  readonly summary: string
  readonly reason: string
  readonly first_at: number
  readonly updated_at: number
  readonly read_at: number | null
  readonly escalated_at: number | null
  readonly resolved_at: number | null
}

function openAttemptSql(prefix: string): string {
  return `${prefix}state IN ('reserved','sending','accepted','unknown') OR (${prefix}state = 'receipted' AND ${prefix}receipt_permit_at IS NOT NULL AND ${prefix}closed_at IS NULL)`
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS watch_tasks (
  task_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  initiator_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('alert','limited-correction')),
  watch_state TEXT NOT NULL CHECK (watch_state IN ('active','paused','ended')),
  task_state TEXT NOT NULL CHECK (task_state IN ('not-started','in-progress','waiting','blocked','completed')),
  version INTEGER NOT NULL CHECK (version >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (attempts_used BETWEEN 0 AND ${WATCH_CORRECTION_LIMIT}),
  owner_activation TEXT NOT NULL,
  last_report_id TEXT,
  last_report_kind TEXT,
  last_report_evidence TEXT,
  last_report_at INTEGER,
  last_report_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  ended_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_watch_task_per_session
  ON watch_tasks(target_session_id) WHERE watch_state IN ('active','paused');

CREATE TABLE IF NOT EXISTS enrollment_requests (
  initiator_session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  session_id TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (initiator_session_id, request_id)
);

CREATE TABLE IF NOT EXISTS watch_reports (
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  report_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, report_id)
);

CREATE TABLE IF NOT EXISTS watch_alerts (
  alert_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('idle','blocked','running-silent','wait-overdue','observation-unknown','approval-rejected')),
  state TEXT NOT NULL CHECK (state IN ('unread','read')),
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  read_at INTEGER,
  escalated_at INTEGER,
  resolved_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_alert_per_problem
  ON watch_alerts(task_id, dedupe_key) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS watch_reported_waits (
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  wait_id TEXT NOT NULL,
  wait_kind TEXT NOT NULL,
  wait_for TEXT NOT NULL,
  wait_reason TEXT NOT NULL,
  wait_reference TEXT NOT NULL,
  wait_until INTEGER,
  wait_at INTEGER NOT NULL,
  cleared_at INTEGER,
  clear_evidence TEXT,
  PRIMARY KEY (task_id, wait_id)
);

CREATE TABLE IF NOT EXISTS watch_correction_grants (
  task_id TEXT PRIMARY KEY REFERENCES watch_tasks(task_id),
  grant_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode = 'limited-correction'),
  state TEXT NOT NULL CHECK (state IN ('granted','revoked')),
  version INTEGER NOT NULL CHECK (version >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  scope_target_session_id TEXT NOT NULL,
  review_summary TEXT NOT NULL,
  deployment_statement TEXT NOT NULL CHECK (deployment_statement = 'single-host-same-location'),
  terms_digest TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  source_delegation_grant_id TEXT,
  source_delegation_grant_version INTEGER,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((source_delegation_grant_id IS NULL) = (source_delegation_grant_version IS NULL))
);

CREATE TABLE IF NOT EXISTS watch_correction_challenges (
  challenge TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  expected_version INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  caller_session_id TEXT NOT NULL,
  owner_activation TEXT NOT NULL,
  deployment_statement TEXT NOT NULL CHECK (deployment_statement = 'single-host-same-location'),
  terms_digest TEXT NOT NULL,
  review_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_correction_challenge
  ON watch_correction_challenges(task_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS watch_correction_attempts (
  reservation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND ${WATCH_CORRECTION_LIMIT}),
  state TEXT NOT NULL CHECK (state IN ('reserved','sending','accepted','rejected','unknown','receipted','recovered','aborted')),
  reserved_at INTEGER NOT NULL,
  owner_activation TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  reservation_generation INTEGER NOT NULL,
  scope_target_session_id TEXT NOT NULL,
  reserved_task_version INTEGER NOT NULL,
  correlation TEXT NOT NULL UNIQUE,
  claimed_at INTEGER,
  claimed_by_activation TEXT,
  claimed_generation INTEGER,
  accepted_at INTEGER,
  rejected_at INTEGER,
  unknown_at INTEGER,
  aborted_at INTEGER,
  receipt_id TEXT UNIQUE,
  receipt_at INTEGER,
  receipt_caller_session_id TEXT,
  receipt_generation INTEGER,
  receipt_permit_at INTEGER,
  receipt_refusal_reason TEXT,
  last_seen_at INTEGER,
  last_seen_reason TEXT,
  admission_id TEXT,
  recovery_report_id TEXT,
  recovery_reference TEXT,
  recovered_at INTEGER,
  closed_at INTEGER,
  closed_reason TEXT,
  stop_reason TEXT,
  UNIQUE (task_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_correction_attempt
  ON watch_correction_attempts(task_id) WHERE ${openAttemptSql("")};

CREATE INDEX IF NOT EXISTS correction_attempts_by_task
  ON watch_correction_attempts(task_id, attempt_no);
` + DELEGATION_DDL

const REQUIRED_TABLES = [
  "meta",
  "watch_tasks",
  "enrollment_requests",
  "watch_reports",
  "watch_alerts",
  "watch_reported_waits",
  "watch_correction_grants",
  "watch_correction_challenges",
  "watch_correction_attempts",
  ...DELEGATION_REQUIRED_TABLES,
]
const REQUIRED_TASK_COLUMNS = [
  "task_id",
  "ledger_id",
  "schema_version",
  "protocol_version",
  "initiator_session_id",
  "target_session_id",
  "goal",
  "mode",
  "watch_state",
  "task_state",
  "version",
  "generation",
  "attempts_used",
  "owner_activation",
  "last_report_id",
  "last_report_kind",
  "last_report_evidence",
  "last_report_at",
  "last_report_version",
  "created_at",
  "updated_at",
  "completed_at",
  "ended_at",
]
const REQUIRED_REPORT_COLUMNS = ["task_id", "report_id", "kind", "evidence", "version", "created_at"]
const REQUIRED_REPORTED_WAIT_COLUMNS = [
  "task_id",
  "wait_id",
  "wait_kind",
  "wait_for",
  "wait_reason",
  "wait_reference",
  "wait_until",
  "wait_at",
  "cleared_at",
  "clear_evidence",
]
const REQUIRED_CORRECTION_GRANT_COLUMNS = [
  "task_id",
  "grant_id",
  "mode",
  "state",
  "version",
  "generation",
  "scope_target_session_id",
  "review_summary",
  "deployment_statement",
  "terms_digest",
  "confirmation_id",
  "source_delegation_grant_id",
  "source_delegation_grant_version",
  "granted_at",
  "revoked_at",
]
const REQUIRED_CORRECTION_CHALLENGE_COLUMNS = [
  "challenge",
  "task_id",
  "expected_version",
  "generation",
  "caller_session_id",
  "owner_activation",
  "deployment_statement",
  "terms_digest",
  "review_summary",
  "created_at",
  "expires_at",
  "consumed_at",
]
const REQUIRED_CORRECTION_ATTEMPT_COLUMNS = [
  "reservation_id",
  "task_id",
  "attempt_no",
  "state",
  "reserved_at",
  "owner_activation",
  "grant_id",
  "grant_version",
  "reservation_generation",
  "scope_target_session_id",
  "reserved_task_version",
  "correlation",
  "claimed_at",
  "claimed_by_activation",
  "claimed_generation",
  "accepted_at",
  "rejected_at",
  "unknown_at",
  "aborted_at",
  "receipt_id",
  "receipt_at",
  "receipt_caller_session_id",
  "receipt_generation",
  "receipt_permit_at",
  "receipt_refusal_reason",
  "last_seen_at",
  "last_seen_reason",
  "admission_id",
  "recovery_report_id",
  "recovery_reference",
  "recovered_at",
  "closed_at",
  "closed_reason",
  "stop_reason",
]
const REQUIRED_ALERT_COLUMNS = [
  "alert_id",
  "task_id",
  "dedupe_key",
  "kind",
  "state",
  "summary",
  "reason",
  "first_at",
  "updated_at",
  "read_at",
  "escalated_at",
  "resolved_at",
]
const REQUIRED_ENROLLMENT_COLUMNS = [
  "initiator_session_id",
  "request_id",
  "task_id",
  "session_id",
  "params_fingerprint",
  "created_at",
]
const ANCHOR_NAME = "watch-ledger.identity.json"

interface LedgerAnchor {
  readonly ledgerId: string
  readonly canonicalPath: string
  readonly schemaVersion: number
  readonly protocolVersion: number
  readonly createdAt: number
}

function anchorPathFor(canonicalLedgerPath: string): string {
  return join(dirname(canonicalLedgerPath), ANCHOR_NAME)
}

/**
 * The identity anchor is a small plugin-owned file beside the database. It is
 * not a second authority for tasks, quota or authorization; it only lets an
 * existing identity survive a missing database as an error instead of silently
 * becoming a fresh, empty ledger. Losing both files cannot be distinguished
 * from a first run by the plugin, and the same OS user can always do that.
 */
function readAnchor(path: string): LedgerAnchor | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined
    throw new LedgerFailure("io_error", `could not read the ledger identity anchor: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is not an object")
  }
  const record = parsed as Record<string, unknown>
  const ledgerId = record["ledgerId"]
  const canonicalPath = record["canonicalPath"]
  const schemaVersion = record["schemaVersion"]
  const protocolVersion = record["protocolVersion"]
  const createdAt = record["createdAt"]
  if (
    typeof ledgerId !== "string" ||
    typeof canonicalPath !== "string" ||
    typeof schemaVersion !== "number" ||
    typeof protocolVersion !== "number" ||
    typeof createdAt !== "number"
  ) {
    throw new LedgerFailure("corrupt", "the ledger identity anchor is incomplete")
  }
  if (schemaVersion !== WATCH_LEDGER_SCHEMA_VERSION || protocolVersion !== WATCH_LEDGER_PROTOCOL_VERSION) {
    throw new LedgerFailure(
      "unsupported_schema",
      `identity anchor schema=${schemaVersion} protocol=${protocolVersion}`,
    )
  }
  return { ledgerId, canonicalPath, schemaVersion, protocolVersion, createdAt }
}

function writeAnchor(path: string, anchor: LedgerAnchor): void {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(anchor)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try {
      if (existsSync(temporary)) chmodSync(temporary, 0o600)
    } catch {
      // The failure below is the one that matters.
    }
    throw new LedgerFailure("readonly", `could not write the ledger identity anchor: ${String(error)}`)
  }
}

/**
 * Reject every symlink in the requested path, not just the final file. A
 * parent alias would otherwise be silently resolved and a chmod could touch a
 * directory the fixed-state-path contract did not select.
 */
function assertNoSymlinkComponents(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new LedgerFailure("unsafe_path", "the ledger path must be absolute and canonical")
  }
  let current = "/"
  for (const part of path.split("/").filter((piece) => piece.length > 0)) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return
      throw new LedgerFailure("io_error", `could not inspect ${current}: ${String(error)}`)
    }
    if (stat.isSymbolicLink()) {
      throw new LedgerFailure("unsafe_path", `the ledger path contains a symlink: ${current}`)
    }
  }
}

export function openWatchLedger(options: OpenWatchLedgerOptions): OpenWatchLedgerResult {
  const attempts = Math.max(1, Math.trunc(options.openAttempts ?? 3))
  let last: OpenWatchLedgerResult | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = openOnce(options)
    if (result.ok || result.code !== "lock_timeout") return result
    last = result
    // A cold start can lose a short race while the first process creates the
    // schema. Retry a bounded number of times; a persistent lock is reported.
    Bun.sleepSync(10 * (attempt + 1))
  }
  return last ?? { ok: false, code: "lock_timeout", detail: "the ledger did not open" }
}

function openOnce(options: OpenWatchLedgerOptions): OpenWatchLedgerResult {
  let db: Database | undefined
  try {
    const path = options.path
    // Check the requested path before creating or chmod-ing anything: a parent
    // symlink is an alias to a directory this fixed-state-path contract did not
    // select, and resolving it silently is not acceptable.
    assertNoSymlinkComponents(path)
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertNoSymlinkComponents(path)
    chmodSync(directory, 0o700)

    const anchorPath = anchorPathFor(path)
    assertNoSymlinkComponents(anchorPath)
    const anchor = readAnchor(anchorPath)
    if (anchor !== undefined) {
      if (anchor.canonicalPath !== path) {
        throw new LedgerFailure(
          "ledger_path_mismatch",
          `identity anchor path=${anchor.canonicalPath} opened=${path}`,
        )
      }
      if (!existsSync(path)) {
        throw new LedgerFailure(
          "ledger_missing",
          "the ledger identity anchor exists but the database is missing; it is not recreated",
        )
      }
    }
    checkWritable(path, directory)

    db = new Database(path, { create: anchor === undefined, strict: true })
    chmodSync(path, 0o600)
    const requestedBusyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 500))
    db.run(`PRAGMA busy_timeout = ${requestedBusyTimeoutMs}`)
    const busyTimeoutMs = (db.query("PRAGMA busy_timeout").get() as { timeout?: number }).timeout ?? -1
    db.run("PRAGMA synchronous = FULL")
    db.run("PRAGMA foreign_keys = ON")

    const versionRow = db.query("SELECT sqlite_version() AS version").get() as { version: string }
    // A caller may only tighten the runtime gate. A higher requested version
    // must never turn a lower actual embedded SQLite into a supported one.
    const sqliteVersion =
      options.sqliteVersion === undefined
        ? versionRow.version
        : versionAtLeast(versionRow.version, options.sqliteVersion)
          ? options.sqliteVersion
          : versionRow.version
    if (!versionAtLeast(sqliteVersion, WATCH_MIN_SQLITE)) {
      throw new LedgerFailure(
        "unsafe_sqlite",
        `SQLite ${sqliteVersion} predates ${WATCH_MIN_SQLITE}; the WAL-reset fix is required`,
      )
    }

    const currentJournal = db.query("PRAGMA journal_mode").get() as { journal_mode?: string }
    if (currentJournal.journal_mode !== "wal") {
      const journal = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string }
      if (journal.journal_mode !== "wal") {
        throw new LedgerFailure("readonly", `WAL is unavailable (journal_mode=${journal.journal_mode ?? "unknown"})`)
      }
    }
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode?: string }).journal_mode ?? "unknown"
    const synchronous = (db.query("PRAGMA synchronous").get() as { synchronous?: number }).synchronous ?? -1

    const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check?: string }>
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new LedgerFailure("corrupt", "PRAGMA quick_check did not return ok")
    }

    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )
    const existing = tables.size > 0
    if (!existing) {
      if (anchor !== undefined) {
        throw new LedgerFailure(
          "ledger_missing",
          "the ledger identity anchor exists but the database has no schema; it is not recreated",
        )
      }
      initializeLedger(db, path, options.now?.() ?? Date.now())
    } else {
      for (const table of REQUIRED_TABLES) {
        if (!tables.has(table)) throw new LedgerFailure("corrupt", `the ledger is missing the ${table} table`)
      }
      assertColumns(db, "watch_tasks", REQUIRED_TASK_COLUMNS)
      assertColumns(db, "watch_reports", REQUIRED_REPORT_COLUMNS)
      assertColumns(db, "enrollment_requests", REQUIRED_ENROLLMENT_COLUMNS)
      assertColumns(db, "watch_alerts", REQUIRED_ALERT_COLUMNS)
      assertColumns(db, "watch_reported_waits", REQUIRED_REPORTED_WAIT_COLUMNS)
      assertColumns(db, "watch_correction_grants", REQUIRED_CORRECTION_GRANT_COLUMNS)
      assertColumns(db, "watch_correction_challenges", REQUIRED_CORRECTION_CHALLENGE_COLUMNS)
      assertColumns(db, "watch_correction_attempts", REQUIRED_CORRECTION_ATTEMPT_COLUMNS)
      assertColumns(db, "watch_delegation_grants", REQUIRED_DELEGATION_GRANT_COLUMNS)
      assertColumns(db, "watch_delegation_challenges", REQUIRED_DELEGATION_CHALLENGE_COLUMNS)
      assertColumns(db, "watch_delegated_tasks", REQUIRED_DELEGATED_TASK_COLUMNS)
    }

    const metadata = readMetadata(db)
    if (metadata.canonicalPath === undefined) {
      throw new LedgerFailure("corrupt", "the ledger has no canonical path")
    }
    if (metadata.canonicalPath !== path) {
      throw new LedgerFailure("ledger_path_mismatch", `stored=${metadata.canonicalPath} opened=${path}`)
    }
    if (metadata.schemaVersion !== WATCH_LEDGER_SCHEMA_VERSION) {
      throw new LedgerFailure("unsupported_schema", `schema_version=${metadata.schemaVersion}`)
    }
    if (metadata.protocolVersion !== WATCH_LEDGER_PROTOCOL_VERSION) {
      throw new LedgerFailure("unsupported_schema", `protocol_version=${metadata.protocolVersion}`)
    }
    if (metadata.ledgerId === undefined) throw new LedgerFailure("corrupt", "the ledger has no ledger id")
    const mismatch = db
      .query("SELECT COUNT(*) AS n FROM watch_tasks WHERE ledger_id <> ?")
      .get(metadata.ledgerId) as { n: number }
    if (mismatch.n !== 0) {
      throw new LedgerFailure("ledger_mismatch", "task rows carry a different ledger id")
    }
    assertAttemptsIntegrity(db)
    assertDelegationIntegrity(db)
    if (anchor !== undefined) {
      if (anchor.ledgerId !== metadata.ledgerId) {
        throw new LedgerFailure(
          "ledger_mismatch",
          `identity anchor ledger=${anchor.ledgerId} database=${metadata.ledgerId}`,
        )
      }
    } else {
      writeAnchor(anchorPath, {
        ledgerId: metadata.ledgerId,
        canonicalPath: path,
        schemaVersion: WATCH_LEDGER_SCHEMA_VERSION,
        protocolVersion: WATCH_LEDGER_PROTOCOL_VERSION,
        createdAt: metadata.createdAt ?? options.now?.() ?? Date.now(),
      })
    }

    const filesystem = filesystemType(directory)
    const ledger = new SqliteWatchLedger(
      db,
      path,
      metadata.ledgerId,
      sqliteVersion,
      journalMode,
      synchronous,
      busyTimeoutMs,
      filesystem,
      options.now ?? Date.now,
    )
    ledger.secureFiles()
    db = undefined
    return { ok: true, ledger }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // The failure being reported is the useful one.
    }
    return { ok: false, ...mapError(error) }
  }
}

function checkWritable(file: string, directory: string): void {
  if (existsSync(file)) {
    try {
      accessSync(file, 0o2)
    } catch {
      throw new LedgerFailure("readonly", "the ledger file is not writable")
    }
  }
  try {
    accessSync(directory, 0o2)
  } catch {
    throw new LedgerFailure("readonly", "the ledger directory is not writable")
  }
}

/**
 * Create the schema and its identity in one immediate transaction. A second
 * process that arrives during a cold start either waits for the lock or sees a
 * complete ledger; it never sees half a schema and calls that corruption.
 */
function initializeLedger(db: Database, canonical: string, now: number): void {
  const insert = "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  db.transaction(() => {
    // The lock is acquired after the caller's first look. A process that lost
    // the race must not replace the winner's identity with its own.
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    if (tables.length > 0) return
    db.run(DDL)
    db.run(insert, ["ledger_id", randomUUID()])
    db.run(insert, ["schema_version", String(WATCH_LEDGER_SCHEMA_VERSION)])
    db.run(insert, ["protocol_version", String(WATCH_LEDGER_PROTOCOL_VERSION)])
    db.run(insert, ["canonical_path", canonical])
    db.run(insert, ["created_at", String(now)])
  }).immediate()
}

function assertColumns(db: Database, table: string, required: readonly string[]): void {
  const columns = new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  )
  for (const column of required) {
    if (!columns.has(column)) {
      throw new LedgerFailure("corrupt", `the ${table} table is missing the ${column} column`)
    }
  }
}

function assertAttemptsIntegrity(db: Database): void {
  const bad = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_tasks
       WHERE attempts_used IS NULL
          OR typeof(attempts_used) <> 'integer'
          OR attempts_used < 0
          OR attempts_used > ?`,
    )
    .get(WATCH_CORRECTION_LIMIT) as { n: number }
  if (bad.n !== 0) {
    throw new LedgerFailure("corrupt", "a task row has an invalid attempts_used value")
  }
  const mismatch = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_tasks t
       WHERE attempts_used <> (
         SELECT COUNT(*) FROM watch_correction_attempts a WHERE a.task_id = t.task_id
       )`,
    )
    .get() as { n: number }
  if (mismatch.n !== 0) {
    throw new LedgerFailure("corrupt", "attempts_used does not match the permanent attempt rows")
  }
  const badGrant = db
    .query("SELECT COUNT(*) AS n FROM watch_correction_grants WHERE mode <> 'limited-correction' OR version < 1")
    .get() as { n: number }
  if (badGrant.n !== 0) {
    throw new LedgerFailure("corrupt", "a correction grant row is invalid")
  }
}

interface Metadata {
  readonly ledgerId?: string
  readonly schemaVersion?: number
  readonly protocolVersion?: number
  readonly canonicalPath?: string
  readonly createdAt?: number
}

function readMetadata(db: Database): Metadata {
  const rows = db.query("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>
  const values = new Map(rows.map((row) => [row.key, row.value]))
  const number = (key: string): number | undefined => {
    const value = values.get(key)
    if (value === undefined) return undefined
    // `parseInt("1junk")` is 1; a stored protocol number must be exactly a
    // non-negative integer string.
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return {
    ledgerId: values.get("ledger_id"),
    schemaVersion: number("schema_version"),
    protocolVersion: number("protocol_version"),
    canonicalPath: values.get("canonical_path"),
    createdAt: number("created_at"),
  }
}

function correctionTermsDigest(task: TaskRow, deployment: string): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        WATCH_CORRECTION_TERMS,
        deployment,
        task.initiator_session_id,
        task.target_session_id,
        task.goal,
        task.generation,
      ]),
    )
    .digest("hex")
}

class SqliteWatchLedger implements WatchLedger {
  constructor(
    private readonly db: Database,
    readonly path: string,
    readonly ledgerId: string,
    readonly sqliteVersion: string,
    readonly journalMode: string,
    readonly synchronous: number,
    readonly busyTimeoutMs: number,
    readonly filesystem: string,
    private readonly now: () => number,
  ) {}

  close(): void {
    try {
      // Leave the committed state in the main database, not only in a WAL a
      // copy would miss. This is a checkpoint, not a rewrite of any task.
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      // Closing is still the right next step; a busy checkpoint is not a reason
      // to keep the handle open.
    }
    this.db.close()
  }

  enroll(input: EnrollWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly created: boolean }> {
    return this.immediate(() => {
      const requestId = requiredIdentifier(input.requestId, "requestId")
      const initiator = requiredIdentifier(input.initiatorSessionId, "initiatorSessionId")
      const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const goal = requiredGoal(input.goal)
      if (input.mode !== "alert") throw new LedgerFailure("invalid_input", "only alert-only mode is available")

      const fingerprint = enrollmentFingerprint({
        initiatorSessionId: initiator,
        targetSessionId: target,
        goal,
        mode: "alert",
      })
      const existingRequest = this.db
        .query("SELECT * FROM enrollment_requests WHERE initiator_session_id = ? AND request_id = ?")
        .get(initiator, requestId) as
        | { task_id: string; session_id: string; params_fingerprint: string }
        | null
      if (existingRequest !== null) {
        if (existingRequest.params_fingerprint !== fingerprint || existingRequest.session_id !== target) {
          throw new LedgerFailure("request_conflict", "that request id was used with different parameters")
        }
        return { task: this.task(existingRequest.task_id), created: false }
      }

      const live = this.db
        .query(
          "SELECT task_id FROM watch_tasks WHERE target_session_id = ? AND watch_state IN ('active','paused') LIMIT 1",
        )
        .get(target) as { task_id: string } | null
      if (live !== null) {
        throw new LedgerFailure("session_conflict", `the session already has a live watched task: ${live.task_id}`)
      }

      const taskID = randomUUID()
      const at = this.now()
      this.db
        .query(
          `INSERT INTO watch_tasks (
            task_id, ledger_id, schema_version, protocol_version,
            initiator_session_id, target_session_id, goal, mode,
            watch_state, task_state, version, generation, owner_activation,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'alert', 'active', 'not-started', 1, 1, ?, ?, ?)`,
        )
        .run(
          taskID,
          this.ledgerId,
          WATCH_LEDGER_SCHEMA_VERSION,
          WATCH_LEDGER_PROTOCOL_VERSION,
          initiator,
          target,
          goal,
          owner,
          at,
          at,
        )
      this.db
        .query(
          `INSERT INTO enrollment_requests (
            initiator_session_id, request_id, task_id, session_id, params_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(initiator, requestId, taskID, target, fingerprint, at)
      return { task: this.task(taskID), created: true }
    })
  }

  show(input: { readonly taskID?: string; readonly sessionID: string }): LedgerResult<WatchTaskRecord | null> {
    const sessionID = requiredIdentifier(input.sessionID, "sessionID")
    return this.read(() => {
      if (input.taskID !== undefined) {
        const taskID = requiredIdentifier(input.taskID, "taskID")
        const row = this.taskRow(taskID)
        if (row === null) return null
        if (row.target_session_id !== sessionID && row.initiator_session_id !== sessionID) return null
        return taskFromRow(row, this.reportedWaits(row.task_id))
      }
      const row = this.db
        .query(
          `SELECT * FROM watch_tasks
           WHERE target_session_id = ? OR initiator_session_id = ?
           ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        )
        .get(sessionID, sessionID) as TaskRow | null
      return row === null ? null : taskFromRow(row, this.reportedWaits(row.task_id))
    })
  }

  report(input: ReportWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly duplicate: boolean }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const reportID = requiredIdentifier(input.reportId, "reportId")
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new LedgerFailure("invalid_input", "expectedVersion must be a positive integer")
      }
      const kind = readReportKind(input.kind)
      if (!kind.ok) throw new LedgerFailure("invalid_input", kind.reason)
      const evidence = readEvidence(kind.value, input.evidence)
      if (!evidence.ok) throw new LedgerFailure("invalid_input", evidence.reason)

      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.target_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the target session may report on this task")
      }

      const existing = this.db
        .query("SELECT * FROM watch_reports WHERE task_id = ? AND report_id = ?")
        .get(taskID, reportID) as ReportRow | null
      if (existing !== null) {
        if (existing.kind !== kind.value || existing.evidence !== canonicalJson(evidence.value)) {
          throw new LedgerFailure("report_conflict", "that report id was used with different evidence")
        }
        return { task: this.task(taskID), duplicate: true }
      }

      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure(
          "stale_version",
          `the task is at version ${task.version}, not ${input.expectedVersion}`,
        )
      }
      if (task.watch_state === "ended") {
        throw new LedgerFailure("ended", "the watch has ended; reports are no longer recorded")
      }
      if (task.watch_state === "paused") {
        // Pausing stops proactive reminders, not the business task; a report
        // may still arrive and is recorded.
      }
      const next = nextTaskState(task.task_state as WatchedTaskState, kind.value)
      if (!next.ok) throw new LedgerFailure("invalid_transition", next.reason)

      const at = this.now()
      const version = task.version + 1
      const encoded = canonicalJson(evidence.value)
      const completedAt = next.value === "completed" ? at : task.completed_at
      const waitingID = kind.value === "waiting" ? (evidence.value.waitID ?? reportID) : null
      const priorWaitAt = waitingID === null ? null : this.reportedWaitAt(taskID, waitingID)
      this.recordReportedWrites(taskID, kind.value, evidence.value, reportID, at)
      this.closeReceiptedForReport(taskID, kind.value, evidence.value, reportID, at, priorWaitAt)
      // Completion ends supervision: the business goal is done, so the live
      // slot is released. The task row and its reports remain as history; this
      // is not a manual "end", which is what must not be read as success.
      const completes = next.value === "completed"
      const watchState = completes ? "ended" : task.watch_state
      const endedAt = completes ? at : task.ended_at
      this.db
        .query(
          "INSERT INTO watch_reports (task_id, report_id, kind, evidence, version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(taskID, reportID, kind.value, encoded, version, at)
      this.db
        .query(
          `UPDATE watch_tasks SET
            task_state = ?, watch_state = ?, version = ?, updated_at = ?,
            last_report_id = ?, last_report_kind = ?, last_report_evidence = ?,
            last_report_at = ?, last_report_version = ?, completed_at = ?, ended_at = ?
           WHERE task_id = ?`,
        )
        .run(
          next.value,
          watchState,
          version,
          at,
          reportID,
          kind.value,
          encoded,
          at,
          version,
          completedAt,
          endedAt,
          taskID,
        )
      return { task: this.task(taskID), duplicate: false }
    })
  }

  control(input: ControlWatchTaskInput): LedgerResult<{ readonly task: WatchTaskRecord; readonly changed: boolean }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new LedgerFailure("invalid_input", "expectedVersion must be a positive integer")
      }
      if (input.operation !== "pause" && input.operation !== "end") {
        throw new LedgerFailure("invalid_input", "operation must be pause or end")
      }
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the enrolling session may control this task")
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure(
          "stale_version",
          `the task is at version ${task.version}, not ${input.expectedVersion}`,
        )
      }
      if (task.watch_state === "ended") {
        if (input.operation === "end") return { task: this.task(taskID), changed: false }
        throw new LedgerFailure("ended", "the watch has ended")
      }
      if (input.operation === "pause" && task.watch_state === "paused") {
        return { task: this.task(taskID), changed: false }
      }

      const at = this.now()
      const version = task.version + 1
      if (input.operation === "pause") {
        this.db
          .query("UPDATE watch_tasks SET watch_state = 'paused', version = ?, updated_at = ? WHERE task_id = ?")
          .run(version, at, taskID)
      } else {
        this.db
          .query(
            `UPDATE watch_tasks SET watch_state = 'ended', version = ?, updated_at = ?, ended_at = ?
             WHERE task_id = ?`,
          )
          .run(version, at, at, taskID)
      }
      return { task: this.task(taskID), changed: true }
    })
  }

  listActive(): LedgerResult<readonly WatchTaskRecord[]> {
    return this.read(() => {
      const rows = this.db
        .query("SELECT * FROM watch_tasks WHERE watch_state IN ('active','paused') ORDER BY created_at")
        .all() as TaskRow[]
      return rows.map((row) => taskFromRow(row, this.reportedWaits(row.task_id)))
    })
  }

  alerts(taskID: string): LedgerResult<WatchAlertsSnapshot> {
    const id = requiredIdentifier(taskID, "taskID")
    return this.read(() => {
      const limit = 20
      const rows = this.db
        .query(
          `SELECT * FROM watch_alerts WHERE task_id = ?
           ORDER BY resolved_at IS NULL DESC, updated_at DESC, alert_id
           LIMIT ?`,
        )
        .all(id, limit) as AlertRow[]
      const counts = this.db
        .query(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN state = 'unread' THEN 1 ELSE 0 END), 0) AS unread,
                  COALESCE(SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END), 0) AS active
           FROM watch_alerts WHERE task_id = ?`,
        )
        .get(id) as { total: number; unread: number; active: number }
      return {
        alerts: rows.map(alertFromRow),
        total: counts.total,
        unread: counts.unread,
        active: counts.active,
        truncated: counts.total > rows.length,
      }
    })
  }

  upsertAlert(input: UpsertWatchAlertInput): LedgerResult<{
    readonly alert: WatchAlertRecord
    readonly created: boolean
    readonly escalated: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const dedupeKey = readBoundedText(input.dedupeKey, "dedupeKey", 200)
      if (!dedupeKey.ok) throw new LedgerFailure("invalid_input", dedupeKey.reason)
      const kind = readAlertKind(input.kind)
      if (!kind.ok) throw new LedgerFailure("invalid_input", kind.reason)
      const summary = readBoundedText(input.summary, "summary", WATCH_ALERT_SUMMARY_LIMIT)
      if (!summary.ok) throw new LedgerFailure("invalid_input", summary.reason)
      const reason = readBoundedText(input.reason, "reason", WATCH_ALERT_REASON_LIMIT)
      if (!reason.ok) throw new LedgerFailure("invalid_input", reason.reason)
      if (!Number.isSafeInteger(input.at) || input.at < 0) {
        throw new LedgerFailure("invalid_input", "alert time must be a non-negative integer")
      }

      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.watch_state !== "active") {
        throw new LedgerFailure("not_active", "the watch is paused or ended; no new alert is created")
      }

      const existing = this.db
        .query("SELECT * FROM watch_alerts WHERE task_id = ? AND dedupe_key = ? AND resolved_at IS NULL")
        .get(taskID, dedupeKey.value) as AlertRow | null
      if (existing === null) {
        const alertID = randomUUID()
        this.db
          .query(
            `INSERT INTO watch_alerts (
              alert_id, task_id, dedupe_key, kind, state, summary, reason,
              first_at, updated_at, read_at, escalated_at, resolved_at
            ) VALUES (?, ?, ?, ?, 'unread', ?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            alertID,
            taskID,
            dedupeKey.value,
            kind.value,
            summary.value,
            reason.value,
            input.at,
            input.at,
            null,
          )
        return { alert: this.alert(alertID), created: true, escalated: false }
      }

      const escalated = input.escalate === true && existing.escalated_at === null
      this.db
        .query(
          `UPDATE watch_alerts SET
            summary = ?, reason = ?, updated_at = ?, escalated_at = ?
           WHERE alert_id = ?`,
        )
        .run(
          summary.value,
          reason.value,
          input.at,
          escalated ? input.at : existing.escalated_at,
          existing.alert_id,
        )
      return { alert: this.alert(existing.alert_id), created: false, escalated }
    })
  }

  resolveAlert(input: {
    readonly taskId: string
    readonly dedupeKey: string
    readonly at: number
  }): LedgerResult<{ readonly changed: boolean }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const dedupeKey = readBoundedText(input.dedupeKey, "dedupeKey", 200)
      if (!dedupeKey.ok) throw new LedgerFailure("invalid_input", dedupeKey.reason)
      const result = this.db
        .query(
          "UPDATE watch_alerts SET resolved_at = ?, updated_at = ? WHERE task_id = ? AND dedupe_key = ? AND resolved_at IS NULL",
        )
        .run(input.at, input.at, taskID, dedupeKey.value)
      return { changed: result.changes > 0 }
    })
  }

  ackAlert(input: WatchAlertAckInput): LedgerResult<{ readonly alert: WatchAlertRecord; readonly changed: boolean }> {
    return this.immediate(() => {
      const alertID = requiredIdentifier(input.alertID, "alertID")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const row = this.db.query("SELECT * FROM watch_alerts WHERE alert_id = ?").get(alertID) as AlertRow | null
      if (row === null) throw new LedgerFailure("unknown_alert", alertID)
      const task = this.taskRow(row.task_id)
      if (task === null) throw new LedgerFailure("unknown_task", row.task_id)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the task initiator may acknowledge this alert")
      }
      if (row.state === "read") return { alert: alertFromRow(row), changed: false }
      this.db
        .query("UPDATE watch_alerts SET state = 'read', read_at = ?, updated_at = ? WHERE alert_id = ?")
        .run(input.at, input.at, alertID)
      return { alert: this.alert(alertID), changed: true }
    })
  }

  prepareCorrectionGrant(input: PrepareCorrectionGrantInput): LedgerResult<CorrectionGrantChallenge> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const reviewSummary = readBoundedText(input.reviewSummary, "reviewSummary", WATCH_ALERT_REASON_LIMIT)
      if (!reviewSummary.ok) throw new LedgerFailure("invalid_input", reviewSummary.reason)
      if (reviewSummary.value !== WATCH_CORRECTION_TERMS) {
        throw new LedgerFailure("invalid_input", "reviewSummary must be the canonical correction terms")
      }
      if (input.deployment !== "single-host-same-location") {
        throw new LedgerFailure("invalid_input", "deployment must be the explicit single-host-same-location declaration")
      }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new LedgerFailure("invalid_input", "expectedVersion must be a positive integer")
      }
      if (!Number.isSafeInteger(input.at) || input.at < 0) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative integer")
      }
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the task initiator may prepare a grant")
      }
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure("stale_version", `the task is at version ${task.version}`)
      }
      if (task.watch_state === "ended" || task.task_state === "completed") {
        throw new LedgerFailure("invalid_transition", "a completed or ended task cannot receive a grant")
      }
      if (this.isDelegatedTask(task.task_id)) {
        throw new LedgerFailure(
          "not_granted",
          "a delegated child's correction grant is derived from its delegation grant; revoke and re-grant delegation instead",
        )
      }
      const existingGrant = this.correctionGrantRow(task.task_id)
      if (existingGrant?.state === "granted") {
        throw new LedgerFailure("grant_active", "an active correction grant already exists; downgrade it first")
      }
      const ttl = Math.min(Math.max(Math.trunc(input.ttlMs ?? 120_000), 30_000), 300_000)
      const termsDigest = correctionTermsDigest(task, input.deployment)
      this.db
        .query("UPDATE watch_correction_challenges SET consumed_at = ? WHERE task_id = ? AND consumed_at IS NULL")
        .run(input.at, taskID)
      const challenge = randomUUID()
      const expiresAt = input.at + ttl
      this.db
        .query(
          `INSERT INTO watch_correction_challenges (
            challenge, task_id, expected_version, generation, caller_session_id, owner_activation,
            deployment_statement, terms_digest, review_summary, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          challenge,
          taskID,
          task.version,
          task.generation,
          caller,
          task.owner_activation,
          input.deployment,
          termsDigest,
          reviewSummary.value,
          input.at,
          expiresAt,
        )
      return {
        challenge,
        taskID,
        expectedVersion: task.version,
        generation: task.generation,
        termsDigest,
        reviewSummary: reviewSummary.value,
        deployment: input.deployment,
        expiresAt,
      }
    })
  }

  confirmCorrectionGrant(input: ConfirmCorrectionGrantInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: WatchCorrectionGrantRecord
    readonly created: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const challenge = requiredIdentifier(input.challenge, "challenge")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const termsDigest = requiredIdentifier(input.termsDigest, "termsDigest")
      if (input.deployment !== "single-host-same-location") {
        throw new LedgerFailure("invalid_input", "deployment must be the explicit single-host-same-location declaration")
      }
      if (!Number.isSafeInteger(input.at) || input.at < 0) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative integer")
      }
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the task initiator may confirm a grant")
      }
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      if (task.version !== input.expectedVersion || task.generation !== input.generation) {
        throw new LedgerFailure("stale_version", "the task version or generation changed")
      }
      if (this.isDelegatedTask(task.task_id)) {
        throw new LedgerFailure(
          "not_granted",
          "a delegated child's correction grant is derived from its delegation grant; revoke and re-grant delegation instead",
        )
      }
      const activeGrant = this.correctionGrantRow(task.task_id)
      if (activeGrant?.state === "granted") {
        throw new LedgerFailure("grant_active", "an active correction grant already exists; downgrade it first")
      }
      const row = this.db
        .query("SELECT * FROM watch_correction_challenges WHERE challenge = ?")
        .get(challenge) as CorrectionChallengeRow | null
      if (row === null || row.consumed_at !== null) {
        throw new LedgerFailure("grant_expired", "the challenge is unknown or already consumed")
      }
      if (row.expires_at <= input.at) {
        this.db
          .query("UPDATE watch_correction_challenges SET consumed_at = ? WHERE challenge = ?")
          .run(input.at, challenge)
        throw new LedgerFailure("grant_expired", "the challenge has expired")
      }
      const currentTerms = correctionTermsDigest(task, input.deployment)
      if (
        termsDigest !== currentTerms ||
        row.terms_digest !== currentTerms ||
        row.task_id !== task.task_id ||
        row.expected_version !== input.expectedVersion ||
        row.generation !== input.generation ||
        row.caller_session_id !== caller ||
        row.owner_activation !== owner ||
        row.deployment_statement !== input.deployment ||
        row.terms_digest !== termsDigest
      ) {
        throw new LedgerFailure("grant_expired", "the challenge does not match this task, version or terms")
      }
      const existing = this.db
        .query("SELECT * FROM watch_correction_grants WHERE task_id = ?")
        .get(task.task_id) as CorrectionGrantRow | null
      const version = (existing?.version ?? 0) + 1
      this.db
        .query("UPDATE watch_correction_challenges SET consumed_at = ? WHERE challenge = ?")
        .run(input.at, challenge)
      if (existing === null) {
        this.db
          .query(
            `INSERT INTO watch_correction_grants (
              task_id, grant_id, mode, state, version, generation,
              scope_target_session_id, review_summary, deployment_statement, terms_digest,
              confirmation_id, granted_at
            ) VALUES (?, ?, 'limited-correction', 'granted', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.task_id,
            randomUUID(),
            version,
            task.generation,
            task.target_session_id,
            row.review_summary,
            row.deployment_statement,
            row.terms_digest,
            row.challenge,
            input.at,
          )
      } else {
        this.db
          .query(
            `UPDATE watch_correction_grants SET
              grant_id = ?, mode = 'limited-correction', state = 'granted', version = ?,
              generation = ?, scope_target_session_id = ?, review_summary = ?,
              deployment_statement = ?, terms_digest = ?, confirmation_id = ?, granted_at = ?, revoked_at = NULL
             WHERE task_id = ?`,
          )
          .run(
            randomUUID(),
            version,
            task.generation,
            task.target_session_id,
            row.review_summary,
            row.deployment_statement,
            row.terms_digest,
            row.challenge,
            input.at,
            task.task_id,
          )
      }
      this.db
        .query("UPDATE watch_tasks SET mode = 'limited-correction', version = version + 1, updated_at = ? WHERE task_id = ?")
        .run(input.at, task.task_id)
      return {
        task: this.task(task.task_id),
        grant: correctionGrantFromRow(this.correctionGrantRow(task.task_id)),
        created: existing === null,
      }
    })
  }

  downgradeCorrection(input: DowngradeCorrectionInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: WatchCorrectionGrantRecord | null
    readonly changed: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the task initiator may downgrade its grant")
      }
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure("stale_version", `the task is at version ${task.version}`)
      }
      const row = this.correctionGrantRow(task.task_id)
      if (row === null) throw new LedgerFailure("not_granted", "there is no correction grant to downgrade")
      if (row.state === "revoked") {
        return { task: this.task(task.task_id), grant: correctionGrantFromRow(row), changed: false }
      }
      this.db
        .query("UPDATE watch_correction_grants SET state = 'revoked', version = version + 1, revoked_at = ? WHERE task_id = ?")
        .run(input.at, task.task_id)
      this.db
        .query("UPDATE watch_tasks SET mode = 'alert', version = version + 1, updated_at = ? WHERE task_id = ?")
        .run(input.at, task.task_id)
      return {
        task: this.task(task.task_id),
        grant: correctionGrantFromRow(this.correctionGrantRow(task.task_id)),
        changed: true,
      }
    })
  }

  reserveCorrection(input: ReserveCorrectionInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly attempt: WatchCorrectionAttemptRecord
    readonly created: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.initiator_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the task initiator may reserve an attempt")
      }
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      const existing = this.correctionAttemptRow(reservationID)
      if (existing !== null) {
        if (existing.task_id !== taskID) {
          throw new LedgerFailure("conflict", "that reservation id belongs to another task")
        }
        return { task: this.task(taskID), attempt: correctionAttemptFromRow(existing), created: false }
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure("stale_version", `the task is at version ${task.version}`)
      }
      if (task.generation !== input.generation) {
        throw new LedgerFailure("stale_generation", `the task is at generation ${task.generation}`)
      }
      if (!Number.isSafeInteger(input.at) || input.at < task.updated_at) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      if (task.watch_state !== "active" || task.task_state === "completed") {
        throw new LedgerFailure("not_active", "the task is not active and unfinished")
      }
      if (task.last_report_id === null) {
        throw new LedgerFailure("not_granted", "the target has not participated in the protocol")
      }
      const grant = this.correctionGrantRow(task.task_id)
      if (grant === null) throw new LedgerFailure("not_granted", "no correction grant is recorded")
      if (grant.state !== "granted" || grant.generation !== task.generation) {
        throw new LedgerFailure("not_granted", "the correction grant is revoked or bound to another generation")
      }
      if (grant.scope_target_session_id !== task.target_session_id) {
        throw new LedgerFailure("not_granted", "the correction grant does not cover this target")
      }
      if (grant.terms_digest !== correctionTermsDigest(task, grant.deployment_statement)) {
        throw new LedgerFailure("not_granted", "the correction terms changed; the old grant cannot continue")
      }
      const delegated = assertDelegatedCorrectionAuthority(this.delegationHost(), {
        taskID: task.task_id,
        targetSessionID: task.target_session_id,
        ownerActivation: owner,
        generation: task.generation,
        sourceGrantID: grant.source_delegation_grant_id,
        sourceGrantVersion: grant.source_delegation_grant_version,
      })
      if (!delegated.ok) {
        throw new LedgerFailure("not_granted", delegated.reason ?? "the delegated authority is no longer active")
      }
      const counts = this.db
        .query("SELECT COUNT(*) AS used, COALESCE(MAX(attempt_no), 0) AS highest FROM watch_correction_attempts WHERE task_id = ?")
        .get(task.task_id) as { used: number; highest: number }
      if (counts.used >= WATCH_CORRECTION_LIMIT) {
        throw new LedgerFailure("attempt_limit", "the task has spent all three permanent attempts")
      }
      const pending = this.db
        .query(
          `SELECT 1 AS yes FROM watch_correction_attempts WHERE task_id = ? AND (${openAttemptSql("")}) LIMIT 1`,
        )
        .get(task.task_id) as { yes: number } | null
      if (pending !== null) throw new LedgerFailure("pending_attempt", "the task already has an unresolved attempt")
      const sessionUnresolved = this.db
        .query(
          `SELECT 1 AS yes FROM watch_correction_attempts a
           JOIN watch_tasks t ON t.task_id = a.task_id
           WHERE t.target_session_id = ? AND t.task_id <> ?
             AND (${openAttemptSql("a.")})
           LIMIT 1`,
        )
        .get(task.target_session_id, task.task_id) as { yes: number } | null
      if (sessionUnresolved !== null) {
        throw new LedgerFailure("session_unresolved", "an older task for this session still has an unresolved attempt")
      }
      const ordinal = counts.highest + 1
      try {
        this.db
          .query(
            `INSERT INTO watch_correction_attempts (
              reservation_id, task_id, attempt_no, state, reserved_at,
              owner_activation, grant_id, grant_version, reservation_generation,
              scope_target_session_id, reserved_task_version, correlation
            ) VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reservationID,
            task.task_id,
            ordinal,
            input.at,
            task.owner_activation,
            grant.grant_id,
            grant.version,
            task.generation,
            task.target_session_id,
            task.version + 1,
            randomUUID(),
          )
      } catch (error) {
        const text = String(error)
        if (text.includes("one_pending_correction_attempt")) {
          throw new LedgerFailure("pending_attempt", "another attempt was reserved concurrently")
        }
        if (text.includes("attempt_no")) {
          throw new LedgerFailure("attempt_limit", "the task has spent all three permanent attempts")
        }
        throw error
      }
      const taskVersion = task.version + 1
      this.db
        .query(
          "UPDATE watch_tasks SET attempts_used = ?, version = ?, updated_at = ? WHERE task_id = ? AND version = ?",
        )
        .run(ordinal, taskVersion, input.at, task.task_id, task.version)
      return {
        task: this.task(task.task_id),
        attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)),
        created: true,
      }
    })
  }

  claimCorrection(input: ClaimCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly claimed: boolean
    /** Only the successful claim receives the opaque dispatch correlation. */
    readonly correlation: string
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      if (task.mode !== "limited-correction" || task.watch_state !== "active" || task.task_state === "completed") {
        throw new LedgerFailure("not_active", "the task is not an active limited-correction task")
      }
      const row = this.correctionAttemptRow(reservationID)
      if (row === null || row.task_id !== taskID) throw new LedgerFailure("unknown_task", reservationID)
      if (row.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the reservation belongs to another activation")
      }
      if (row.reservation_generation !== input.generation || task.generation !== row.reservation_generation) {
        throw new LedgerFailure("stale_generation", "the reservation generation no longer matches the task")
      }
      if (row.reserved_task_version !== input.expectedVersion || task.version !== row.reserved_task_version) {
        throw new LedgerFailure("stale_version", "the task changed after this reservation was made")
      }
      const grant = this.correctionGrantRow(task.task_id)
      if (
        grant === null ||
        grant.state !== "granted" ||
        grant.grant_id !== row.grant_id ||
        grant.version !== row.grant_version ||
        grant.generation !== row.reservation_generation ||
        grant.scope_target_session_id !== row.scope_target_session_id ||
        task.target_session_id !== row.scope_target_session_id ||
        grant.terms_digest !== correctionTermsDigest(task, grant.deployment_statement)
      ) {
        throw new LedgerFailure("not_granted", "the reservation's original grant is no longer active")
      }
      const delegated = assertDelegatedCorrectionAuthority(this.delegationHost(), {
        taskID: task.task_id,
        targetSessionID: task.target_session_id,
        ownerActivation: owner,
        generation: task.generation,
        sourceGrantID: grant.source_delegation_grant_id,
        sourceGrantVersion: grant.source_delegation_grant_version,
      })
      if (!delegated.ok) {
        throw new LedgerFailure("not_granted", delegated.reason ?? "the delegated authority is no longer active")
      }
      if (row.state !== "reserved" || row.claimed_at !== null) {
        throw new LedgerFailure("claim_taken", "the one send slot for this reservation is already claimed")
      }
      if (!Number.isSafeInteger(input.at) || input.at < row.reserved_at) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      const changed = this.db
        .query(
          `UPDATE watch_correction_attempts SET
            state = 'sending', claimed_at = ?, claimed_by_activation = ?, claimed_generation = ?
           WHERE reservation_id = ? AND state = 'reserved' AND claimed_at IS NULL`,
        )
        .run(input.at, owner, task.generation, reservationID)
      if (changed.changes !== 1) {
        throw new LedgerFailure("claim_taken", "another process claimed this reservation")
      }
      return {
        attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)),
        claimed: true,
        correlation: row.correlation,
      }
    })
  }

  recordCorrectionOutcome(input: RecordCorrectionOutcomeInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly changed: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      if (input.outcome !== "accepted" && input.outcome !== "rejected" && input.outcome !== "unknown") {
        throw new LedgerFailure("invalid_input", "outcome must be accepted, rejected or unknown")
      }
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      const row = this.correctionAttemptRow(reservationID)
      if (row === null || row.task_id !== taskID) throw new LedgerFailure("unknown_task", reservationID)
      if (!Number.isSafeInteger(input.at) || input.at < (row.claimed_at ?? row.reserved_at)) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      if (row.state === "reserved") throw new LedgerFailure("not_claimable", "the attempt was not claimed")
      const phase = row.state as WatchCorrectionAttemptPhase
      if (phase === "aborted") {
        throw new LedgerFailure("invalid_transition", "an aborted reservation has no delivery outcome")
      }
      if ((phase === "accepted" || phase === "rejected") && input.outcome !== phase) {
        return { attempt: correctionAttemptFromRow(row), changed: false }
      }
      if (phase === "unknown" && input.outcome === "unknown") {
        return { attempt: correctionAttemptFromRow(row), changed: false }
      }
      const column =
        input.outcome === "accepted" ? "accepted_at" : input.outcome === "rejected" ? "rejected_at" : "unknown_at"
      const admission =
        input.outcome === "accepted" && input.admissionID !== undefined
          ? requiredIdentifier(input.admissionID, "admissionID")
          : null
      if (phase === "receipted" || phase === "recovered") {
        this.db
          .query(
            `UPDATE watch_correction_attempts SET
              ${column} = COALESCE(${column}, ?),
              admission_id = COALESCE(admission_id, ?)
             WHERE reservation_id = ?`,
          )
          .run(input.at, admission, reservationID)
        return { attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)), changed: true }
      }
      const nextPhase = input.outcome === "rejected" ? "rejected" : input.outcome
      this.db
        .query(`UPDATE watch_correction_attempts SET state = ?, ${column} = ?, admission_id = ? WHERE reservation_id = ?`)
        .run(nextPhase, input.at, admission, reservationID)
      return { attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)), changed: true }
    })
  }

  recordCorrectionReceipt(input: RecordCorrectionReceiptInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly continuePermit: boolean
    readonly duplicate: boolean
    readonly seen: boolean
    readonly refusalReason: string | null
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const correlation = requiredIdentifier(input.correlation, "correlation")
      const currentActivation = requiredIdentifier(input.currentActivationId, "currentActivationId")
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.target_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the target session may submit a correction receipt")
      }
      const row = this.correctionAttemptRow(reservationID)
      if (row === null || row.task_id !== taskID) throw new LedgerFailure("unknown_task", reservationID)
      if (!Number.isSafeInteger(input.at) || input.at < (row.claimed_at ?? row.reserved_at)) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      if (row.correlation !== correlation) {
        throw new LedgerFailure("receipt_conflict", "the correlation does not match this reservation")
      }
      if (row.receipt_id !== null) {
        if (row.receipt_id === correlation) {
          return {
            attempt: correctionAttemptFromRow(row),
            continuePermit: false,
            duplicate: true,
            seen: true,
            refusalReason: row.receipt_refusal_reason,
          }
        }
        throw new LedgerFailure("receipt_conflict", "a different receipt is already recorded for this attempt")
      }
      if (row.state === "reserved") throw new LedgerFailure("not_claimable", "the attempt was not claimed")
      if (row.state === "rejected") {
        throw new LedgerFailure("invalid_transition", "a rejected delivery cannot be receipted")
      }
      if (row.state === "aborted") {
        throw new LedgerFailure("invalid_transition", "an aborted attempt cannot be receipted")
      }
      if (row.state === "recovered") {
        throw new LedgerFailure("receipt_conflict", "the attempt already recovered")
      }
      if (row.claimed_generation === null) throw new LedgerFailure("not_claimable", "the attempt has no claimed generation")
      if (row.claimed_generation !== task.generation) {
        this.db
          .query(
            "UPDATE watch_correction_attempts SET last_seen_at = ?, last_seen_reason = 'stale-generation' WHERE reservation_id = ?",
          )
          .run(input.at, reservationID)
        return {
          attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)),
          continuePermit: false,
          duplicate: false,
          seen: true,
          refusalReason: "stale-generation",
        }
      }
      const grant = this.correctionGrantRow(task.task_id)
      const originalGrantOk =
        grant !== null &&
        grant.state === "granted" &&
        grant.grant_id === row.grant_id &&
        grant.version === row.grant_version &&
        grant.generation === row.reservation_generation &&
        grant.scope_target_session_id === row.scope_target_session_id &&
        grant.terms_digest === correctionTermsDigest(task, grant.deployment_statement) &&
        task.mode === "limited-correction" &&
        task.owner_activation === row.owner_activation &&
        task.owner_activation === currentActivation
      const delegated =
        grant === null
          ? { required: false, ok: true, reason: null }
          : assertDelegatedCorrectionAuthority(this.delegationHost(), {
              taskID: task.task_id,
              targetSessionID: task.target_session_id,
              ownerActivation: currentActivation,
              generation: task.generation,
              sourceGrantID: grant.source_delegation_grant_id,
              sourceGrantVersion: grant.source_delegation_grant_version,
            })
      const refusal =
        task.watch_state !== "active"
          ? `task-${task.watch_state}`
          : task.task_state === "completed"
            ? "task-completed"
            : originalGrantOk
              ? delegated.ok
                ? null
                : "delegation-changed"
              : "grant-changed"
      const permitAt = refusal === null ? input.at : null
      try {
        this.db
          .query(
            `UPDATE watch_correction_attempts SET
              state = 'receipted', receipt_id = ?, receipt_at = ?, receipt_caller_session_id = ?,
              receipt_generation = ?, receipt_permit_at = ?, receipt_refusal_reason = ?,
              last_seen_at = ?, last_seen_reason = ?
             WHERE reservation_id = ? AND receipt_id IS NULL`,
          )
          .run(
            correlation,
            input.at,
            caller,
            row.claimed_generation,
            permitAt,
            refusal,
            input.at,
            refusal ?? "receipt",
            reservationID,
          )
      } catch (error) {
        const text = String(error)
        if (text.includes("receipt_id")) {
          throw new LedgerFailure("receipt_conflict", "that correlation is already used")
        }
        throw error
      }
      return {
        attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)),
        continuePermit: permitAt !== null,
        duplicate: false,
        seen: true,
        refusalReason: refusal,
      }
    })
  }

  abortCorrection(input: AbortCorrectionInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly aborted: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.owner_activation !== owner) {
        throw new LedgerFailure("stale_owner", "the current activation does not own this task")
      }
      if (task.version !== input.expectedVersion) {
        throw new LedgerFailure("stale_version", `the task is at version ${task.version}`)
      }
      if (task.generation !== input.generation) {
        throw new LedgerFailure("stale_generation", `the task is at generation ${task.generation}`)
      }
      const row = this.correctionAttemptRow(reservationID)
      if (row === null || row.task_id !== taskID) throw new LedgerFailure("unknown_task", reservationID)
      if (row.state === "aborted") {
        return { attempt: correctionAttemptFromRow(row), aborted: false }
      }
      if (!Number.isSafeInteger(input.at) || input.at < row.reserved_at) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      if (row.state !== "reserved" || row.claimed_at !== null) {
        throw new LedgerFailure("not_claimable", "only an unclaimed reservation can be aborted")
      }
      this.db
        .query(
          "UPDATE watch_correction_attempts SET state = 'aborted', aborted_at = ?, stop_reason = 'attempt-aborted' WHERE reservation_id = ?",
        )
        .run(input.at, reservationID)
      return { attempt: correctionAttemptFromRow(this.correctionAttemptRow(reservationID)), aborted: true }
    })
  }

  recordCorrectionRecovery(input: RecordCorrectionRecoveryInput): LedgerResult<{
    readonly attempt: WatchCorrectionAttemptRecord
    readonly recovered: boolean
  }> {
    return this.immediate(() => {
      const taskID = requiredIdentifier(input.taskId, "taskId")
      const reservationID = requiredIdentifier(input.reservationId, "reservationId")
      const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
      const reportID = requiredIdentifier(input.progressReportId, "progressReportId")
      const reference = readBoundedText(input.resultReference, "resultReference", WATCH_LIMITS.reference)
      if (!reference.ok) throw new LedgerFailure("invalid_input", reference.reason)
      const task = this.taskRow(taskID)
      if (task === null) throw new LedgerFailure("unknown_task", taskID)
      this.checkLedger(task)
      if (task.target_session_id !== caller) {
        throw new LedgerFailure("caller_mismatch", "only the target session may confirm recovery")
      }
      if (task.generation !== input.generation) {
        throw new LedgerFailure("stale_generation", `the task is at generation ${task.generation}`)
      }
      const row = this.correctionAttemptRow(reservationID)
      if (row === null || row.task_id !== taskID) throw new LedgerFailure("unknown_task", reservationID)
      if (row.state === "recovered") {
        return { attempt: correctionAttemptFromRow(row), recovered: true }
      }
      if (row.closed_at !== null) {
        throw new LedgerFailure(
          "recovery_evidence_missing",
          "the correction round was already closed by a verified current-target report",
        )
      }
      if (row.state !== "receipted" || row.receipt_at === null) {
        throw new LedgerFailure("recovery_evidence_missing", "a valid receipt is required before recovery")
      }
      if (row.receipt_permit_at === null) {
        throw new LedgerFailure("recovery_evidence_missing", "the recorded receipt did not issue a continue permit")
      }
      const report = this.db
        .query("SELECT * FROM watch_reports WHERE task_id = ? AND report_id = ?")
        .get(taskID, reportID) as ReportRow | null
      if (report === null || report.kind !== "progress") {
        throw new LedgerFailure("recovery_evidence_missing", "the referenced progress report does not exist")
      }
      if (report.created_at <= row.receipt_at) {
        throw new LedgerFailure("recovery_evidence_missing", "the progress report predates the correction receipt")
      }
      if (!Number.isSafeInteger(input.at) || input.at < row.receipt_at || input.at < report.created_at) {
        throw new LedgerFailure("invalid_input", "at must be a non-negative, non-decreasing time")
      }
      const evidence = parseEvidence(report.evidence)
      if (evidence.reference !== reference.value) {
        throw new LedgerFailure("recovery_evidence_missing", "the progress report does not carry the new result reference")
      }
      const prior = this.db
        .query("SELECT * FROM watch_reports WHERE task_id = ? AND report_id <> ?")
        .all(taskID, reportID) as ReportRow[]
      for (const earlier of prior) {
        const earlierEvidence = parseEvidence(earlier.evidence)
        if (earlierEvidence.reference === reference.value) {
          throw new LedgerFailure(
            "recovery_evidence_missing",
            "the result reference was already used by an earlier report; recovery needs a new result",
          )
        }
      }
      this.db
        .query(
          `UPDATE watch_correction_attempts SET
            state = 'recovered', recovery_report_id = ?, recovery_reference = ?, recovered_at = ?,
            closed_at = ?, closed_reason = 'recovered'
           WHERE reservation_id = ? AND closed_at IS NULL`,
        )
        .run(reportID, reference.value, input.at, input.at, reservationID)
      const updated = this.correctionAttemptRow(reservationID)
      if (updated?.state === "recovered") {
        return { attempt: correctionAttemptFromRow(updated), recovered: true }
      }
      throw new LedgerFailure(
        "recovery_evidence_missing",
        "the correction round was closed concurrently; recovery was not applied",
      )
    })
  }

  correction(taskID: string): LedgerResult<WatchCorrectionSnapshot> {
    return this.read(() => {
      const id = requiredIdentifier(taskID, "taskID")
      const task = this.taskRow(id)
      if (task === null) throw new LedgerFailure("unknown_task", id)
      this.checkLedger(task)
      const grant = this.correctionGrantRow(id)
      const rows = this.db
        .query("SELECT * FROM watch_correction_attempts WHERE task_id = ? ORDER BY attempt_no")
        .all(id) as CorrectionAttemptRow[]
      const unresolved = this.db
        .query(
          `SELECT 1 AS yes FROM watch_correction_attempts a
           JOIN watch_tasks t ON t.task_id = a.task_id
           WHERE t.target_session_id = ? AND t.task_id <> ?
             AND (${openAttemptSql("a.")})
           LIMIT 1`,
        )
        .get(task.target_session_id, task.task_id) as { yes: number } | null
      return {
        grant: grant === null ? null : correctionGrantFromRow(grant),
        attempts: rows.map(correctionAttemptFromRow),
        sessionUnresolved: unresolved !== null,
      }
    })
  }

  prepareDelegationGrant(input: PrepareDelegationGrantInput): LedgerResult<DelegationChallenge> {
    return this.immediate(() => prepareDelegationGrant(this.delegationHost(), input))
  }

  confirmDelegationGrant(input: ConfirmDelegationGrantInput): LedgerResult<{
    readonly task: WatchTaskRecord
    readonly grant: DelegationGrantRecord
    readonly created: boolean
  }> {
    return this.immediate(() => confirmDelegationGrant(this.delegationHost(), input))
  }

  revokeDelegationGrant(input: RevokeDelegationGrantInput): LedgerResult<{
    readonly grant: DelegationGrantRecord
    readonly changed: boolean
    readonly childTaskIDs: readonly string[]
  }> {
    return this.immediate(() => revokeDelegationGrant(this.delegationHost(), input))
  }

  delegatedEnroll(input: DelegatedEnrollInput): LedgerResult<DelegatedEnrollResult> {
    return this.immediate(() => {
      const enrolled = delegatedEnroll(this.delegationHost(), input)
      if (enrolled.created && enrolled.deriveCorrection) {
        const task = this.taskRow(enrolled.task.taskID)
        if (task === null) throw new LedgerFailure("corrupt", "the delegated task disappeared before its correction grant")
        if (enrolled.grant.deployment === undefined) {
          throw new LedgerFailure("not_granted", "the delegation grant has no deployment declaration")
        }
        const digest = correctionTermsDigest(task, enrolled.grant.deployment)
        this.db
          .query(
            `INSERT INTO watch_correction_grants (
              task_id, grant_id, mode, state, version, generation,
              scope_target_session_id, review_summary, deployment_statement, terms_digest,
              confirmation_id, source_delegation_grant_id, source_delegation_grant_version,
              granted_at
            ) VALUES (?, ?, 'limited-correction', 'granted', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.task_id,
            randomUUID(),
            task.generation,
            task.target_session_id,
            WATCH_CORRECTION_TERMS,
            enrolled.grant.deployment,
            digest,
            enrolled.grant.confirmationID,
            enrolled.grant.grantID,
            enrolled.grant.version,
            this.now(),
          )
      }
      return enrolled
    })
  }

  delegationGrantFor(input: {
    readonly parentTaskID: string
    readonly targetSessionID: string
  }): LedgerResult<DelegationGrantRecord | null> {
    return this.read(() => delegationGrantFor(this.delegationHost(), input))
  }

  delegationGrantsFor(parentTaskID: string): LedgerResult<readonly DelegationGrantRecord[]> {
    return this.read(() => delegationGrantsFor(this.delegationHost(), parentTaskID))
  }

  delegatedTaskLink(taskID: string): LedgerResult<DelegatedTaskLink | null> {
    return this.read(() => delegatedTaskLink(this.delegationHost(), taskID))
  }

  delegatedAuthority(taskID: string): LedgerResult<DelegatedAuthoritySnapshot> {
    return this.read(() => delegatedAuthority(this.delegationHost(), taskID))
  }

  listDelegatedChildren(parentTaskID: string): LedgerResult<readonly DelegatedChildRecord[]> {
    return this.read(() => listDelegatedChildren(this.delegationHost(), parentTaskID))
  }

  private delegationHost(): DelegationLedgerHost {
    return {
      db: this.db,
      ledgerId: this.ledgerId,
      now: () => this.now(),
      taskRow: (taskID) => this.taskRow(taskID),
      task: (taskID) => this.task(taskID),
    }
  }

  private isDelegatedTask(taskID: string): boolean {
    return this.db.query("SELECT 1 AS yes FROM watch_delegated_tasks WHERE task_id = ?").get(taskID) !== null
  }

  private correctionGrantRow(taskID: string): CorrectionGrantRow | null {
    return this.db.query("SELECT * FROM watch_correction_grants WHERE task_id = ?").get(taskID) as CorrectionGrantRow | null
  }

  private correctionAttemptRow(reservationID: string): CorrectionAttemptRow | null {
    return this.db
      .query("SELECT * FROM watch_correction_attempts WHERE reservation_id = ?")
      .get(reservationID) as CorrectionAttemptRow | null
  }

  private reportedWaitAt(taskID: string, waitID: string): number | null {
    const row = this.db
      .query("SELECT wait_at FROM watch_reported_waits WHERE task_id = ? AND wait_id = ?")
      .get(taskID, waitID) as { wait_at: number } | null
    return row === null ? null : row.wait_at
  }

  private closeReceiptedForReport(
    taskID: string,
    kind: WatchReportKind,
    evidence: WatchEvidence,
    reportID: string,
    at: number,
    priorWaitAt: number | null,
  ): void {
    const open = this.db
      .query(
        `SELECT * FROM watch_correction_attempts
         WHERE task_id = ? AND state = 'receipted' AND receipt_permit_at IS NOT NULL AND closed_at IS NULL
         LIMIT 1`,
      )
      .get(taskID) as CorrectionAttemptRow | null
    if (open === null) return
    if (open.receipt_permit_at === null || at < open.receipt_permit_at) return
    const reference = evidence.reference
    if (reference === undefined) return
    const earlier = this.db
      .query("SELECT evidence FROM watch_reports WHERE task_id = ? AND report_id <> ?")
      .all(taskID, reportID) as Array<{ readonly evidence: string }>
    if (earlier.some((report) => parseEvidence(report.evidence).reference === reference)) return
    if (kind === "progress" || kind === "completed") {
      if (kind === "progress") {
        this.db
          .query(
            `UPDATE watch_correction_attempts SET
              state = 'recovered', recovery_report_id = ?, recovery_reference = ?, recovered_at = ?,
              closed_at = ?, closed_reason = 'recovered'
             WHERE reservation_id = ?`,
          )
          .run(reportID, reference, at, at, open.reservation_id)
        return
      }
      this.db
        .query(
          `UPDATE watch_correction_attempts SET closed_at = ?, closed_reason = 'task-completed' WHERE reservation_id = ?`,
        )
        .run(at, open.reservation_id)
      return
    }
    if (kind === "waiting") {
      if (priorWaitAt !== null) return
      const waitID = evidence.waitID ?? reportID
      const wait = this.db
        .query("SELECT wait_until FROM watch_reported_waits WHERE task_id = ? AND wait_id = ?")
        .get(taskID, waitID) as { wait_until: number | null } | null
      if (wait === null || (wait.wait_until !== null && wait.wait_until <= at)) return
      this.db
        .query(
          `UPDATE watch_correction_attempts SET closed_at = ?, closed_reason = 'normal-wait' WHERE reservation_id = ?`,
        )
        .run(at, open.reservation_id)
    }
  }

  private reportedWaits(taskID: string): WatchReportedWait[] {
    const rows = this.db
      .query(
        `SELECT * FROM watch_reported_waits WHERE task_id = ?
         ORDER BY cleared_at IS NULL DESC, wait_at DESC LIMIT 20`,
      )
      .all(taskID) as ReportedWaitRow[]
    return rows.map((row) => ({
      waitID: row.wait_id,
      waitKind: parseWaitKind(row.wait_kind),
      waitFor: row.wait_for,
      reason: row.wait_reason,
      reference: row.wait_reference,
      ...(row.wait_until === null ? {} : { waitUntil: row.wait_until }),
      at: row.wait_at,
      ...(row.cleared_at === null ? {} : { clearedAt: row.cleared_at }),
      ...(row.clear_evidence === null ? {} : { clearEvidence: row.clear_evidence }),
    }))
  }

  private recordReportedWrites(
    taskID: string,
    kind: WatchReportKind,
    evidence: WatchEvidence,
    reportID: string,
    at: number,
  ): void {
    if (kind === "waiting") {
      const waitID = evidence.waitID ?? reportID
      if (evidence.clearsWaitID !== undefined) {
        if (evidence.clearEvidence === undefined || evidence.clearEvidence.trim().length === 0) {
          throw new LedgerFailure("invalid_input", "clearsWaitID needs a non-empty clearEvidence")
        }
        const clearable = this.db
          .query(
            "SELECT wait_id FROM watch_reported_waits WHERE task_id = ? AND wait_id = ? AND cleared_at IS NULL",
          )
          .get(taskID, evidence.clearsWaitID) as { wait_id: string } | null
        if (clearable === null) {
          throw new LedgerFailure("unknown_wait", evidence.clearsWaitID)
        }
        this.db
          .query(
            "UPDATE watch_reported_waits SET cleared_at = ?, clear_evidence = ? WHERE task_id = ? AND wait_id = ? AND cleared_at IS NULL",
          )
          .run(at, evidence.clearEvidence, taskID, evidence.clearsWaitID)
      }
      const active = this.db
        .query("SELECT COUNT(*) AS n FROM watch_reported_waits WHERE task_id = ? AND cleared_at IS NULL")
        .get(taskID) as { n: number }
      const existing = this.db
        .query("SELECT cleared_at FROM watch_reported_waits WHERE task_id = ? AND wait_id = ?")
        .get(taskID, waitID) as { cleared_at: number | null } | null
      if (existing === null || existing.cleared_at !== null) {
        if (active.n >= 8) {
          throw new LedgerFailure("wait_limit", "too many active reported waits")
        }
      }
      this.db
        .query(
          `INSERT INTO watch_reported_waits (
            task_id, wait_id, wait_kind, wait_for, wait_reason, wait_reference,
            wait_until, wait_at, cleared_at, clear_evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(task_id, wait_id) DO UPDATE SET
            wait_kind = excluded.wait_kind,
            wait_for = excluded.wait_for,
            wait_reason = excluded.wait_reason,
            wait_reference = excluded.wait_reference,
            wait_until = excluded.wait_until,
            wait_at = excluded.wait_at,
            cleared_at = NULL,
            clear_evidence = NULL`,
        )
        .run(
          taskID,
          waitID,
          evidence.waitKind ?? "other",
          evidence.waitFor ?? "unspecified",
          evidence.reason ?? "the executing session declared a wait",
          evidence.reference ?? reportID,
          evidence.waitUntil ?? null,
          at,
        )
      if (evidence.clearsWaitID !== undefined) this.trimReportedWaits(taskID)
      return
    }
    if (kind === "completed") {
      this.db
        .query(
          "UPDATE watch_reported_waits SET cleared_at = ?, clear_evidence = 'task completed' WHERE task_id = ? AND cleared_at IS NULL",
        )
        .run(at, taskID)
      this.trimReportedWaits(taskID)
      return
    }
    if (evidence.clearsWaitID !== undefined) {
      if (evidence.clearEvidence === undefined || evidence.clearEvidence.trim().length === 0) {
        throw new LedgerFailure("invalid_input", "clearsWaitID needs a non-empty clearEvidence")
      }
      const existing = this.db
        .query(
          "SELECT wait_id FROM watch_reported_waits WHERE task_id = ? AND wait_id = ? AND cleared_at IS NULL",
        )
        .get(taskID, evidence.clearsWaitID) as { wait_id: string } | null
      if (existing === null) {
        throw new LedgerFailure("unknown_wait", evidence.clearsWaitID)
      }
      this.db
        .query(
          "UPDATE watch_reported_waits SET cleared_at = ?, clear_evidence = ? WHERE task_id = ? AND wait_id = ? AND cleared_at IS NULL",
        )
        .run(at, evidence.clearEvidence ?? "report cleared this wait", taskID, evidence.clearsWaitID)
      this.trimReportedWaits(taskID)
    }
  }

  private trimReportedWaits(taskID: string): void {
    this.db
      .query(
        `DELETE FROM watch_reported_waits
         WHERE task_id = ? AND cleared_at IS NOT NULL
           AND wait_id NOT IN (
             SELECT wait_id FROM watch_reported_waits
             WHERE task_id = ? AND cleared_at IS NOT NULL
             ORDER BY wait_at DESC LIMIT 12
           )`,
      )
      .run(taskID, taskID)
  }

  private alert(alertID: string): WatchAlertRecord {
    const row = this.db.query("SELECT * FROM watch_alerts WHERE alert_id = ?").get(alertID) as AlertRow | null
    if (row === null) throw new LedgerFailure("unknown_alert", alertID)
    return alertFromRow(row)
  }

  secureFiles(): void {
    const targets = [this.path, `${this.path}-wal`, `${this.path}-shm`, anchorPathFor(this.path)]
    for (const target of targets) {
      if (!existsSync(target)) continue
      try {
        chmodSync(target, 0o600)
      } catch (error) {
        // Returning success while a file may be readable by another OS user
        // would contradict the 0600 requirement. Fail closed instead.
        throw new LedgerFailure("readonly", `could not set 0600 on ${target}: ${String(error)}`)
      }
    }
  }

  private task(taskID: string): WatchTaskRecord {
    const row = this.taskRow(taskID)
    if (row === null) throw new LedgerFailure("unknown_task", taskID)
    this.checkLedger(row)
    return taskFromRow(row, this.reportedWaits(row.task_id))
  }

  private taskRow(taskID: string): TaskRow | null {
    return this.db.query("SELECT * FROM watch_tasks WHERE task_id = ?").get(taskID) as TaskRow | null
  }

  private checkLedger(row: TaskRow): void {
    if (row.ledger_id !== this.ledgerId) {
      throw new LedgerFailure("ledger_mismatch", "the task belongs to a different ledger")
    }
  }

  private immediate<T>(fn: () => T): LedgerResult<T> {
    let value: T
    try {
      value = this.db.transaction(fn).immediate() as T
    } catch (error) {
      return { ok: false, ...mapError(error) }
    }
    // The transaction has committed. A failure to chmod the files now means
    // the caller cannot know whether the state changed, so do not claim it did
    // not; report the uncertainty and let the caller re-read.
    try {
      this.secureFiles()
    } catch (error) {
      const mapped = mapError(error)
      return {
        ok: false,
        code: "state_unknown",
        detail: `${mapped.code}: ${mapped.detail}`,
      }
    }
    return { ok: true, value }
  }

  private read<T>(fn: () => T): LedgerResult<T> {
    try {
      return { ok: true, value: fn() }
    } catch (error) {
      return { ok: false, ...mapError(error) }
    }
  }
}

const LOCAL_FILESYSTEMS: Readonly<Record<number, string>> = {
  0xef53: "ext4",
  0x58465342: "xfs",
  0x9123683e: "btrfs",
  0x01021994: "tmpfs",
  0x2fc12fc1: "zfs",
  0x794c7630: "overlay",
}

function filesystemType(path: string): string {
  try {
    const stats = statfsSync(path) as unknown as { type?: number | bigint }
    if (stats.type === undefined) return "unknown"
    return LOCAL_FILESYSTEMS[Number(stats.type)] ?? "unknown"
  } catch {
    return "unknown"
  }
}

function taskFromRow(row: TaskRow, reportedWaits: readonly WatchReportedWait[] = []): WatchTaskRecord {
  const lastReport =
    row.last_report_id === null
      ? undefined
      : {
          reportID: row.last_report_id,
          kind: parseReportKind(row.last_report_kind),
          evidence: parseEvidence(row.last_report_evidence),
          at: row.last_report_at ?? row.updated_at,
          version: row.last_report_version ?? row.version,
        }
  return {
    taskID: row.task_id,
    initiatorSessionID: row.initiator_session_id,
    targetSessionID: row.target_session_id,
    goal: row.goal,
    mode: parseWatchMode(row.mode),
    watchState: parseWatchState(row.watch_state),
    taskState: parseTaskState(row.task_state),
    version: row.version,
    generation: row.generation,
    attemptsUsed: parseAttemptsUsed(row.attempts_used),
    reportedWaits,
    ownerActivation: row.owner_activation,
    ...(lastReport === undefined ? {} : { lastReport }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  }
}

function parseWaitKind(value: string): WatchReportedWait["waitKind"] {
  if (value === "human" || value === "peer" || value === "permission" || value === "form" || value === "child" || value === "other") {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown wait kind ${value}`)
}

function correctionGrantFromRow(row: CorrectionGrantRow | null): WatchCorrectionGrantRecord {
  if (row === null) throw new LedgerFailure("corrupt", "the correction grant disappeared")
  if (row.state !== "granted" && row.state !== "revoked") {
    throw new LedgerFailure("corrupt", `unknown correction grant state ${row.state}`)
  }
  return {
    grantID: row.grant_id,
    taskID: row.task_id,
    mode: "limited-correction",
    state: row.state,
    version: row.version,
    generation: row.generation,
    scopeTargetSessionID: row.scope_target_session_id,
    reviewSummary: row.review_summary,
    deployment: "single-host-same-location",
    termsDigest: row.terms_digest,
    confirmationID: row.confirmation_id,
    grantedAt: row.granted_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}

function correctionAttemptFromRow(row: CorrectionAttemptRow | null): WatchCorrectionAttemptRecord {
  if (row === null) throw new LedgerFailure("corrupt", "the correction attempt disappeared")
  return {
    reservationID: row.reservation_id,
    taskID: row.task_id,
    ordinal: row.attempt_no,
    phase: parseCorrectionPhase(row.state),
    reservedAt: row.reserved_at,
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    ...(row.claimed_by_activation === null ? {} : { claimedByActivation: row.claimed_by_activation }),
    ...(row.claimed_generation === null ? {} : { claimedGeneration: row.claimed_generation }),
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    ...(row.rejected_at === null ? {} : { rejectedAt: row.rejected_at }),
    ...(row.unknown_at === null ? {} : { unknownAt: row.unknown_at }),
    ...(row.aborted_at === null ? {} : { abortedAt: row.aborted_at }),
    ...(row.receipt_id === null ? {} : { receiptID: row.receipt_id }),
    ...(row.receipt_at === null ? {} : { receiptAt: row.receipt_at }),
    ...(row.receipt_caller_session_id === null ? {} : { receiptCallerSessionID: row.receipt_caller_session_id }),
    ...(row.receipt_generation === null ? {} : { receiptGeneration: row.receipt_generation }),
    ...(row.receipt_permit_at === null ? {} : { receiptPermitAt: row.receipt_permit_at }),
    ...(row.receipt_refusal_reason === null ? {} : { receiptRefusalReason: row.receipt_refusal_reason }),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.last_seen_reason === null ? {} : { lastSeenReason: row.last_seen_reason }),
    ...(row.admission_id === null ? {} : { admissionID: row.admission_id }),
    ...(row.recovery_report_id === null ? {} : { recoveryReportID: row.recovery_report_id }),
    ...(row.recovery_reference === null ? {} : { recoveryReference: row.recovery_reference }),
    ...(row.recovered_at === null ? {} : { recoveredAt: row.recovered_at }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    ...(row.closed_reason === null ? {} : { closedReason: row.closed_reason }),
    ...(row.stop_reason === null ? {} : { stopReason: parseCorrectionStopReason(row.stop_reason) }),
  }
}

function parseCorrectionPhase(value: string): WatchCorrectionAttemptPhase {
  if (
    value === "reserved" ||
    value === "sending" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "unknown" ||
    value === "receipted" ||
    value === "recovered" ||
    value === "aborted"
  ) {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown correction attempt state ${value}`)
}

function parseCorrectionStopReason(value: string): WatchCorrectionStopReason {
  const reasons: readonly WatchCorrectionStopReason[] = [
    "grant-missing",
    "grant-pending",
    "grant-expired",
    "attempt-limit",
    "session-unresolved",
    "reservation-pending",
    "sending-unaccounted",
    "accepted-without-receipt",
    "unknown-result",
    "first-attempt-policy",
    "receipted-awaiting-recovery",
    "attempt-aborted",
    "closing",
    "rejected",
    "recovered",
    "runtime-unsupported",
    "single-host-unconfirmed",
    "owner-mismatch",
    "cross-location",
    "protocol-unseen",
    "task-paused",
    "task-ended",
    "task-completed",
    "observation-untrusted",
    "normal-wait",
    "observation-gap",
    "executor-unavailable",
  ]
  if (!reasons.includes(value as WatchCorrectionStopReason)) {
    throw new LedgerFailure("corrupt", `unknown correction stop reason ${value}`)
  }
  return value as WatchCorrectionStopReason
}

function alertFromRow(row: AlertRow): WatchAlertRecord {
  const kind = readAlertKind(row.kind)
  if (!kind.ok) throw new LedgerFailure("corrupt", "stored alert kind is not supported")
  const state = parseAlertState(row.state)
  return {
    alertID: row.alert_id,
    taskID: row.task_id,
    dedupeKey: row.dedupe_key,
    kind: kind.value,
    state,
    summary: row.summary,
    reason: row.reason,
    firstAt: row.first_at,
    updatedAt: row.updated_at,
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
    ...(row.escalated_at === null ? {} : { escalatedAt: row.escalated_at }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  }
}

function parseAlertState(value: string): WatchAlertState {
  if (value === "unread" || value === "read") return value
  throw new LedgerFailure("corrupt", `unknown alert state ${value}`)
}

function parseAttemptsUsed(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > WATCH_CORRECTION_LIMIT
  ) {
    throw new LedgerFailure("corrupt", "stored attempts_used is not an integer in the allowed range")
  }
  return value
}

function parseWatchMode(value: string): WatchMode {
  if (value === "alert" || value === "limited-correction") return value
  throw new LedgerFailure("corrupt", `unknown watch mode ${value}`)
}

function parseWatchState(value: string): WatchState {
  if (value === "active" || value === "paused" || value === "ended") return value
  throw new LedgerFailure("corrupt", `unknown watch state ${value}`)
}

function parseTaskState(value: string): WatchedTaskState {
  if (value === "not-started" || value === "in-progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown task state ${value}`)
}

function parseReportKind(value: string | null): WatchReportKind {
  if (value === "begin" || value === "progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return value
  }
  throw new LedgerFailure("corrupt", `unknown report kind ${String(value)}`)
}

function parseEvidence(value: string | null): WatchEvidence {
  if (value === null) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("evidence is not an object")
    }
    return parsed as WatchEvidence
  } catch (error) {
    throw new LedgerFailure("corrupt", `stored evidence is unreadable: ${String(error)}`)
  }
}

function requiredIdentifier(value: string, field: string): string {
  const checked = readIdentifier(value, field)
  if (!checked.ok) throw new LedgerFailure("invalid_input", checked.reason)
  return checked.value
}

function requiredGoal(value: string): string {
  const checked = readGoal(value)
  if (!checked.ok) throw new LedgerFailure("invalid_input", checked.reason)
  return checked.value
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => Number.parseInt(part, 10))
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

function mapError(error: unknown): { readonly code: WatchLedgerErrorCode; readonly detail: string } {
  if (error instanceof LedgerFailure) return { code: error.code, detail: error.detail }
  if (error instanceof LedgerDelegationFailure) return { code: error.code, detail: error.detail }
  const code = (error as { code?: unknown } | null)?.code
  const text = error instanceof Error ? error.message : String(error)
  if (typeof code === "string") {
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { code: "lock_timeout", detail: text }
    if (code === "SQLITE_READONLY") return { code: "readonly", detail: text }
    if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT") return { code: "corrupt", detail: text }
    if (code.startsWith("SQLITE_CONSTRAINT")) return { code: "conflict", detail: text }
    if (code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN") return { code: "io_error", detail: text }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { code: "readonly", detail: text }
    if (code === "ENOENT") return { code: "io_error", detail: text }
  }
  return { code: "ledger_error", detail: text }
}
