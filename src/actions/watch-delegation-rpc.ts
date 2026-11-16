/**
 * The controlled delegation RPC handler.
 *
 * It is separate from the model-facing `watch` tool and from `watchGrant`.
 * `sessionAtLocation` is a location check, not authentication; the same-OS-user
 * boundary still applies. No branch prompts, generates or interrupts.
 */

import { WATCH_CORRECTION_TERMS, type WatchFailure } from "../domain/watch.ts"
import type { SessionLookup } from "../host/session.ts"
import { sessionAtLocation } from "../watch/access.ts"
import { WATCH_DELEGATION_TERMS } from "../watch/delegation.ts"
import type { WatchApplication, WatchDelegationGrantOutcome } from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"
import type {
  DelegationChallengeView,
  WatchDelegationGrantPayload,
  WatchDelegationViewPayload,
} from "../watch/delegation-contract.ts"

export interface WatchDelegationRpcDeps {
  readonly enabled: boolean
  readonly watch?: WatchApplication
  readonly sessions: SessionLookup
  readonly directory: string
}

export async function watchDelegationRpc(
  deps: WatchDelegationRpcDeps,
  input: unknown,
): Promise<WatchDelegationGrantPayload> {
  const request = readRequest(input)
  if (!request.ok) return failure("E_WATCH_INVALID", request.reason)
  if (!deps.enabled || deps.watch === undefined) {
    return failure("E_WATCH_DISABLED", "Session peers is disabled by configuration.")
  }
  if (!(await sessionAtLocation(deps.sessions, request.value.sessionID, deps.directory))) {
    return failure("E_WATCH_NOT_FOUND", `This location does not serve session "${request.value.sessionID}".`)
  }
  const watch = deps.watch
  if (watch.isClosing()) {
    return failure("E_WATCH_UNAVAILABLE", "The watch application is closing; no delegation action was taken.")
  }
  switch (request.value.operation) {
    case "prepare":
      return payload(
        await watch.prepareDelegationGrant({
          callerSessionID: request.value.sessionID,
          parentTaskID: request.value.parentTaskID,
          expectedVersion: request.value.expectedVersion,
          targetSessionID: request.value.targetSessionID!,
          mode: request.value.mode!,
          ...(request.value.deployment === undefined ? {} : { deployment: request.value.deployment }),
        }),
      )
    case "confirm":
      return payload(
        await watch.confirmDelegationGrant({
          callerSessionID: request.value.sessionID,
          parentTaskID: request.value.parentTaskID,
          expectedVersion: request.value.expectedVersion,
          generation: request.value.generation!,
          targetSessionID: request.value.targetSessionID!,
          mode: request.value.mode!,
          scopeDirectory: request.value.scopeDirectory!,
          scopePeerScope: request.value.scopePeerScope!,
          termsDigest: request.value.termsDigest!,
          challenge: request.value.challenge!,
          ...(request.value.deployment === undefined ? {} : { deployment: request.value.deployment }),
        }),
      )
    case "revoke":
      return payload(
        await watch.revokeDelegationGrant({
          callerSessionID: request.value.sessionID,
          parentTaskID: request.value.parentTaskID,
          targetSessionID: request.value.targetSessionID!,
          expectedVersion: request.value.expectedVersion,
        }),
      )
  }
}

export async function watchDelegationViewRpc(
  deps: WatchDelegationRpcDeps,
  input: unknown,
): Promise<WatchDelegationViewPayload> {
  const request = readViewRequest(input)
  if (!request.ok) {
    return {
      ok: false,
      parentTaskID: "",
      parentSessionID: "",
      grants: [],
      children: [],
      failure: { code: "E_WATCH_INVALID", reason: request.reason },
    }
  }
  if (!deps.enabled || deps.watch === undefined) {
    return viewFailure("E_WATCH_DISABLED", "Session peers is disabled by configuration.", request.value.parentTaskID)
  }
  if (!(await sessionAtLocation(deps.sessions, request.value.sessionID, deps.directory))) {
    return viewFailure(
      "E_WATCH_NOT_FOUND",
      `This location does not serve session "${request.value.sessionID}".`,
      request.value.parentTaskID,
    )
  }
  return deps.watch.delegationView({
    sessionID: request.value.sessionID,
    parentTaskID: request.value.parentTaskID,
  })
}

