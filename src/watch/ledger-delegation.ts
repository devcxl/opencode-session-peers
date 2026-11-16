/**
 * Ledger support for direct-child delegation.
 *
 * The functions here run inside the main ledger's existing SQLite transaction;
 * they never open a second database, a second authority or a storage fallback.
 * Host facts (parentID, directory, scope) are verified by the application and
 * stored here for audit; this module only enforces the durable binding between
 * a controlled delegation grant, one child task and the derived correction
 * grant. A missing or stale source grant is closed, never inferred.
 */

import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

import {
  canonicalJson,
  readGoal,
  readIdentifier,
  type WatchMode,
  type WatchTaskRecord,
} from "../domain/watch.ts"
import type { LedgerResult, WatchLedgerErrorCode } from "./ledger.ts"
import {
  delegationTermsDigest,
  readDelegationMode,
  readDelegationScope,
  type DelegatedAuthoritySnapshot,
  type DelegatedChildRecord,
  type DelegatedTaskLink,
  type DelegationChallenge,
  type DelegationGrantRecord,
  WATCH_DELEGATION_TERMS,
} from "./delegation.ts"

export class LedgerDelegationFailure extends Error {
  constructor(
    readonly code: WatchLedgerErrorCode,
    readonly detail: string,
  ) {
    super(detail)
    this.name = "LedgerDelegationFailure"
  }
}

export interface DelegationTaskRow {
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
  readonly created_at: number
  readonly updated_at: number
  readonly completed_at: number | null
  readonly ended_at: number | null
}

/** The main ledger's private surface, passed in so this module stays one transaction. */
export interface DelegationLedgerHost {
  readonly db: Database
  readonly ledgerId: string
  now(): number
  taskRow(taskID: string): DelegationTaskRow | null
  task(taskID: string): WatchTaskRecord
}

interface DelegationGrantRow {
  readonly grant_id: string
  readonly parent_task_id: string
  readonly parent_session_id: string
  readonly parent_task_version: number
  readonly owner_activation: string
  readonly mode: string
  readonly state: string
  readonly version: number
  readonly generation: number
  readonly scope_target_session_id: string
  readonly scope_directory: string
  readonly scope_peer_scope: string
  readonly deployment_statement: string | null
  readonly review_summary: string
  readonly terms_digest: string
  readonly confirmation_id: string
  readonly granted_at: number
  readonly revoked_at: number | null
}

