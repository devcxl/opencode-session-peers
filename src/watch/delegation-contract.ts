/**
 * The controlled delegation RPC contract.
 *
 * It is a sibling of `watchGrant`, not a widening of it. The model-facing tool
 * never reaches these methods: they exist for the controlled panel, and the
 * same-OS-user boundary is still not human authentication. The challenge is
 * returned only by prepare; the normal child view contains no nonce, digest or
 * confirmation id.
 */

import type {
  WatchCapability,
  WatchControls,
  WatchFailure,
  WatchMode,
  WatchTaskView,
} from "../domain/watch.ts"
import { WATCH_CORRECTION_TERMS } from "../domain/watch.ts"
import type { DelegatedChildView, WatchDelegationView } from "./delegation-view.ts"
import { WATCH_DELEGATION_TERMS } from "./delegation.ts"

export interface DelegationChallengeView {
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

export interface DelegationReviewView {
  readonly delegationTerms: string
  readonly correctionTerms: string
  readonly deploymentRequired: boolean
}

export interface WatchDelegationGrantPayload {
  readonly ok: boolean
  readonly challenge: DelegationChallengeView | null
  readonly grant: {
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
  } | null
  readonly task: WatchTaskView | null
  readonly capability: WatchCapability
  readonly controls: WatchControls
  readonly review: DelegationReviewView
  readonly failure: WatchFailure | null
}

export interface WatchDelegationViewPayload extends WatchDelegationView {
  readonly failure: { readonly code: string; readonly reason: string } | null
}

const delegationGrantViewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    grantID: { type: "string" },
    parentTaskID: { type: "string" },
    parentSessionID: { type: "string" },
    mode: { type: "string", enum: ["alert", "limited-correction"] },
    state: { type: "string", enum: ["granted", "revoked"] },
    version: { type: "integer", minimum: 1 },
    generation: { type: "integer", minimum: 1 },
    targetSessionID: { type: "string" },
    scopeDirectory: { type: "string" },
    scopePeerScope: { type: "string" },
    reviewSummary: { type: "string" },
    deployment: { type: ["string", "null"], enum: ["single-host-same-location", null] },
    grantedAt: { type: "number" },
    revokedAt: { type: ["number", "null"] },
  },
  required: [
    "grantID",
    "parentTaskID",
    "parentSessionID",
    "mode",
    "state",
    "version",
    "generation",
    "targetSessionID",
    "scopeDirectory",
    "scopePeerScope",
    "reviewSummary",
    "deployment",
    "grantedAt",
    "revokedAt",
  ],
} as const

const challengeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    challenge: { type: "string", minLength: 1 },
    parentTaskID: { type: "string", minLength: 1 },
    expectedVersion: { type: "integer", minimum: 1 },
    generation: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["alert", "limited-correction"] },
    targetSessionID: { type: "string", minLength: 1 },
    scopeDirectory: { type: "string", minLength: 1 },
    scopePeerScope: { type: "string", minLength: 1 },
    deployment: { type: "string", enum: ["single-host-same-location"] },
    termsDigest: { type: "string", minLength: 1 },
    reviewSummary: { type: "string" },
    expiresAt: { type: "integer", minimum: 0 },
  },
  required: [
    "challenge",
    "parentTaskID",
    "expectedVersion",
    "generation",
    "mode",
    "targetSessionID",
    "scopeDirectory",
    "scopePeerScope",
    "termsDigest",
    "reviewSummary",
    "expiresAt",
  ],
} as const

export const watchDelegationRpcMethod = {
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: ["prepare", "confirm", "revoke"] },
      sessionID: { type: "string", minLength: 1 },
      parentTaskID: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      targetSessionID: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["alert", "limited-correction"] },
      deployment: { type: "string", enum: ["single-host-same-location"] },
      challenge: { type: "string", minLength: 1 },
      generation: { type: "integer", minimum: 1 },
      termsDigest: { type: "string", minLength: 1 },
      scopeDirectory: { type: "string", minLength: 1 },
      scopePeerScope: { type: "string", minLength: 1 },
    },
    required: ["operation", "sessionID", "parentTaskID", "expectedVersion"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      challenge: { ...challengeSchema, type: ["object", "null"] },
      grant: { ...delegationGrantViewSchema, type: ["object", "null"] },
      task: { type: ["object", "null"] },
      capability: { type: "object" },
      controls: { type: "object" },
      review: {
        type: "object",
        additionalProperties: false,
        properties: {
          delegationTerms: { type: "string" },
          correctionTerms: { type: "string" },
          deploymentRequired: { type: "boolean" },
        },
        required: ["delegationTerms", "correctionTerms", "deploymentRequired"],
      },
      failure: { type: ["object", "null"] },
    },
    required: ["ok", "challenge", "grant", "task", "capability", "controls", "review", "failure"],
  },
} as const

