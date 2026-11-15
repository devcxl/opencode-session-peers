/**
 * The controlled TUI grant channel.
 *
 * It is deliberately separate from the model-facing `watch` tool and from the
 * `/peers-watch` command. Only this RPC method can prepare or confirm a grant;
 * the opaque challenge appears only in the prepare response and is consumed by
 * one confirm transaction. The same-OS-user trust boundary still applies.
 */

import type { SessionLookup } from "../host/session.ts"
import { sessionAtLocation } from "../watch/access.ts"
import type { WatchApplication, WatchGrantOutcome } from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"
import type { WatchGrantPayload } from "../watch/contract.ts"

export interface WatchGrantRpcDeps {
  readonly enabled: boolean
  readonly watch?: WatchApplication
  readonly sessions: SessionLookup
  readonly directory: string
}

export async function watchGrantRpc(deps: WatchGrantRpcDeps, input: unknown): Promise<WatchGrantPayload> {
  const request = readRequest(input)
  if (!request.ok) return failure(deps, "E_WATCH_INVALID", request.reason)
  if (!deps.enabled || deps.watch === undefined) {
    return failure(deps, "E_WATCH_DISABLED", "Session peers is disabled by configuration.")
  }
  if (!(await sessionAtLocation(deps.sessions, request.value.sessionID, deps.directory))) {
    return failure(deps, "E_WATCH_NOT_FOUND", `This location does not serve session "${request.value.sessionID}".`)
  }
  const watch = deps.watch
  switch (request.value.operation) {
    case "prepare":
      return payload(
        watch.prepareGrant({
          callerSessionID: request.value.sessionID,
          taskID: request.value.taskID,
          expectedVersion: request.value.expectedVersion,
        }),
      )
    case "confirm": {
      if (
        request.value.challenge === undefined ||
        request.value.generation === undefined ||
        request.value.termsDigest === undefined
      ) {
        return failure(deps, "E_WATCH_INVALID", "confirm needs challenge, generation and termsDigest")
      }
      return payload(
        watch.confirmGrant({
          callerSessionID: request.value.sessionID,
          taskID: request.value.taskID,
          expectedVersion: request.value.expectedVersion,
          generation: request.value.generation,
          termsDigest: request.value.termsDigest,
          challenge: request.value.challenge,
        }),
      )
    }
    case "downgrade":
      return payload(
        watch.downgradeGrant({
          callerSessionID: request.value.sessionID,
          taskID: request.value.taskID,
          expectedVersion: request.value.expectedVersion,
        }),
      )
  }
}

interface Request {
  readonly operation: "prepare" | "confirm" | "downgrade"
  readonly sessionID: string
  readonly taskID: string
  readonly expectedVersion: number
  readonly challenge?: string
  readonly generation?: number
  readonly termsDigest?: string
}

type Parsed = { readonly ok: true; readonly value: Request } | { readonly ok: false; readonly reason: string }

function readRequest(input: unknown): Parsed {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "the watchGrant method needs an object" }
  }
  const record = input as Record<string, unknown>
  const operation = record["operation"]
  if (operation !== "prepare" && operation !== "confirm" && operation !== "downgrade") {
    return { ok: false, reason: "operation must be prepare, confirm or downgrade" }
  }
  const sessionID = readString(record["sessionID"])
  const taskID = readString(record["taskID"])
  const expectedVersion = record["expectedVersion"]
  if (sessionID === undefined || taskID === undefined) {
    return { ok: false, reason: "sessionID and taskID must be non-empty strings" }
  }
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, reason: "expectedVersion must be a positive integer" }
  }
  const challenge = readString(record["challenge"])
  const termsDigest = readString(record["termsDigest"])
  const generation = record["generation"]
  if (
    generation !== undefined &&
    (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
  ) {
    return { ok: false, reason: "generation must be a positive integer" }
  }
  if (operation === "confirm" && (challenge === undefined || termsDigest === undefined || generation === undefined)) {
    return { ok: false, reason: "confirm needs challenge, generation and termsDigest" }
  }
  return {
    ok: true,
    value: {
      operation,
      sessionID,
      taskID,
      expectedVersion,
      ...(challenge === undefined ? {} : { challenge }),
      ...(generation === undefined ? {} : { generation }),
      ...(termsDigest === undefined ? {} : { termsDigest }),
    },
  }
}

function payload(outcome: WatchGrantOutcome): WatchGrantPayload {
  return {
    ok: outcome.ok,
    challenge: outcome.challenge,
    task: outcome.task,
    capability: outcome.capability,
    controls: outcome.controls,
    failure:
      outcome.failure === null
        ? null
        : {
            code: outcome.failure.code,
            reason: outcome.failure.reason,
            detail: outcome.failure.detail ?? null,
          },
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function failure(deps: WatchGrantRpcDeps, code: "E_WATCH_INVALID" | "E_WATCH_DISABLED" | "E_WATCH_NOT_FOUND", reason: string): WatchGrantPayload {
  return {
    ok: false,
    challenge: null,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    failure: { code, reason, detail: null },
  }
}