interface DelegationChallengeRow {
  readonly challenge: string
  readonly parent_task_id: string
  readonly expected_version: number
  readonly generation: number
  readonly caller_session_id: string
  readonly owner_activation: string
  readonly mode: string
  readonly target_session_id: string
  readonly scope_directory: string
  readonly scope_peer_scope: string
  readonly deployment_statement: string | null
  readonly terms_digest: string
  readonly review_summary: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

interface DelegatedTaskRow {
  readonly task_id: string
  readonly grant_id: string
  readonly grant_version: number
  readonly parent_task_id: string
  readonly parent_session_id: string
  readonly target_session_id: string
  readonly verified_parent_id: string
  readonly verified_directory: string
  readonly verified_scope: string
  readonly verified_scope_source: string
  readonly verified_at: number
}

export interface PrepareDelegationGrantInput {
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly targetSessionId: string
  readonly mode: WatchMode
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly deployment?: "single-host-same-location"
  readonly at: number
  readonly ttlMs?: number
}

export interface ConfirmDelegationGrantInput {
  readonly challenge: string
  readonly taskId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly generation: number
  readonly targetSessionId: string
  readonly mode: WatchMode
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly termsDigest: string
  readonly deployment?: "single-host-same-location"
  readonly at: number
}

export interface RevokeDelegationGrantInput {
  readonly parentTaskId: string
  readonly targetSessionId: string
  readonly callerSessionId: string
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly at: number
}

export interface DelegatedEnrollInput {
  readonly requestId: string
  readonly initiatorSessionId: string
  readonly targetSessionId: string
  readonly parentTaskId: string
  readonly goal: string
  readonly mode: WatchMode
  readonly ownerActivation: string
  readonly expectedVersion: number
  readonly grantId: string
  readonly grantVersion: number
  readonly verifiedParentId: string
  readonly verifiedDirectory: string
  readonly verifiedScope: string
  readonly verifiedScopeSource: "recorded" | "configured"
}

export interface DelegatedEnrollResult {
  readonly task: WatchTaskRecord
  readonly created: boolean
  readonly grant: DelegationGrantRecord
  readonly link: DelegatedTaskLink
  /** The caller derives the child correction grant in the same transaction. */
  readonly deriveCorrection: boolean
}

export const DELEGATION_DDL = `
CREATE TABLE IF NOT EXISTS watch_delegation_grants (
  grant_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  parent_session_id TEXT NOT NULL,
  parent_task_version INTEGER NOT NULL CHECK (parent_task_version >= 1),
  owner_activation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('alert','limited-correction')),
  state TEXT NOT NULL CHECK (state IN ('granted','revoked')),
  version INTEGER NOT NULL CHECK (version >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  scope_target_session_id TEXT NOT NULL,
  scope_directory TEXT NOT NULL,
  scope_peer_scope TEXT NOT NULL,
  deployment_statement TEXT CHECK (deployment_statement IS NULL OR deployment_statement = 'single-host-same-location'),
  review_summary TEXT NOT NULL,
  terms_digest TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((mode = 'limited-correction' AND deployment_statement IS NOT NULL) OR (mode = 'alert' AND deployment_statement IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_delegation_grant_per_child
  ON watch_delegation_grants(parent_task_id, scope_target_session_id) WHERE state = 'granted';

CREATE INDEX IF NOT EXISTS delegation_grants_by_parent
  ON watch_delegation_grants(parent_task_id, scope_target_session_id, granted_at);

CREATE TABLE IF NOT EXISTS watch_delegation_challenges (
  challenge TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  expected_version INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  caller_session_id TEXT NOT NULL,
  owner_activation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('alert','limited-correction')),
  target_session_id TEXT NOT NULL,
  scope_directory TEXT NOT NULL,
  scope_peer_scope TEXT NOT NULL,
  deployment_statement TEXT CHECK (deployment_statement IS NULL OR deployment_statement = 'single-host-same-location'),
  terms_digest TEXT NOT NULL,
  review_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK ((mode = 'limited-correction' AND deployment_statement IS NOT NULL) OR (mode = 'alert' AND deployment_statement IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_delegation_challenge
  ON watch_delegation_challenges(parent_task_id, target_session_id) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS watch_delegated_tasks (
  task_id TEXT PRIMARY KEY REFERENCES watch_tasks(task_id),
  grant_id TEXT NOT NULL REFERENCES watch_delegation_grants(grant_id),
  grant_version INTEGER NOT NULL CHECK (grant_version >= 1),
  parent_task_id TEXT NOT NULL REFERENCES watch_tasks(task_id),
  parent_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  verified_parent_id TEXT NOT NULL,
  verified_directory TEXT NOT NULL,
  verified_scope TEXT NOT NULL,
  verified_scope_source TEXT NOT NULL CHECK (verified_scope_source IN ('recorded','configured')),
  verified_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS delegated_tasks_by_parent
  ON watch_delegated_tasks(parent_task_id, target_session_id, verified_at);
`

export const DELEGATION_REQUIRED_TABLES = [
  "watch_delegation_grants",
  "watch_delegation_challenges",
  "watch_delegated_tasks",
] as const

export const REQUIRED_DELEGATION_GRANT_COLUMNS = [
  "grant_id",
  "parent_task_id",
  "parent_session_id",
  "parent_task_version",
  "owner_activation",
  "mode",
  "state",
  "version",
  "generation",
  "scope_target_session_id",
  "scope_directory",
  "scope_peer_scope",
  "deployment_statement",
  "review_summary",
  "terms_digest",
  "confirmation_id",
  "granted_at",
  "revoked_at",
] as const

export const REQUIRED_DELEGATION_CHALLENGE_COLUMNS = [
  "challenge",
  "parent_task_id",
  "expected_version",
  "generation",
  "caller_session_id",
  "owner_activation",
  "mode",
  "target_session_id",
  "scope_directory",
  "scope_peer_scope",
  "deployment_statement",
  "terms_digest",
  "review_summary",
  "created_at",
  "expires_at",
  "consumed_at",
] as const

export const REQUIRED_DELEGATED_TASK_COLUMNS = [
  "task_id",
  "grant_id",
  "grant_version",
  "parent_task_id",
  "parent_session_id",
  "target_session_id",
  "verified_parent_id",
  "verified_directory",
  "verified_scope",
  "verified_scope_source",
  "verified_at",
] as const

export function prepareDelegationGrant(
  host: DelegationLedgerHost,
  input: PrepareDelegationGrantInput,
): DelegationChallenge {
  const taskID = requiredIdentifier(input.taskId, "taskId")
  const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
  const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
  const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
  const scopeDirectory = requiredScope(input.scopeDirectory, "scopeDirectory")
  const scopePeerScope = requiredScope(input.scopePeerScope, "scopePeerScope")
  const mode = readDelegationMode(input.mode)
  if (!mode.ok) throw new LedgerDelegationFailure("invalid_input", mode.reason)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LedgerDelegationFailure("invalid_input", "expectedVersion must be a positive integer")
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new LedgerDelegationFailure("invalid_input", "at must be a non-negative integer")
  }
  if (input.deployment !== undefined && input.deployment !== "single-host-same-location") {
    throw new LedgerDelegationFailure("invalid_input", "deployment must be single-host-same-location")
  }
  if (mode.value === "limited-correction" && input.deployment !== "single-host-same-location") {
    throw new LedgerDelegationFailure("invalid_input", "limited-correction needs the explicit single-host-same-location declaration")
  }
  if (mode.value === "alert" && input.deployment !== undefined) {
    throw new LedgerDelegationFailure("invalid_input", "an alert-only delegation has no deployment declaration")
  }

  const task = host.taskRow(taskID)
  if (task === null) throw new LedgerDelegationFailure("unknown_task", taskID)
  checkLedger(host, task)
  if (task.initiator_session_id !== caller) {
    throw new LedgerDelegationFailure("caller_mismatch", "only the parent task's initiator may prepare a delegation grant")
  }
  if (task.owner_activation !== owner) {
    throw new LedgerDelegationFailure("stale_owner", "the current activation does not own the parent task")
  }
  if (task.version !== input.expectedVersion) {
    throw new LedgerDelegationFailure("stale_version", `the parent task is at version ${task.version}`)
  }
  if (task.watch_state !== "active" || task.task_state === "completed") {
    throw new LedgerDelegationFailure("invalid_transition", "only an active, unfinished parent task may delegate")
  }
  if (task.initiator_session_id !== task.target_session_id) {
    throw new LedgerDelegationFailure("invalid_transition", "only a self-enrolled parent task may delegate; no recursion")
  }
  if (target === task.target_session_id) {
    throw new LedgerDelegationFailure("invalid_input", "a parent cannot delegate to itself")
  }