interface Request {
  readonly operation: "prepare" | "confirm" | "revoke"
  readonly sessionID: string
  readonly parentTaskID: string
  readonly expectedVersion: number
  readonly targetSessionID?: string
  readonly mode?: "alert" | "limited-correction"
  readonly deployment?: "single-host-same-location"
  readonly challenge?: string
  readonly generation?: number
  readonly termsDigest?: string
  readonly scopeDirectory?: string
  readonly scopePeerScope?: string
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

function readRequest(input: unknown): Parsed<Request> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "the watchDelegation method needs an object" }
  }
  const record = input as Record<string, unknown>
  const operation = record["operation"]
  if (operation !== "prepare" && operation !== "confirm" && operation !== "revoke") {
    return { ok: false, reason: "operation must be prepare, confirm or revoke" }
  }
  const allowed = new Set([
    "operation",
    "sessionID",
    "parentTaskID",
    "expectedVersion",
    "targetSessionID",
    "mode",
    ...(operation === "prepare" || operation === "confirm" ? ["deployment"] : []),
    ...(operation === "confirm"
      ? ["challenge", "generation", "termsDigest", "scopeDirectory", "scopePeerScope"]
      : []),
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, reason: `watchDelegation.${key} is not valid for ${operation}` }
  }
  const sessionID = readString(record["sessionID"])
  const parentTaskID = readString(record["parentTaskID"])
  const expectedVersion = record["expectedVersion"]
  if (sessionID === undefined || parentTaskID === undefined) {
    return { ok: false, reason: "sessionID and parentTaskID must be non-empty strings" }
  }
  if (!isPositiveInteger(expectedVersion)) {
    return { ok: false, reason: "expectedVersion must be a positive integer" }
  }
  const targetSessionID = readString(record["targetSessionID"])
  if (targetSessionID === undefined) return { ok: false, reason: `${operation} needs targetSessionID` }
  if (operation === "revoke") {
    return { ok: true, value: { operation, sessionID, parentTaskID, expectedVersion, targetSessionID } }
  }
  const mode = record["mode"]
  if (mode !== "alert" && mode !== "limited-correction") {
    return { ok: false, reason: `${operation} needs mode alert or limited-correction` }
  }
  const deployment = record["deployment"]
  if (deployment !== undefined && deployment !== "single-host-same-location") {
    return { ok: false, reason: "deployment must be single-host-same-location" }
  }
  if (mode === "limited-correction" && deployment !== "single-host-same-location") {
    return { ok: false, reason: "limited-correction needs the explicit single-host-same-location declaration" }
  }
  if (mode === "alert" && deployment !== undefined) {
    return { ok: false, reason: "alert delegation has no deployment declaration" }
  }
  if (operation === "confirm") {
    const challenge = readString(record["challenge"])
    const termsDigest = readString(record["termsDigest"])
    const scopeDirectory = readString(record["scopeDirectory"])
    const scopePeerScope = readString(record["scopePeerScope"])
    const generation = record["generation"]
    if (
      challenge === undefined ||
      termsDigest === undefined ||
      scopeDirectory === undefined ||
      scopePeerScope === undefined ||
      !isPositiveInteger(generation)
    ) {
      return { ok: false, reason: "confirm needs challenge, generation, termsDigest and both scope fields" }
    }
    return {
      ok: true,
      value: {
        operation,
        sessionID,
        parentTaskID,
        expectedVersion,
        targetSessionID,
        mode,
        ...(deployment === undefined ? {} : { deployment }),
        challenge,
        generation,
        termsDigest,
        scopeDirectory,
        scopePeerScope,
      },
    }
  }
  return {
    ok: true,
    value: {
      operation,
      sessionID,
      parentTaskID,
      expectedVersion,
      targetSessionID,
      mode,
      ...(deployment === undefined ? {} : { deployment }),
    },
  }
}

function readViewRequest(input: unknown): Parsed<{ readonly sessionID: string; readonly parentTaskID: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "the watchDelegationView method needs an object" }
  }
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== "sessionID" && key !== "parentTaskID") {
      return { ok: false, reason: `watchDelegationView.${key} is not a supported field` }
    }
  }
  const sessionID = readString(record["sessionID"])
  const parentTaskID = readString(record["parentTaskID"])
  if (sessionID === undefined || parentTaskID === undefined) {
    return { ok: false, reason: "sessionID and parentTaskID must be non-empty strings" }
  }
  return { ok: true, value: { sessionID, parentTaskID } }
}

function payload(outcome: WatchDelegationGrantOutcome): WatchDelegationGrantPayload {
  const challenge: DelegationChallengeView | null =
    outcome.challenge === null
      ? null
      : {
          challenge: outcome.challenge.challenge,
          parentTaskID: outcome.challenge.parentTaskID,
          expectedVersion: outcome.challenge.expectedVersion,
          generation: outcome.challenge.generation,
          mode: outcome.challenge.mode,
          targetSessionID: outcome.challenge.targetSessionID,
          scopeDirectory: outcome.challenge.scopeDirectory,
          scopePeerScope: outcome.challenge.scopePeerScope,
          ...(outcome.challenge.deployment === undefined ? {} : { deployment: outcome.challenge.deployment }),
          termsDigest: outcome.challenge.termsDigest,
          reviewSummary: outcome.challenge.reviewSummary,
          expiresAt: outcome.challenge.expiresAt,
        }
  return {
    ok: outcome.ok,
    challenge,
    grant: outcome.grant,
    task: outcome.task,
    capability: outcome.capability,
    controls: outcome.controls,
    review: outcome.review,
    failure: outcome.failure,
  }
}

function failure(code: string, reason: string): WatchDelegationGrantPayload {
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
    },
    failure: { code: code as WatchFailure["code"], reason },
  }
}

function viewFailure(code: string, reason: string, parentTaskID: string): WatchDelegationViewPayload {
  return {
    ok: false,
    parentTaskID,
    parentSessionID: "",
    grants: [],
    children: [],
    failure: { code, reason },
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}
