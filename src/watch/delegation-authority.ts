/**
 * Fresh delegated-authority checks.
 *
 * A delegated child's eligibility is not fixed at enrollment. This module
 * reads the durable link from the ledger, then reads the host's current parent
 * fact, location and scope, then re-reads the ledger so an await cannot let a
 * revoke or a new grant be overwritten by an older observation. It never
 * prompts, generates, interrupts or exposes a token; a missing helper or an
 * unknown fact is a refusal for a delegated task, not a fallback.
 */

import type { SessionLookup } from "../host/session.ts"
import type { Peer } from "../domain/types.ts"
import type { RecordStore } from "../host/storage.ts"
import type { WatchLedger } from "./ledger.ts"
import {
  delegatedAuthorityGate,
  type DelegatedAuthorityResult,
  type DelegationSessionFact,
  type DelegationStopReason,
} from "./delegation.ts"

export interface ScopeFact {
  readonly scope: string
  readonly source: "recorded" | "configured"
}

export interface ScopeFactReaderDeps {
  readonly configScope: string
  /** The directory this plugin instance serves. */
  readonly directory: string
  readonly sessions: SessionLookup
  readonly peers: RecordStore<Peer>
}

/**
 * Reads a session's scope without calling a configured fallback a host proof.
 * A recorded roster row is a plugin fact; the configured scope is only used for
 * a session this same instance demonstrably serves. Anything else is unknown.
 */
export function createScopeFactReader(deps: ScopeFactReaderDeps): (sessionID: string) => Promise<ScopeFact | null> {
  return async (sessionID) => {
    try {
      const record = await deps.peers.read(sessionID)
      if (record !== undefined) return { scope: record.scope, source: "recorded" }
    } catch {
      return null
    }
    try {
      const session = await deps.sessions.get(sessionID)
      if (session.directory !== deps.directory) return null
      return { scope: deps.configScope, source: "configured" }
    } catch {
      return null
    }
  }
}

export interface DelegatedAuthorityCheck extends DelegatedAuthorityResult {
  readonly taskID: string
  readonly targetSessionID: string
  readonly taskVersion: number | null
  readonly generation: number | null
  readonly parentTaskID: string | null
  readonly parentVersion: number | null
  readonly grantID: string | null
  readonly grantVersion: number | null
  readonly scopeSource: "recorded" | "configured" | "unknown"
  readonly checkedAt: number
}

export interface DelegationAuthority {
  /**
   * The parent/action caller must await this before a delegated child's
   * reserve, claim or receipt permit. It returns facts, never a model-supplied
   * `checked` flag; the ledger repeats the durable part inside its transaction.
   */
  check(taskID: string): Promise<DelegatedAuthorityCheck>
}

export interface DelegationAuthorityOptions {
  readonly ledger: Pick<WatchLedger, "delegatedAuthority">
  readonly sessions: SessionLookup
  readonly scopeOf: (sessionID: string) => Promise<ScopeFact | null>
  readonly activationID: string
  readonly closing: () => boolean
  readonly now?: () => number
}

