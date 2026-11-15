/**
 * The watchdog's RPC contract.
 *
 * It lives beside the server implementation but imports only the domain types:
 * a TUI or another plugin can depend on `./rpc`, which re-exports this shape,
 * without importing the ledger or the host layer. The reader below is the same
 * kind of guard as `readRosterPayload`: the transport hands back `unknown`, and
 * a panel that rendered a malformed answer as a task would be lying.
 */

import type {
  WatchCapability,
  WatchControl,
  WatchControls,
  WatchEvidence,
  WatchFailureCode,
  WatchReportKind,
  WatchReportView,
  WatchTaskView,
  WatchWaitKind,
} from "../domain/watch.ts"

export interface WatchLedgerView {
  readonly available: boolean
  readonly reason: string | null
}

export interface WatchFailureView {
  readonly code: WatchFailureCode
  readonly reason: string
  readonly detail: string | null
}

/** The one answer the `watch` RPC method returns, for every operation. */
export interface WatchPayload {
  /** False when the plugin is off at the answering location. */
  readonly enabled: boolean
  readonly ledger: WatchLedgerView
  /**
   * The current task, or `null` when none is enrolled. A `failure` with
   * `task: null` does not mean the task disappeared: it means this call did not
   * return a fresh snapshot. The panel should report the failure and re-read
   * rather than clearing what it already shows.
   */
  readonly task: WatchTaskView | null
  readonly capability: WatchCapability
  readonly controls: WatchControls
  readonly failure: WatchFailureView | null
}

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    reference: { type: "string" },
    waitKind: { type: "string", enum: ["human", "peer", "permission", "form", "child", "other"] },
    waitFor: { type: "string" },
    reason: { type: "string" },
  },
} as const

const attemptsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    used: { type: "number" },
    limit: { type: "number" },
  },
  required: ["used", "limit"],
} as const

const pauseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["manual", "safety"] },
    reason: { type: "string" },
  },
  required: ["kind", "reason"],
} as const

const reportViewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reportID: { type: "string" },
    kind: { type: "string", enum: ["begin", "progress", "waiting", "blocked", "completed"] },
    evidence: evidenceSchema,
    at: { type: "number" },
    version: { type: "number" },
  },
  required: ["reportID", "kind", "evidence", "at", "version"],
} as const

export const watchTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskID: { type: "string" },
    initiatorSessionID: { type: "string" },
    targetSessionID: { type: "string" },
    goal: { type: "string" },
    mode: { type: "string", enum: ["alert"] },
    watchState: { type: "string", enum: ["active", "paused", "ended"] },
    taskState: { type: "string", enum: ["not-started", "in-progress", "waiting", "blocked", "completed"] },
    version: { type: "number" },
    generation: { type: "number" },
    ownership: { type: "string", enum: ["this-instance", "another-activation"] },
    participation: { type: "string", enum: ["not-seen", "seen"] },
    attempts: attemptsSchema,
    pause: { ...pauseSchema, type: ["object", "null"] },
    lastReport: { ...reportViewSchema, type: ["object", "null"] },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    completedAt: { type: ["number", "null"] },
    endedAt: { type: ["number", "null"] },
  },
  required: [
    "taskID",
    "initiatorSessionID",
    "targetSessionID",
    "goal",
    "mode",
    "watchState",
    "taskState",
    "version",
    "generation",
    "ownership",
    "participation",
    "attempts",
    "pause",
    "lastReport",
    "createdAt",
    "updatedAt",
    "completedAt",
    "endedAt",
  ],
} as const

const controlSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    reason: { type: ["string", "null"] },
  },
  required: ["enabled", "reason"],
} as const

const capabilitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["alert"] },
    monitoring: { type: "string", enum: ["participant-reports-only"] },
    automaticDetection: { type: "string", enum: ["unavailable"] },
    automaticDetectionReason: { type: "string" },
    correction: { type: "string", enum: ["unavailable"] },
    correctionReason: { type: "string" },
    delegation: { type: "string", enum: ["unavailable"] },
    delegationReason: { type: "string" },
    transfer: { type: "string", enum: ["unavailable"] },
    transferReason: { type: "string" },
    recovery: { type: "string", enum: ["unavailable"] },
    recoveryReason: { type: "string" },
    safetyPause: { type: "string", enum: ["unavailable"] },
    safetyPauseReason: { type: "string" },
  },
  required: [
    "mode",
    "monitoring",
    "automaticDetection",
    "automaticDetectionReason",
    "correction",
    "correctionReason",
    "delegation",
    "delegationReason",
    "transfer",
    "transferReason",
    "recovery",
    "recoveryReason",
    "safetyPause",
    "safetyPauseReason",
  ],
} as const

const controlsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pause: controlSchema,
    end: controlSchema,
    resume: controlSchema,
    correction: controlSchema,
    transfer: controlSchema,
  },
  required: ["pause", "end", "resume", "correction", "transfer"],
} as const

const ledgerSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    available: { type: "boolean" },
    reason: { type: ["string", "null"] },
  },
  required: ["available", "reason"],
} as const

const failureSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    reason: { type: "string" },
    detail: { type: ["string", "null"] },
  },
  required: ["code", "reason", "detail"],
} as const

export const watchRpcMethod = {
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: ["show", "enroll", "pause", "end"] },
      sessionID: { type: "string", minLength: 1 },
      taskID: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      requestId: { type: "string", minLength: 1 },
      goal: { type: "string", minLength: 1 },
      targetSessionID: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["alert", "correct"] },
    },
    required: ["operation", "sessionID"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      ledger: ledgerSchema,
      task: { ...watchTaskSchema, type: ["object", "null"] },
      capability: capabilitySchema,
      controls: controlsSchema,
      failure: { ...failureSchema, type: ["object", "null"] },
    },
    required: ["enabled", "ledger", "task", "capability", "controls", "failure"],
  },
} as const

export const watchChangedEvent = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { at: { type: "number" } },
    required: ["at"],
  },
} as const

/**
 * Reads one `watch` answer, or `undefined` when it is not the documented shape.
 * The panel then shows its own "not understood" state rather than an empty task.
 */
export function readWatchPayload(value: unknown): WatchPayload | undefined {
  const payload = asRecord(value)
  if (payload === undefined) return undefined
  const enabled = payload["enabled"]
  const ledger = readLedger(payload["ledger"])
  const task = payload["task"] === null ? null : readTask(payload["task"])
  const capability = readCapability(payload["capability"])
  const controls = readControls(payload["controls"])
  const failure = payload["failure"] === null ? null : readFailure(payload["failure"])
  if (typeof enabled !== "boolean" || ledger === undefined || task === undefined) return undefined
  if (capability === undefined || controls === undefined || failure === undefined) return undefined
  return { enabled, ledger, task, capability, controls, failure }
}

function readLedger(value: unknown): WatchLedgerView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const available = record["available"]
  const reason = record["reason"]
  if (typeof available !== "boolean" || !isStringOrNull(reason)) return undefined
  return { available, reason }
}

function readTask(value: unknown): WatchTaskView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const taskID = record["taskID"]
  const initiatorSessionID = record["initiatorSessionID"]
  const targetSessionID = record["targetSessionID"]
  const goal = record["goal"]
  const mode = record["mode"]
  const watchState = record["watchState"]
  const taskState = record["taskState"]
  const version = record["version"]
  const generation = record["generation"]
  const ownership = record["ownership"]
  const participation = record["participation"]
  const attempts = readAttempts(record["attempts"])
  const pause = record["pause"] === null ? null : readPause(record["pause"])
  const createdAt = record["createdAt"]
  const updatedAt = record["updatedAt"]
  const completedAt = record["completedAt"]
  const endedAt = record["endedAt"]
  if (
    typeof taskID !== "string" ||
    typeof initiatorSessionID !== "string" ||
    typeof targetSessionID !== "string" ||
    typeof goal !== "string" ||
    mode !== "alert" ||
    !isWatchState(watchState) ||
    !isTaskState(taskState) ||
    typeof version !== "number" ||
    typeof generation !== "number" ||
    (ownership !== "this-instance" && ownership !== "another-activation") ||
    (participation !== "not-seen" && participation !== "seen") ||
    attempts === undefined ||
    pause === undefined ||
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number" ||
    !isNumberOrNull(completedAt) ||
    !isNumberOrNull(endedAt)
  ) {
    return undefined
  }
  const lastReport = record["lastReport"] === null ? null : readReport(record["lastReport"])
  if (lastReport === undefined) return undefined
  return {
    taskID,
    initiatorSessionID,
    targetSessionID,
    goal,
    mode: "alert",
    watchState,
    taskState,
    version,
    generation,
    ownership,
    participation,
    attempts,
    pause,
    lastReport,
    createdAt,
    updatedAt,
    completedAt,
    endedAt,
  }
}