export const watchDelegationViewRpcMethod = {
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionID: { type: "string", minLength: 1 },
      parentTaskID: { type: "string", minLength: 1 },
    },
    required: ["sessionID", "parentTaskID"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      parentTaskID: { type: "string" },
      parentSessionID: { type: "string" },
      grants: { type: "array", items: delegationGrantViewSchema },
      children: { type: "array" },
      failure: { type: ["object", "null"] },
    },
    required: ["ok", "parentTaskID", "parentSessionID", "grants", "children", "failure"],
  },
} as const

export function readWatchDelegationGrantPayload(value: unknown): WatchDelegationGrantPayload | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (
    !onlyKeys(record, [
      "ok",
      "challenge",
      "grant",
      "task",
      "capability",
      "controls",
      "review",
      "failure",
    ])
  ) {
    return undefined
  }
  const ok = record["ok"]
  const challenge = record["challenge"] === null ? null : readChallenge(record["challenge"])
  const grant = record["grant"] === null ? null : readGrant(record["grant"])
  const task = record["task"] === null ? null : readTask(record["task"])
  const capability = readCapability(record["capability"])
  const controls = readControls(record["controls"])
  const review = readReview(record["review"])
  const failure = record["failure"] === null ? null : readFailure(record["failure"])
  if (typeof ok !== "boolean" || challenge === undefined || grant === undefined) return undefined
  if (task === undefined || capability === undefined || controls === undefined) return undefined
  if (review === undefined || failure === undefined) return undefined
  return { ok, challenge, grant, task, capability, controls, review, failure }
}

export function readWatchDelegationViewPayload(value: unknown): WatchDelegationViewPayload | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (!onlyKeys(record, ["ok", "parentTaskID", "parentSessionID", "grants", "children", "failure"])) {
    return undefined
  }
  const ok = record["ok"]
  const parentTaskID = record["parentTaskID"]
  const parentSessionID = record["parentSessionID"]
  const failure = record["failure"] === null ? null : readViewFailure(record["failure"])
  if (typeof ok !== "boolean" || typeof parentTaskID !== "string" || typeof parentSessionID !== "string") {
    return undefined
  }
  if (failure === undefined) return undefined
  if (!Array.isArray(record["grants"]) || !Array.isArray(record["children"])) return undefined
  const grants = record["grants"].map(readGrant)
  if (grants.some((grant) => grant === undefined)) return undefined
  const children = record["children"].map(readChild)
  if (children.some((child) => child === undefined)) return undefined
  return {
    ok,
    parentTaskID,
    parentSessionID,
    grants: grants as NonNullable<(typeof grants)[number]>[],
    children: children as NonNullable<(typeof children)[number]>[],
    failure,
  }
}

