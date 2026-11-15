/**
 * The RPC adapter for the watchdog panel.
 *
 * It parses the method's bounded input, verifies that an enrollment is for a
 * session this location actually serves, calls the same application the tool
 * uses, and returns one `WatchPayload` whether the call succeeded or was
 * refused. Failures are values here, not thrown strings: a panel needs the
 * current capability and controls even when a version is stale.
 */

import type { WatchConfig } from "../config.ts"
import { DELEGATION_UNAVAILABLE_REASON, type WatchFailure } from "../domain/watch.ts"
import type { SessionLookup } from "../host/session.ts"
import { sessionAtLocation } from "../watch/access.ts"
import { emptyWatchAlerts, type WatchApplication, type WatchObservationSource, type WatchOutcome } from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"
import type { WatchFailureView, WatchPayload } from "../watch/contract.ts"

export interface WatchRpcDeps {
  readonly enabled: boolean
  /** Absent exactly when the plugin is disabled at this location. */
  readonly watch?: WatchApplication
  /** The observer's current reading; absent before the observer starts. */
  readonly observe?: WatchObservationSource
  readonly sessions: SessionLookup
  readonly directory: string
  readonly watchConfig: WatchConfig
}

export async function watchRpc(deps: WatchRpcDeps, input: unknown): Promise<WatchPayload> {
  const request = readRequest(input)
  if (!request.ok) {
    return failurePayload(deps, { code: "E_WATCH_INVALID", reason: request.reason })
  }
  if (!deps.enabled || deps.watch === undefined) {
    return failurePayload(deps, { code: "E_WATCH_DISABLED", reason: "Session peers is disabled by configuration." })
  }

  const watch = deps.watch
  if (!(await sessionAtLocation(deps.sessions, request.value.sessionID, deps.directory))) {
    return failurePayload(deps, {
      code: "E_WATCH_NOT_FOUND",
      reason: `This location does not serve session "${request.value.sessionID}".`,
    })
  }
  switch (request.value.operation) {
    case "show":
      return payload(deps, watch.show({ sessionID: request.value.sessionID, ...(request.value.taskID === undefined ? {} : { taskID: request.value.taskID }) }))

    case "enroll": {
      if (request.value.requestId === undefined || request.value.goal === undefined) {
        return failurePayload(deps, { code: "E_WATCH_INVALID", reason: "enroll needs requestId and goal" })
      }
      if (request.value.targetSessionID !== undefined && request.value.targetSessionID !== request.value.sessionID) {
        return failurePayload(deps, { code: "E_WATCH_UNSUPPORTED", reason: DELEGATION_UNAVAILABLE_REASON })
      }
      return payload(
        deps,
        watch.enroll({
          callerSessionID: request.value.sessionID,
          requestID: request.value.requestId,
          goal: request.value.goal,
          ...(request.value.targetSessionID === undefined ? {} : { targetSessionID: request.value.targetSessionID }),
          ...(request.value.mode === undefined ? {} : { mode: request.value.mode }),
        }),
      )
    }

    case "ack": {
      if (request.value.alertID === undefined) {
        return failurePayload(deps, { code: "E_WATCH_INVALID", reason: "ack needs alertID" })
      }
      return payload(
        deps,
        watch.ack({ callerSessionID: request.value.sessionID, alertID: request.value.alertID }),
      )
    }

    case "pause":
    case "end": {
      if (request.value.taskID === undefined || request.value.expectedVersion === undefined) {
        return failurePayload(deps, {
          code: "E_WATCH_INVALID",
          reason: `${request.value.operation} needs taskID and expectedVersion`,
        })
      }
      return payload(
        deps,
        watch.control({
          callerSessionID: request.value.sessionID,
          taskID: request.value.taskID,
          expectedVersion: request.value.expectedVersion,
          operation: request.value.operation,
        }),
      )
    }
  }
}

interface WatchRpcRequest {
  readonly operation: "show" | "enroll" | "pause" | "end" | "ack"
  readonly sessionID: string
  readonly taskID?: string
  readonly alertID?: string
  readonly expectedVersion?: number
  readonly requestId?: string
  readonly goal?: string
  readonly targetSessionID?: string
  readonly mode?: "alert" | "correct"
}