export function createDelegationAuthority(options: DelegationAuthorityOptions): DelegationAuthority {
  const now = options.now ?? Date.now

  return {
    async check(taskID) {
      const first = options.ledger.delegatedAuthority(taskID)
      if (!first.ok) {
        return refused(taskID, `ledger ${first.code}`, now())
      }
      const snapshot = first.value
      if (snapshot.link === null) {
        return {
          required: false,
          allowed: true,
          stopReason: null,
          missingEvidence: null,
          gates: [],
          taskID,
          targetSessionID: snapshot.task.targetSessionID,
          taskVersion: snapshot.task.version,
          generation: snapshot.task.generation,
          parentTaskID: null,
          parentVersion: null,
          grantID: null,
          grantVersion: null,
          scopeSource: "unknown",
          checkedAt: now(),
        }
      }
      if (options.closing()) {
        return refused(taskID, "closing", now(), snapshot, "closing")
      }

      const parentSessionID = snapshot.link.parentSessionID
      const childSessionID = snapshot.task.targetSessionID
      const [parentSession, childSession, parentScope, childScope] = await Promise.all([
        sessionFact(options.sessions, parentSessionID),
        sessionFact(options.sessions, childSessionID),
        scopeFact(options.scopeOf, parentSessionID),
        scopeFact(options.scopeOf, childSessionID),
      ])

      // A revoke, a new grant or a task change during the host reads must not
      // be overwritten by the older snapshot.
      if (options.closing()) return refused(taskID, "closing", now(), snapshot, "closing")
      const second = options.ledger.delegatedAuthority(taskID)
      if (!second.ok) return refused(taskID, `ledger ${second.code}`, now(), snapshot)
      const current = second.value
      const stable =
        current.link !== null &&
        current.task.version === snapshot.task.version &&
        current.task.generation === snapshot.task.generation &&
        current.link.grantVersion === snapshot.link.grantVersion &&
        current.grant?.version === snapshot.grant?.version &&
        current.grant?.state === snapshot.grant?.state &&
        current.parentTask?.version === snapshot.parentTask?.version &&
        current.parentTask?.watchState === snapshot.parentTask?.watchState
      if (!stable) return refused(taskID, "delegated authority changed during the check", now(), current, "grant-stale")

      const gate = delegatedAuthorityGate(current, {
        parent: parentSession,
        child: childSession,
        parentScope: parentScope?.scope ?? null,
        childScope: childScope?.scope ?? null,
        ownerActivation: options.activationID,
        closing: options.closing(),
      })
      return {
        ...gate,
        taskID,
        targetSessionID: current.task.targetSessionID,
        taskVersion: current.task.version,
        generation: current.task.generation,
        parentTaskID: current.link.parentTaskID,
        parentVersion: current.parentTask?.version ?? null,
        grantID: current.grant?.grantID ?? null,
        grantVersion: current.grant?.version ?? null,
        scopeSource: scopeSource(parentScope, childScope),
        checkedAt: now(),
      }
    },
  }
}

function refused(
  taskID: string,
  reason: string,
  checkedAt: number,
  snapshot?: {
    readonly task: { readonly targetSessionID: string; readonly version: number; readonly generation: number }
    readonly link: { readonly parentTaskID: string; readonly grantID: string; readonly grantVersion: number } | null
    readonly grant: { readonly grantID: string; readonly version: number } | null
    readonly parentTask: { readonly version: number } | null
  },
  stopReason: DelegationStopReason = "authority-unknown",
): DelegatedAuthorityCheck {
  return {
    required: true,
    allowed: false,
    stopReason: stopReason,
    missingEvidence: reason,
    gates: [],
    taskID,
    targetSessionID: snapshot?.task.targetSessionID ?? "",
    taskVersion: snapshot?.task.version ?? null,
    generation: snapshot?.task.generation ?? null,
    parentTaskID: snapshot?.link?.parentTaskID ?? null,
    parentVersion: snapshot?.parentTask?.version ?? null,
    grantID: snapshot?.grant?.grantID ?? snapshot?.link?.grantID ?? null,
    grantVersion: snapshot?.grant?.version ?? snapshot?.link?.grantVersion ?? null,
    scopeSource: "unknown",
    checkedAt,
  }
}

async function sessionFact(sessions: SessionLookup, sessionID: string): Promise<DelegationSessionFact | null> {
  try {
    const session = await sessions.get(sessionID)
    return {
      id: session.id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      directory: session.directory,
    }
  } catch {
    return null
  }
}

async function scopeFact(
  scopeOf: (sessionID: string) => Promise<ScopeFact | null>,
  sessionID: string,
): Promise<ScopeFact | null> {
  try {
    return await scopeOf(sessionID)
  } catch {
    return null
  }
}

function scopeSource(left: ScopeFact | null, right: ScopeFact | null): "recorded" | "configured" | "unknown" {
  if (left === null || right === null) return "unknown"
  if (left.source === "recorded" && right.source === "recorded") return "recorded"
  if (left.source === "configured" && right.source === "configured") return "configured"
  return "unknown"
}