function readAttempts(value: unknown): { readonly used: number; readonly limit: number } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const used = record["used"]
  const limit = record["limit"]
  if (typeof used !== "number" || typeof limit !== "number") return undefined
  return { used, limit }
}

function readPause(value: unknown): { readonly kind: "manual" | "safety"; readonly reason: string } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const kind = record["kind"]
  const reason = record["reason"]
  if ((kind !== "manual" && kind !== "safety") || typeof reason !== "string") return undefined
  return { kind, reason }
}

function readReport(value: unknown): WatchReportView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const reportID = record["reportID"]
  const kind = record["kind"]
  const evidence = readEvidence(record["evidence"])
  const at = record["at"]
  const version = record["version"]
  if (typeof reportID !== "string" || !isReportKind(kind) || evidence === undefined) return undefined
  if (typeof at !== "number" || typeof version !== "number") return undefined
  return { reportID, kind, evidence, at, version }
}

function readEvidence(value: unknown): WatchEvidence | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const summary = record["summary"]
  const reference = record["reference"]
  const waitKind = record["waitKind"]
  const waitFor = record["waitFor"]
  const reason = record["reason"]
  if (
    (summary !== undefined && typeof summary !== "string") ||
    (reference !== undefined && typeof reference !== "string") ||
    (waitFor !== undefined && typeof waitFor !== "string") ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    return undefined
  }
  if (waitKind !== undefined && !isWaitKind(waitKind)) return undefined
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(reference === undefined ? {} : { reference }),
    ...(waitKind === undefined ? {} : { waitKind }),
    ...(waitFor === undefined ? {} : { waitFor }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function readCapability(value: unknown): WatchCapability | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const {
    mode,
    monitoring,
    automaticDetection,
    automaticDetectionReason,
    correction,
    correctionReason,
    delegation,
    delegationReason,
    transfer,
    transferReason,
    recovery,
    recoveryReason,
    safetyPause,
    safetyPauseReason,
  } = record
  if (
    mode !== "alert" ||
    monitoring !== "participant-reports-only" ||
    automaticDetection !== "unavailable" ||
    typeof automaticDetectionReason !== "string" ||
    correction !== "unavailable" ||
    typeof correctionReason !== "string" ||
    delegation !== "unavailable" ||
    typeof delegationReason !== "string" ||
    transfer !== "unavailable" ||
    typeof transferReason !== "string" ||
    recovery !== "unavailable" ||
    typeof recoveryReason !== "string" ||
    safetyPause !== "unavailable" ||
    typeof safetyPauseReason !== "string"
  ) {
    return undefined
  }
  return {
    mode,
    monitoring,
    automaticDetection,
    automaticDetectionReason,
    correction,
    correctionReason,
    delegation,
    delegationReason,
    transfer,
    transferReason,
    recovery,
    recoveryReason,
    safetyPause,
    safetyPauseReason,
  }
}

function readControls(value: unknown): WatchControls | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const pause = readControl(record["pause"])
  const end = readControl(record["end"])
  const resume = readControl(record["resume"])
  const correction = readControl(record["correction"])
  const transfer = readControl(record["transfer"])
  if (pause === undefined || end === undefined || resume === undefined) return undefined
  if (correction === undefined || transfer === undefined) return undefined
  return { pause, end, resume, correction, transfer }
}

function readControl(value: unknown): WatchControl | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const enabled = record["enabled"]
  const reason = record["reason"]
  if (typeof enabled !== "boolean" || !isStringOrNull(reason)) return undefined
  return { enabled, reason }
}

function readFailure(value: unknown): WatchFailureView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const code = record["code"]
  const reason = record["reason"]
  const detail = record["detail"]
  if (typeof code !== "string" || typeof reason !== "string" || !isStringOrNull(detail)) return undefined
  return { code: code as WatchFailureCode, reason, detail }
}

function isWatchState(value: unknown): value is WatchTaskView["watchState"] {
  return value === "active" || value === "paused" || value === "ended"
}

function isTaskState(value: unknown): value is WatchTaskView["taskState"] {
  return (
    value === "not-started" || value === "in-progress" || value === "waiting" || value === "blocked" || value === "completed"
  )
}

function isReportKind(value: unknown): value is WatchReportKind {
  return value === "begin" || value === "progress" || value === "waiting" || value === "blocked" || value === "completed"
}

function isWaitKind(value: unknown): value is WatchWaitKind {
  return value === "human" || value === "peer" || value === "permission" || value === "form" || value === "child" || value === "other"
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