  const existing = activeGrantFor(host.db, taskID, target)
  if (existing !== null) {
    throw new LedgerDelegationFailure("grant_active", "an active delegation grant already exists for that child")
  }
  host.db
    .query(
      "UPDATE watch_delegation_challenges SET consumed_at = ? WHERE parent_task_id = ? AND target_session_id = ? AND consumed_at IS NULL",
    )
    .run(input.at, taskID, target)
  const challenge = randomUUID()
  const ttl = Math.min(Math.max(Math.trunc(input.ttlMs ?? 120_000), 30_000), 300_000)
  const expiresAt = input.at + ttl
  const termsDigest = delegationTermsDigest({
    parentTaskID: task.task_id,
    parentSessionID: task.target_session_id,
    targetSessionID: target,
    mode: mode.value,
    directory: scopeDirectory,
    peerScope: scopePeerScope,
    ownerActivation: task.owner_activation,
    generation: task.generation,
    version: task.version,
  })
  host.db
    .query(
      `INSERT INTO watch_delegation_challenges (
        challenge, parent_task_id, expected_version, generation, caller_session_id, owner_activation,
        mode, target_session_id, scope_directory, scope_peer_scope, deployment_statement,
        terms_digest, review_summary, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      challenge,
      task.task_id,
      task.version,
      task.generation,
      caller,
      task.owner_activation,
      mode.value,
      target,
      scopeDirectory,
      scopePeerScope,
      input.deployment ?? null,
      termsDigest,
      WATCH_DELEGATION_TERMS,
      input.at,
      expiresAt,
    )
  return {
    challenge,
    parentTaskID: task.task_id,
    expectedVersion: task.version,
    generation: task.generation,
    mode: mode.value,
    targetSessionID: target,
    scopeDirectory,
    scopePeerScope,
    ...(input.deployment === undefined ? {} : { deployment: input.deployment }),
    termsDigest,
    reviewSummary: WATCH_DELEGATION_TERMS,
    expiresAt,
  }
}

export function confirmDelegationGrant(
  host: DelegationLedgerHost,
  input: ConfirmDelegationGrantInput,
): { readonly task: WatchTaskRecord; readonly grant: DelegationGrantRecord; readonly created: boolean } {
  const taskID = requiredIdentifier(input.taskId, "taskId")
  const challenge = requiredIdentifier(input.challenge, "challenge")
  const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
  const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
  const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
  const scopeDirectory = requiredScope(input.scopeDirectory, "scopeDirectory")
  const scopePeerScope = requiredScope(input.scopePeerScope, "scopePeerScope")
  const termsDigest = requiredIdentifier(input.termsDigest, "termsDigest")
  const mode = readDelegationMode(input.mode)
  if (!mode.ok) throw new LedgerDelegationFailure("invalid_input", mode.reason)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LedgerDelegationFailure("invalid_input", "expectedVersion must be a positive integer")
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new LedgerDelegationFailure("invalid_input", "generation must be a positive integer")
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new LedgerDelegationFailure("invalid_input", "at must be a non-negative integer")
  }
  if (input.deployment !== undefined && input.deployment !== "single-host-same-location") {
    throw new LedgerDelegationFailure("invalid_input", "deployment must be single-host-same-location")
  }
  const task = host.taskRow(taskID)
  if (task === null) throw new LedgerDelegationFailure("unknown_task", taskID)
  checkLedger(host, task)
  if (task.initiator_session_id !== caller) {
    throw new LedgerDelegationFailure("caller_mismatch", "only the parent task's initiator may confirm a delegation grant")
  }
  if (task.owner_activation !== owner) {
    throw new LedgerDelegationFailure("stale_owner", "the current activation does not own the parent task")
  }
  if (task.version !== input.expectedVersion || task.generation !== input.generation) {
    throw new LedgerDelegationFailure("stale_version", "the parent task version or generation changed")
  }
  if (task.watch_state !== "active" || task.task_state === "completed") {
    throw new LedgerDelegationFailure("invalid_transition", "only an active, unfinished parent task may confirm delegation")
  }
  if (task.initiator_session_id !== task.target_session_id) {
    throw new LedgerDelegationFailure("invalid_transition", "only a self-enrolled parent task may delegate; no recursion")
  }
  if (activeGrantFor(host.db, taskID, target) !== null) {
    throw new LedgerDelegationFailure("grant_active", "an active delegation grant already exists for that child")
  }
  const row = host.db
    .query("SELECT * FROM watch_delegation_challenges WHERE challenge = ?")
    .get(challenge) as DelegationChallengeRow | null
  if (row === null || row.consumed_at !== null) {
    throw new LedgerDelegationFailure("grant_expired", "the delegation challenge is unknown or already consumed")
  }
  if (row.expires_at <= input.at) {
    host.db
      .query("UPDATE watch_delegation_challenges SET consumed_at = ? WHERE challenge = ?")
      .run(input.at, challenge)
    throw new LedgerDelegationFailure("grant_expired", "the delegation challenge has expired")
  }
  const currentDigest = delegationTermsDigest({
    parentTaskID: task.task_id,
    parentSessionID: task.target_session_id,
    targetSessionID: target,
    mode: mode.value,
    directory: scopeDirectory,
    peerScope: scopePeerScope,
    ownerActivation: task.owner_activation,
    generation: task.generation,
    version: task.version,
  })
  const rowDeployment = row.deployment_statement
  if (
    termsDigest !== currentDigest ||
    row.terms_digest !== currentDigest ||
    row.parent_task_id !== task.task_id ||
    row.expected_version !== input.expectedVersion ||
    row.generation !== input.generation ||
    row.caller_session_id !== caller ||
    row.owner_activation !== owner ||
    row.mode !== mode.value ||
    row.target_session_id !== target ||
    row.scope_directory !== scopeDirectory ||
    row.scope_peer_scope !== scopePeerScope ||
    row.review_summary !== WATCH_DELEGATION_TERMS ||
    rowDeployment !== (input.deployment ?? null)
  ) {
    throw new LedgerDelegationFailure("grant_expired", "the delegation challenge does not match this task, target, mode, scope or terms")
  }
  if (mode.value === "limited-correction" && rowDeployment !== "single-host-same-location") {
    throw new LedgerDelegationFailure("grant_expired", "the limited delegation challenge has no deployment declaration")
  }
  if (mode.value === "alert" && rowDeployment !== null) {
    throw new LedgerDelegationFailure("grant_expired", "the alert delegation challenge carries an unexpected deployment declaration")
  }
  host.db
    .query("UPDATE watch_delegation_challenges SET consumed_at = ? WHERE challenge = ? AND consumed_at IS NULL")
    .run(input.at, challenge)
  const grantID = randomUUID()
  host.db
    .query(
      `INSERT INTO watch_delegation_grants (
        grant_id, parent_task_id, parent_session_id, parent_task_version, owner_activation,
        mode, state, version, generation,
        scope_target_session_id, scope_directory, scope_peer_scope, deployment_statement,
        review_summary, terms_digest, confirmation_id, granted_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'granted', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantID,
      task.task_id,
      task.target_session_id,
      task.version,
      task.owner_activation,
      mode.value,
      task.generation,
      target,
      scopeDirectory,
      scopePeerScope,
      rowDeployment,
      WATCH_DELEGATION_TERMS,
      currentDigest,
      challenge,
      input.at,
    )
  return { task: host.task(task.task_id), grant: grantRow(host, grantID), created: true }
}

export function revokeDelegationGrant(
  host: DelegationLedgerHost,
  input: RevokeDelegationGrantInput,
): { readonly grant: DelegationGrantRecord; readonly changed: boolean; readonly childTaskIDs: readonly string[] } {
  const parentTaskID = requiredIdentifier(input.parentTaskId, "parentTaskId")
  const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
  const caller = requiredIdentifier(input.callerSessionId, "callerSessionId")
  const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LedgerDelegationFailure("invalid_input", "expectedVersion must be a positive integer")
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new LedgerDelegationFailure("invalid_input", "at must be a non-negative integer")
  }
  const task = host.taskRow(parentTaskID)
  if (task === null) throw new LedgerDelegationFailure("unknown_task", parentTaskID)
  checkLedger(host, task)
  if (task.initiator_session_id !== caller) {
    throw new LedgerDelegationFailure("caller_mismatch", "only the parent task's initiator may revoke a delegation grant")
  }
  if (task.owner_activation !== owner) {
    throw new LedgerDelegationFailure("stale_owner", "the current activation does not own the parent task")
  }
  if (task.version !== input.expectedVersion) {
    throw new LedgerDelegationFailure("stale_version", `the parent task is at version ${task.version}`)
  }
  const active = activeGrantFor(host.db, parentTaskID, target)
  if (active === null) {
    const latest = host.db
      .query(
        "SELECT * FROM watch_delegation_grants WHERE parent_task_id = ? AND scope_target_session_id = ? ORDER BY granted_at DESC, grant_id LIMIT 1",
      )
      .get(parentTaskID, target) as DelegationGrantRow | null
    if (latest === null) throw new LedgerDelegationFailure("not_granted", "no delegation grant matches that child")
    if (latest.state === "revoked") {
      return { grant: grantFromRow(latest), changed: false, childTaskIDs: childTasksForGrant(host.db, latest.grant_id) }
    }
    throw new LedgerDelegationFailure("not_granted", "no active delegation grant matches that child")
  }
  const nextVersion = active.version + 1
  host.db
    .query("UPDATE watch_delegation_grants SET state = 'revoked', version = ?, revoked_at = ? WHERE grant_id = ? AND state = 'granted'")
    .run(nextVersion, input.at, active.grant_id)
  host.db
    .query(
      `UPDATE watch_correction_grants SET state = 'revoked', version = version + 1, revoked_at = ?
       WHERE source_delegation_grant_id = ? AND source_delegation_grant_version = ? AND state = 'granted'`,
    )
    .run(input.at, active.grant_id, active.version)
  return {
    grant: grantRow(host, active.grant_id),
    changed: true,
    childTaskIDs: childTasksForGrant(host.db, active.grant_id),
  }
}