function readRequest(input: unknown):
  | { readonly ok: true; readonly value: WatchRpcRequest }
  | { readonly ok: false; readonly reason: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "the watch method needs an object" }
  }
  const record = input as Record<string, unknown>
  const operation = record["operation"]
  if (
    operation !== "show" &&
    operation !== "enroll" &&
    operation !== "pause" &&
    operation !== "end" &&
    operation !== "ack"
  ) {
    return { ok: false, reason: "operation must be show, enroll, pause, end or ack" }
  }
  const sessionID = readString(record["sessionID"])
  if (sessionID === undefined) return { ok: false, reason: "sessionID must be a non-empty string" }
  const taskID = readString(record["taskID"])
  const alertID = readString(record["alertID"])
  const requestId = readString(record["requestId"])
  const goal = readString(record["goal"])
  const targetSessionID = readString(record["targetSessionID"])
  const mode = record["mode"]
  if (mode !== undefined && mode !== "alert" && mode !== "correct") {
    return { ok: false, reason: "mode must be alert or correct" }
  }
  const expectedVersion = record["expectedVersion"]
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
  ) {
    return { ok: false, reason: "expectedVersion must be a positive integer" }
  }
  return {
    ok: true,
    value: {
      operation,
      sessionID,
      ...(taskID === undefined ? {} : { taskID }),
      ...(alertID === undefined ? {} : { alertID }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(goal === undefined ? {} : { goal }),
      ...(targetSessionID === undefined ? {} : { targetSessionID }),
      ...(mode === undefined ? {} : { mode }),
    },
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function payload(deps: WatchRpcDeps, outcome: WatchOutcome): WatchPayload {
  const status = ledgerStatus(deps)
  const taskID = outcome.task?.taskID
  return {
    enabled: deps.enabled,
    ledger: status,
    task: outcome.task,
    capability: outcome.capability,
    controls: outcome.controls,
    observation: observationFor(outcome, deps),
    activity:
      taskID === undefined || outcome.task?.watchState === "ended" || outcome.task?.taskState === "completed"
        ? null
        : deps.observe?.activityFor(taskID) ?? null,
    alerts: outcome.alerts,
    failure: outcome.failure === null ? null : failureView(outcome.failure),
  }
}

function failurePayload(deps: WatchRpcDeps, failure: WatchFailure): WatchPayload {
  const status = ledgerStatus(deps)
  return {
    enabled: deps.enabled,
    ledger: status,
    task: null,
    capability: watchCapability(),
    controls: unavailableControls(status.available, status.reason),
    observation: null,
    activity: null,
    alerts: emptyWatchAlerts(status.available, status.reason),
    failure: failureView(failure),
  }
}

function observationFor(outcome: WatchOutcome, deps: WatchRpcDeps) {
  const task = outcome.task
  if (task === null || task.watchState === "ended" || task.taskState === "completed") return null
  const snapshot = deps.observe?.observationFor(task.taskID) ?? null
  if (task.watchState === "paused") {
    return {
      ...(snapshot ?? {
        state: "unavailable" as const,
        reason: null,
        observedAt: null,
        baselineAt: null,
        idleSince: null,
        trusted: false,
        waits: [],
        waitsPartial: false,
        waitsTruncated: false,
        effective: {
          idleMs: deps.watchConfig.idleMs,
          runningSilentMs: deps.watchConfig.runningSilentMs,
          waitOverdueMs: deps.watchConfig.waitOverdueMs,
        },
      }),
      state: "unavailable" as const,
      reason: "supervision is paused",
      trusted: false,
    }
  }
  return snapshot
}

function ledgerStatus(deps: WatchRpcDeps): { available: boolean; reason: string | null } {
  return deps.watch === undefined
    ? { available: false, reason: "the plugin is disabled at this location" }
    : deps.watch.status()
}

function unavailableControls(available: boolean, reason: string | null) {
  const controls = watchControls(null)
  if (available) return controls
  const disabled = { enabled: false, reason: reason ?? "the watch ledger is unavailable" }
  return { ...controls, pause: disabled, end: disabled, acknowledge: disabled }
}

function failureView(failure: WatchFailure): WatchFailureView {
  return {
    code: failure.code,
    reason: failure.reason,
    detail: failure.detail ?? null,
  }
}