function readChallenge(value: unknown): DelegationChallengeView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (
    !onlyKeys(record, [
      "challenge",
      "parentTaskID",
      "expectedVersion",
      "generation",
      "mode",
      "targetSessionID",
      "scopeDirectory",
      "scopePeerScope",
      "deployment",
      "termsDigest",
      "reviewSummary",
      "expiresAt",
    ])
  ) {
    return undefined
  }
  const challenge = record["challenge"]
  const parentTaskID = record["parentTaskID"]
  const expectedVersion = record["expectedVersion"]
  const generation = record["generation"]
  const mode = record["mode"]
  const targetSessionID = record["targetSessionID"]
  const scopeDirectory = record["scopeDirectory"]
  const scopePeerScope = record["scopePeerScope"]
  const termsDigest = record["termsDigest"]
  const reviewSummary = record["reviewSummary"]
  const expiresAt = record["expiresAt"]
  const deployment = record["deployment"]
  if (
    typeof challenge !== "string" ||
    typeof parentTaskID !== "string" ||
    typeof targetSessionID !== "string" ||
    typeof scopeDirectory !== "string" ||
    typeof scopePeerScope !== "string" ||
    typeof termsDigest !== "string" ||
    typeof reviewSummary !== "string" ||
    !isPositiveInteger(expectedVersion) ||
    !isPositiveInteger(generation) ||
    !isTimestamp(expiresAt) ||
    (mode !== "alert" && mode !== "limited-correction")
  ) {
    return undefined
  }
  if (deployment !== undefined && deployment !== "single-host-same-location") return undefined
  if (reviewSummary !== WATCH_DELEGATION_TERMS) return undefined
  return {
    challenge,
    parentTaskID,
    expectedVersion,
    generation,
    mode,
    targetSessionID,
    scopeDirectory,
    scopePeerScope,
    ...(deployment === undefined ? {} : { deployment }),
    termsDigest,
    reviewSummary,
    expiresAt,
  }
}

function readGrant(value: unknown): WatchDelegationGrantPayload["grant"] | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (
    !onlyKeys(record, [
      "grantID",
      "parentTaskID",
      "parentSessionID",
      "mode",
      "state",
      "version",
      "generation",
      "targetSessionID",
      "scopeDirectory",
      "scopePeerScope",
      "reviewSummary",
      "deployment",
      "grantedAt",
      "revokedAt",
    ])
  ) {
    return undefined
  }
  const grantID = record["grantID"]
  const parentTaskID = record["parentTaskID"]
  const parentSessionID = record["parentSessionID"]
  const mode = record["mode"]
  const state = record["state"]
  const version = record["version"]
  const generation = record["generation"]
  const targetSessionID = record["targetSessionID"]
  const scopeDirectory = record["scopeDirectory"]
  const scopePeerScope = record["scopePeerScope"]
  const reviewSummary = record["reviewSummary"]
  const deployment = record["deployment"]
  const grantedAt = record["grantedAt"]
  const revokedAt = record["revokedAt"]
  if (
    typeof grantID !== "string" ||
    typeof parentTaskID !== "string" ||
    typeof parentSessionID !== "string" ||
    typeof targetSessionID !== "string" ||
    typeof scopeDirectory !== "string" ||
    typeof scopePeerScope !== "string" ||
    typeof reviewSummary !== "string" ||
    !isPositiveInteger(version) ||
    !isPositiveInteger(generation) ||
    !isTimestamp(grantedAt) ||
    !isTimestampOrNull(revokedAt) ||
    (mode !== "alert" && mode !== "limited-correction") ||
    (state !== "granted" && state !== "revoked") ||
    (deployment !== null && deployment !== "single-host-same-location")
  ) {
    return undefined
  }
  if (reviewSummary !== WATCH_DELEGATION_TERMS) return undefined
  return {
    grantID,
    parentTaskID,
    parentSessionID,
    mode,
    state,
    version,
    generation,
    targetSessionID,
    scopeDirectory,
    scopePeerScope,
    reviewSummary,
    deployment,
    grantedAt,
    revokedAt,
  }
}

function readTask(value: unknown): WatchTaskView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  // The existing task contract validates the full shape at the panel boundary;
  // this reader only refuses a missing identity or a non-object here.
  const taskID = record["taskID"]
  const initiatorSessionID = record["initiatorSessionID"]
  const targetSessionID = record["targetSessionID"]
  const goal = record["goal"]
  if (typeof taskID !== "string" || typeof initiatorSessionID !== "string") return undefined
  if (typeof targetSessionID !== "string" || typeof goal !== "string") return undefined
  return record as unknown as WatchTaskView
}

function readCapability(value: unknown): WatchCapability | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record["mode"] !== "string" || typeof record["monitoring"] !== "string") return undefined
  return record as unknown as WatchCapability
}

function readControls(value: unknown): WatchControls | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record["pause"] !== "object" && typeof record["pause"] !== "boolean") return undefined
  return record as unknown as WatchControls
}