export function delegatedEnroll(host: DelegationLedgerHost, input: DelegatedEnrollInput): DelegatedEnrollResult {
  const requestID = requiredIdentifier(input.requestId, "requestId")
  const initiator = requiredIdentifier(input.initiatorSessionId, "initiatorSessionId")
  const target = requiredIdentifier(input.targetSessionId, "targetSessionId")
  const parentTaskID = requiredIdentifier(input.parentTaskId, "parentTaskId")
  const owner = requiredIdentifier(input.ownerActivation, "ownerActivation")
  const goal = requiredGoal(input.goal)
  const mode = readDelegationMode(input.mode)
  if (!mode.ok) throw new LedgerDelegationFailure("invalid_input", mode.reason)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LedgerDelegationFailure("invalid_input", "expectedVersion must be a positive integer")
  }
  const grantID = requiredIdentifier(input.grantId, "grantId")
  if (!Number.isSafeInteger(input.grantVersion) || input.grantVersion < 1) {
    throw new LedgerDelegationFailure("invalid_input", "grantVersion must be a positive integer")
  }
  const verifiedParentID = requiredIdentifier(input.verifiedParentId, "verifiedParentId")
  const verifiedDirectory = requiredScope(input.verifiedDirectory, "verifiedDirectory")
  const verifiedScope = requiredScope(input.verifiedScope, "verifiedScope")
  if (input.verifiedScopeSource !== "recorded" && input.verifiedScopeSource !== "configured") {
    throw new LedgerDelegationFailure("invalid_input", "verifiedScopeSource must be recorded or configured")
  }

  const parent = host.taskRow(parentTaskID)
  if (parent === null) throw new LedgerDelegationFailure("unknown_task", parentTaskID)
  checkLedger(host, parent)
  if (parent.initiator_session_id !== initiator) {
    throw new LedgerDelegationFailure("caller_mismatch", "only the parent task's initiator may enroll its child")
  }
  if (parent.initiator_session_id !== parent.target_session_id) {
    throw new LedgerDelegationFailure("invalid_transition", "a delegated task cannot delegate again; no recursion")
  }
  if (parent.owner_activation !== owner) {
    throw new LedgerDelegationFailure("stale_owner", "the current activation does not own the parent task")
  }
  if (parent.version !== input.expectedVersion) {
    throw new LedgerDelegationFailure("stale_version", `the parent task is at version ${parent.version}`)
  }
  if (parent.watch_state !== "active" || parent.task_state === "completed") {
    throw new LedgerDelegationFailure("not_active", "the parent task is not active and unfinished")
  }
  const grant = host.db.query("SELECT * FROM watch_delegation_grants WHERE grant_id = ?").get(grantID) as DelegationGrantRow | null
  if (grant === null) throw new LedgerDelegationFailure("not_granted", "the delegation grant does not exist")
  if (grant.state !== "granted") throw new LedgerDelegationFailure("not_granted", "the delegation grant is revoked")
  if (grant.version !== input.grantVersion) {
    throw new LedgerDelegationFailure("stale_generation", "the delegation grant version changed")
  }
  if (
    grant.parent_task_id !== parent.task_id ||
    grant.parent_session_id !== parent.target_session_id ||
    grant.generation !== parent.generation ||
    grant.scope_target_session_id !== target ||
    grant.parent_task_version > parent.version
  ) {
    throw new LedgerDelegationFailure("not_granted", "the delegation grant does not cover this parent task and child")
  }
  if (rank(mode.value) > rank(grant.mode as WatchMode)) {
    throw new LedgerDelegationFailure("not_granted", "the requested mode is wider than the delegation grant")
  }
  if (verifiedParentID !== parent.target_session_id) {
    throw new LedgerDelegationFailure("caller_mismatch", "the host parent fact does not match the parent task target")
  }
  if (verifiedDirectory !== grant.scope_directory || verifiedScope !== grant.scope_peer_scope) {
    throw new LedgerDelegationFailure("not_granted", "the verified location or scope differs from the delegation grant")
  }
  if (mode.value === "limited-correction" && grant.deployment_statement !== "single-host-same-location") {
    throw new LedgerDelegationFailure("not_granted", "a limited child needs the delegation's deployment declaration")
  }
  if (parent.owner_activation !== grant.owner_activation) {
    throw new LedgerDelegationFailure("not_granted", "the delegation grant belongs to another activation")
  }
  const currentDigest = delegationTermsDigest({
    parentTaskID: parent.task_id,
    parentSessionID: parent.target_session_id,
    targetSessionID: target,
    mode: grant.mode as WatchMode,
    directory: grant.scope_directory,
    peerScope: grant.scope_peer_scope,
    ownerActivation: grant.owner_activation,
    generation: grant.generation,
    version: grant.parent_task_version,
  })
  if (grant.terms_digest !== currentDigest) {
    throw new LedgerDelegationFailure("not_granted", "the delegation terms changed; the old grant cannot enroll a child")
  }

  const fingerprint = canonicalJson([
    parent.task_id,
    target,
    goal,
    mode.value,
    grant.grant_id,
    grant.version,
    verifiedParentID,
    verifiedDirectory,
    verifiedScope,
    input.verifiedScopeSource,
  ])
  const existingRequest = host.db
    .query("SELECT * FROM enrollment_requests WHERE initiator_session_id = ? AND request_id = ?")
    .get(initiator, requestID) as
    | { task_id: string; session_id: string; params_fingerprint: string }
    | null
  if (existingRequest !== null) {
    if (existingRequest.params_fingerprint !== fingerprint || existingRequest.session_id !== target) {
      throw new LedgerDelegationFailure("request_conflict", "that request id was used with different delegation parameters")
    }
    const link = linkRow(host.db, existingRequest.task_id)
    if (link === null) throw new LedgerDelegationFailure("corrupt", "the delegation request has no child link")
    return {
      task: host.task(existingRequest.task_id),
      created: false,
      grant: grantFromRow(grant),
      link: linkFromRow(link),
      deriveCorrection: host.task(existingRequest.task_id).mode === "limited-correction",
    }
  }

  const live = host.db
    .query("SELECT task_id FROM watch_tasks WHERE target_session_id = ? AND watch_state IN ('active','paused') LIMIT 1")
    .get(target) as { task_id: string } | null
  if (live !== null) {
    throw new LedgerDelegationFailure("session_conflict", `the child already has a live watched task: ${live.task_id}`)
  }

  const taskID = randomUUID()
  const at = host.now()
  host.db
    .query(
      `INSERT INTO watch_tasks (
        task_id, ledger_id, schema_version, protocol_version,
        initiator_session_id, target_session_id, goal, mode,
        watch_state, task_state, version, generation, owner_activation,
        created_at, updated_at
      ) VALUES (?, ?, 10, 1, ?, ?, ?, ?, 'active', 'not-started', 1, 1, ?, ?, ?)`,
    )
    .run(taskID, host.ledgerId, initiator, target, goal, mode.value, owner, at, at)
  host.db
    .query(
      `INSERT INTO watch_delegated_tasks (
        task_id, grant_id, grant_version, parent_task_id, parent_session_id, target_session_id,
        verified_parent_id, verified_directory, verified_scope, verified_scope_source, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskID,
      grant.grant_id,
      grant.version,
      parent.task_id,
      parent.target_session_id,
      target,
      verifiedParentID,
      verifiedDirectory,
      verifiedScope,
      input.verifiedScopeSource,
      at,
    )
  host.db
    .query(
      `INSERT INTO enrollment_requests (
        initiator_session_id, request_id, task_id, session_id, params_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(initiator, requestID, taskID, target, fingerprint, at)
  const insertedLink = linkRow(host.db, taskID)
  if (insertedLink === null) throw new LedgerDelegationFailure("corrupt", "the delegated task link was not written")
  return {
    task: host.task(taskID),
    created: true,
    grant: grantFromRow(grant),
    link: linkFromRow(insertedLink),
    deriveCorrection: mode.value === "limited-correction",
  }
}

export function delegationGrantFor(
  host: DelegationLedgerHost,
  input: { readonly parentTaskID: string; readonly targetSessionID: string },
): DelegationGrantRecord | null {
  const parentTaskID = requiredIdentifier(input.parentTaskID, "parentTaskID")
  const target = requiredIdentifier(input.targetSessionID, "targetSessionID")
  const row = host.db
    .query(
      "SELECT * FROM watch_delegation_grants WHERE parent_task_id = ? AND scope_target_session_id = ? ORDER BY granted_at DESC, grant_id LIMIT 1",
    )
    .get(parentTaskID, target) as DelegationGrantRow | null
  return row === null ? null : grantFromRow(row)
}

export function delegationGrantsFor(
  host: DelegationLedgerHost,
  parentTaskID: string,
): readonly DelegationGrantRecord[] {
  const id = requiredIdentifier(parentTaskID, "parentTaskID")
  const rows = host.db
    .query("SELECT * FROM watch_delegation_grants WHERE parent_task_id = ? ORDER BY granted_at DESC, grant_id")
    .all(id) as DelegationGrantRow[]
  return rows.map(grantFromRow)
}

export function delegatedTaskLink(host: DelegationLedgerHost, taskID: string): DelegatedTaskLink | null {
  const id = requiredIdentifier(taskID, "taskID")
  const row = linkRow(host.db, id)
  return row === null ? null : linkFromRow(row)
}

export function delegatedAuthority(host: DelegationLedgerHost, taskID: string): DelegatedAuthoritySnapshot {
  const id = requiredIdentifier(taskID, "taskID")
  const task = host.task(id)
  const link = linkRow(host.db, id)
  if (link === null) return { task, link: null, grant: null, parentTask: null }
  const grant = host.db.query("SELECT * FROM watch_delegation_grants WHERE grant_id = ?").get(link.grant_id) as
    | DelegationGrantRow
    | null
  const parentTask = host.taskRow(link.parent_task_id)
  return {
    task,
    link: linkFromRow(link),
    grant: grant === null ? null : grantFromRow(grant),
    parentTask: parentTask === null ? null : host.task(parentTask.task_id),
  }
}

export function listDelegatedChildren(
  host: DelegationLedgerHost,
  parentTaskID: string,
): readonly DelegatedChildRecord[] {
  const id = requiredIdentifier(parentTaskID, "parentTaskID")
  const rows = host.db
    .query(
      `SELECT l.* FROM watch_delegated_tasks l
       JOIN watch_tasks t ON t.task_id = l.task_id
       WHERE l.parent_task_id = ?
       ORDER BY t.created_at, l.task_id`,
    )
    .all(id) as DelegatedTaskRow[]
  return rows.map((row) => ({ task: host.task(row.task_id), link: linkFromRow(row) }))
}

/**
 * The persistent-fact recheck for a delegated child's correction grant. It is
 * called inside the reserve/claim/receipt transaction, after any host-fact
 * await, so a revoke or link change cannot be overwritten by an older result.
 */
export function assertDelegatedCorrectionAuthority(
  host: DelegationLedgerHost,
  input: {
    readonly taskID: string
    readonly targetSessionID: string
    readonly ownerActivation: string
    readonly generation: number
    readonly sourceGrantID: string | null
    readonly sourceGrantVersion: number | null
  },
): { readonly required: boolean; readonly ok: boolean; readonly reason: string | null } {
  const link = linkRow(host.db, input.taskID)
  if (link === null) {
    if (input.sourceGrantID !== null) {
      return { required: true, ok: false, reason: "the delegated task link is missing" }
    }
    return { required: false, ok: true, reason: null }
  }
  if (input.sourceGrantID === null || input.sourceGrantVersion === null) {
    return { required: true, ok: false, reason: "the child correction grant has no delegation source" }
  }
  if (input.sourceGrantID !== link.grant_id || input.sourceGrantVersion !== link.grant_version) {
    return { required: true, ok: false, reason: "the child correction grant is not bound to the current delegation link" }
  }
  const source = host.db
    .query("SELECT * FROM watch_delegation_grants WHERE grant_id = ?")
    .get(link.grant_id) as DelegationGrantRow | null
  if (source === null || source.state !== "granted" || source.version !== link.grant_version) {
    return { required: true, ok: false, reason: "the source delegation grant is revoked or changed" }
  }
  if (
    source.parent_task_id !== link.parent_task_id ||
    source.parent_session_id !== link.parent_session_id ||
    source.scope_target_session_id !== input.targetSessionID ||
    source.scope_directory !== link.verified_directory ||
    source.scope_peer_scope !== link.verified_scope
  ) {
    return { required: true, ok: false, reason: "the source delegation grant no longer covers this child" }
  }
  const currentDigest = delegationTermsDigest({
    parentTaskID: source.parent_task_id,
    parentSessionID: source.parent_session_id,
    targetSessionID: source.scope_target_session_id,
    mode: source.mode as WatchMode,
    directory: source.scope_directory,
    peerScope: source.scope_peer_scope,
    ownerActivation: source.owner_activation,
    generation: source.generation,
    version: source.parent_task_version,
  })
  if (source.terms_digest !== currentDigest) {
    return { required: true, ok: false, reason: "the delegation or correction terms changed" }
  }
  const parent = host.taskRow(link.parent_task_id)
  if (
    parent === null ||
    parent.watch_state !== "active" ||
    parent.task_state === "completed" ||
    parent.initiator_session_id !== parent.target_session_id ||
    parent.target_session_id !== link.parent_session_id ||
    parent.owner_activation !== input.ownerActivation ||
    parent.generation !== input.generation
  ) {
    return { required: true, ok: false, reason: "the parent task is no longer eligible for this child" }
  }
  const child = host.taskRow(input.taskID)
  if (child === null || child.target_session_id !== input.targetSessionID || child.task_id !== input.taskID) {
    return { required: true, ok: false, reason: "the child task identity changed" }
  }
  return { required: true, ok: true, reason: null }
}

export function assertDelegationIntegrity(db: Database): void {
  const badGrant = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_delegation_grants
       WHERE mode NOT IN ('alert','limited-correction')
          OR state NOT IN ('granted','revoked')
          OR version < 1 OR generation < 1 OR parent_task_version < 1
          OR length(owner_activation) = 0
          OR (mode = 'limited-correction' AND deployment_statement IS NOT 'single-host-same-location')
          OR (mode = 'alert' AND deployment_statement IS NOT NULL)`,
    )
    .get() as { n: number }
  if (badGrant.n !== 0) throw new LedgerDelegationFailure("corrupt", "a delegation grant row is invalid")
  const orphan = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_delegated_tasks l
       LEFT JOIN watch_tasks c ON c.task_id = l.task_id
       LEFT JOIN watch_tasks p ON p.task_id = l.parent_task_id
       LEFT JOIN watch_delegation_grants g ON g.grant_id = l.grant_id
       WHERE c.task_id IS NULL OR p.task_id IS NULL OR g.grant_id IS NULL`,
    )
    .get() as { n: number }
  if (orphan.n !== 0) throw new LedgerDelegationFailure("corrupt", "a delegated task link has a missing row")
  const mismatch = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_delegated_tasks l
       JOIN watch_tasks c ON c.task_id = l.task_id
       JOIN watch_tasks p ON p.task_id = l.parent_task_id
       WHERE c.target_session_id <> l.target_session_id
          OR p.target_session_id <> l.parent_session_id
          OR p.initiator_session_id <> p.target_session_id`,
    )
    .get() as { n: number }
  if (mismatch.n !== 0) throw new LedgerDelegationFailure("corrupt", "a delegated task link contradicts its task rows")
  const orphanGrant = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_correction_grants cg
       LEFT JOIN watch_delegated_tasks l ON l.task_id = cg.task_id
       WHERE cg.source_delegation_grant_id IS NOT NULL AND l.task_id IS NULL`,
    )
    .get() as { n: number }
  if (orphanGrant.n !== 0) {
    throw new LedgerDelegationFailure("corrupt", "a correction grant carries a delegation source without a link")
  }
  const missingSource = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_correction_grants cg
       LEFT JOIN watch_delegation_grants dg ON dg.grant_id = cg.source_delegation_grant_id
       WHERE cg.source_delegation_grant_id IS NOT NULL AND dg.grant_id IS NULL`,
    )
    .get() as { n: number }
  if (missingSource.n !== 0) {
    throw new LedgerDelegationFailure("corrupt", "a correction grant names a missing delegation source")
  }
  const missingDerived = db
    .query(
      `SELECT COUNT(*) AS n FROM watch_delegated_tasks l
       JOIN watch_tasks t ON t.task_id = l.task_id
       LEFT JOIN watch_correction_grants g
         ON g.task_id = l.task_id AND g.source_delegation_grant_id IS NOT NULL
       WHERE t.mode = 'limited-correction' AND g.task_id IS NULL`,
    )
    .get() as { n: number }
  if (missingDerived.n !== 0) {
    throw new LedgerDelegationFailure("corrupt", "a limited delegated child has no derived correction grant")
  }
}

function activeGrantFor(db: Database, parentTaskID: string, target: string): DelegationGrantRow | null {
  return db
    .query(
      "SELECT * FROM watch_delegation_grants WHERE parent_task_id = ? AND scope_target_session_id = ? AND state = 'granted' ORDER BY granted_at DESC, grant_id LIMIT 1",
    )
    .get(parentTaskID, target) as DelegationGrantRow | null
}

function grantRow(host: DelegationLedgerHost, grantID: string): DelegationGrantRecord {
  const row = host.db.query("SELECT * FROM watch_delegation_grants WHERE grant_id = ?").get(grantID) as
    | DelegationGrantRow
    | null
  if (row === null) throw new LedgerDelegationFailure("not_granted", grantID)
  return grantFromRow(row)
}

function childTasksForGrant(db: Database, grantID: string): readonly string[] {
  const rows = db
    .query("SELECT task_id FROM watch_delegated_tasks WHERE grant_id = ? ORDER BY verified_at, task_id")
    .all(grantID) as Array<{ task_id: string }>
  return rows.map((row) => row.task_id)
}

function linkRow(db: Database, taskID: string): DelegatedTaskRow | null {
  return db.query("SELECT * FROM watch_delegated_tasks WHERE task_id = ?").get(taskID) as DelegatedTaskRow | null
}

function grantFromRow(row: DelegationGrantRow): DelegationGrantRecord {
  if (row.mode !== "alert" && row.mode !== "limited-correction") {
    throw new LedgerDelegationFailure("corrupt", `unknown delegation mode ${row.mode}`)
  }
  if (row.state !== "granted" && row.state !== "revoked") {
    throw new LedgerDelegationFailure("corrupt", `unknown delegation state ${row.state}`)
  }
  return {
    grantID: row.grant_id,
    parentTaskID: row.parent_task_id,
    parentSessionID: row.parent_session_id,
    parentTaskVersion: row.parent_task_version,
    ownerActivation: row.owner_activation,
    mode: row.mode,
    state: row.state,
    version: row.version,
    generation: row.generation,
    scopeTargetSessionID: row.scope_target_session_id,
    scopeDirectory: row.scope_directory,
    scopePeerScope: row.scope_peer_scope,
    ...(row.deployment_statement === null ? {} : { deployment: row.deployment_statement as "single-host-same-location" }),
    reviewSummary: row.review_summary,
    termsDigest: row.terms_digest,
    confirmationID: row.confirmation_id,
    grantedAt: row.granted_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}

function linkFromRow(row: DelegatedTaskRow): DelegatedTaskLink {
  if (row.verified_scope_source !== "recorded" && row.verified_scope_source !== "configured") {
    throw new LedgerDelegationFailure("corrupt", `unknown scope source ${row.verified_scope_source}`)
  }
  return {
    taskID: row.task_id,
    grantID: row.grant_id,
    grantVersion: row.grant_version,
    parentTaskID: row.parent_task_id,
    parentSessionID: row.parent_session_id,
    targetSessionID: row.target_session_id,
    verifiedParentID: row.verified_parent_id,
    verifiedDirectory: row.verified_directory,
    verifiedScope: row.verified_scope,
    verifiedScopeSource: row.verified_scope_source,
    verifiedAt: row.verified_at,
  }
}

function checkLedger(host: DelegationLedgerHost, row: DelegationTaskRow): void {
  if (row.ledger_id !== host.ledgerId) {
    throw new LedgerDelegationFailure("ledger_mismatch", "the task belongs to a different ledger")
  }
}

function rank(mode: WatchMode): number {
  return mode === "alert" ? 0 : 1
}

function requiredIdentifier(value: string, field: string): string {
  const checked = readIdentifier(value, field)
  if (!checked.ok) throw new LedgerDelegationFailure("invalid_input", checked.reason)
  return checked.value
}

function requiredGoal(value: string): string {
  const checked = readGoal(value)
  if (!checked.ok) throw new LedgerDelegationFailure("invalid_input", checked.reason)
  return checked.value
}

function requiredScope(value: string, field: string): string {
  const checked = readDelegationScope(value, field)
  if (!checked.ok) throw new LedgerDelegationFailure("invalid_input", checked.reason)
  return checked.value
}

/** Re-exported so the main ledger can present the same ledger result type. */
export type DelegationLedgerResult<T> = LedgerResult<T>
