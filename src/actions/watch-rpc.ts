/**
 * The RPC adapter for the watchdog panel.
 *
 * It parses the method's bounded input, verifies that an enrollment is for a
 * session this location actually serves, calls the same application the tool
 * uses, and returns one `WatchPayload` whether the call succeeded or was
 * refused. Failures are values here, not thrown strings: a panel needs the
 * current capability and controls even when a version is stale.
 */

import { DELEGATION_UNAVAILABLE_REASON, type WatchFailure } from "../domain/watch.ts"
import type { SessionLookup } from "../host/session.ts"
import { sessionAtLocation } from "../watch/access.ts"
import type { WatchApplication, WatchOutcome } from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"
import type { WatchFailureView, WatchPayload } from "../watch/contract.ts"

export interface WatchRpcDeps {
  readonly enabled: boolean
  /** Absent exactly when the plugin is disabled at this location. */
  readonly watch?: WatchApplication
  readonly sessions: SessionLookup
  readonly directory: string
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
  readonly operation: "show" | "enroll" | "pause" | "end"
  readonly sessionID: string
  readonly taskID?: string
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
  if (operation !== "show" && operation !== "enroll" && operation !== "pause" && operation !== "end") {
    return { ok: false, reason: "operation must be show, enroll, pause or end" }
  }
  const sessionID = readString(record["sessionID"])
  if (sessionID === undefined) return { ok: false, reason: "sessionID must be a non-empty string" }
  const taskID = readString(record["taskID"])
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
  const status = deps.watch === undefined ? { available: false, reason: "the plugin is disabled at this location" } : deps.watch.status()
  return {
    enabled: deps.enabled,
    ledger: status,
    task: outcome.task,
    capability: outcome.capability,
    controls: outcome.controls,
    failure: outcome.failure === null ? null : failureView(outcome.failure),
  }
}

function failurePayload(deps: WatchRpcDeps, failure: WatchFailure): WatchPayload {
  const status = deps.watch === undefined ? { available: false, reason: "the plugin is disabled at this location" } : deps.watch.status()
  return {
    enabled: deps.enabled,
    ledger: status,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    failure: failureView(failure),
  }
}

function failureView(failure: WatchFailure): WatchFailureView {
  return {
    code: failure.code,
    reason: failure.reason,
    detail: failure.detail ?? null,
  }
}