function readReview(value: unknown): DelegationReviewView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (!onlyKeys(record, ["delegationTerms", "correctionTerms", "deploymentRequired"])) return undefined
  const delegationTerms = record["delegationTerms"]
  const correctionTerms = record["correctionTerms"]
  const deploymentRequired = record["deploymentRequired"]
  if (
    delegationTerms !== WATCH_DELEGATION_TERMS ||
    correctionTerms !== WATCH_CORRECTION_TERMS ||
    typeof deploymentRequired !== "boolean"
  ) {
    return undefined
  }
  return { delegationTerms, correctionTerms, deploymentRequired }
}

function readFailure(value: unknown): WatchFailure | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (!onlyKeys(record, ["code", "reason", "detail"])) return undefined
  const code = record["code"]
  const reason = record["reason"]
  if (typeof code !== "string" || typeof reason !== "string") return undefined
  const detail = record["detail"]
  if (detail !== undefined && typeof detail !== "string") return undefined
  return { code: code as WatchFailure["code"], reason, ...(detail === undefined ? {} : { detail }) }
}

function readViewFailure(value: unknown): { readonly code: string; readonly reason: string } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (!onlyKeys(record, ["code", "reason"])) return undefined
  if (typeof record["code"] !== "string" || typeof record["reason"] !== "string") return undefined
  return { code: record["code"], reason: record["reason"] }
}

function readChild(value: unknown): DelegatedChildView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const taskID = record["taskID"]
  const parentTaskID = record["parentTaskID"]
  const parentSessionID = record["parentSessionID"]
  const targetSessionID = record["targetSessionID"]
  const authorized = record["authorized"]
  const authorization = asRecord(record["authorization"])
  if (!onlyKeys(record, ["taskID", "parentTaskID", "parentSessionID", "targetSessionID", "authorized", "authorization", "task", "alerts"])) {
    return undefined
  }
  if (
    authorization !== undefined &&
    !onlyKeys(authorization, [
      "allowed",
      "reason",
      "grantID",
      "grantVersion",
      "mode",
      "scopeDirectory",
      "scopePeerScope",
      "scopeSource",
      "checkedAt",
    ])
  ) {
    return undefined
  }
  if (
    typeof taskID !== "string" ||
    typeof parentTaskID !== "string" ||
    typeof parentSessionID !== "string" ||
    typeof targetSessionID !== "string" ||
    typeof authorized !== "boolean" ||
    authorization === undefined
  ) {
    return undefined
  }
  const allowed = authorization["allowed"]
  const reason = authorization["reason"]
  const grantID = authorization["grantID"]
  const grantVersion = authorization["grantVersion"]
  const mode = authorization["mode"]
  const scopeDirectory = authorization["scopeDirectory"]
  const scopePeerScope = authorization["scopePeerScope"]
  const scopeSource = authorization["scopeSource"]
  const checkedAt = authorization["checkedAt"]
  if (
    typeof allowed !== "boolean" ||
    (reason !== null && typeof reason !== "string") ||
    (grantID !== null && typeof grantID !== "string") ||
    (grantVersion !== null && typeof grantVersion !== "number") ||
    (mode !== null && mode !== "alert" && mode !== "limited-correction") ||
    (scopeDirectory !== null && typeof scopeDirectory !== "string") ||
    (scopePeerScope !== null && typeof scopePeerScope !== "string") ||
    (scopeSource !== "recorded" && scopeSource !== "configured" && scopeSource !== "unknown") ||
    !isTimestamp(checkedAt)
  ) {
    return undefined
  }
  const task = record["task"] === null ? null : readTask(record["task"])
  const alerts = record["alerts"] === null ? null : asRecord(record["alerts"])
  if (task === undefined || alerts === undefined) return undefined
  if (!authorized && (task !== null || alerts !== null)) return undefined
  return {
    taskID,
    parentTaskID,
    parentSessionID,
    targetSessionID,
    authorized,
    authorization: {
      allowed,
      reason,
      grantID,
      grantVersion,
      mode,
      scopeDirectory,
      scopePeerScope,
      scopeSource,
      checkedAt,
    },
    task,
    alerts: alerts === null ? null : (alerts as unknown as DelegatedChildView["alerts"]),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || isTimestamp(value)
}
