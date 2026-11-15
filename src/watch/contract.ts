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
  WatchActivityView,
  WatchAlertView,
  WatchAlertsView,
  WatchCapability,
  WatchControl,
  WatchControls,
  WatchCorrectionAttemptPhase,
  WatchCorrectionAttemptView,
  WatchCorrectionGateView,
  WatchCorrectionGrantMode,
  WatchCorrectionGrantState,
  WatchCorrectionGrantView,
  WatchCorrectionRecoveryView,
  WatchCorrectionStopReason,
  WatchCorrectionView,
  WatchEvidence,
  WatchFailureCode,
  WatchObservationView,
  WatchReportKind,
  WatchReportView,
  WatchTaskView,
  WatchWaitKind,
  WatchWaitView,
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
  /** Current observer reading; `null` when no task is enrolled or no sample exists. */
  readonly observation: WatchObservationView | null
  /** The target's last own activity; continuous activity is never judged as progress. */
  readonly activity: WatchActivityView | null
  readonly alerts: WatchAlertsView
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
    waitID: { type: "string" },
    waitUntil: { type: "integer" },
    clearsWaitID: { type: "string" },
    clearEvidence: { type: "string" },
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

const correctionControlSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    reason: { type: ["string", "null"] },
  },
  required: ["enabled", "reason"],
} as const

const correctionGrantSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["alert-only", "single-attempt"] },
    state: { type: "string", enum: ["not-granted", "pending-confirmation", "granted", "revoked"] },
    version: { type: "number" },
    reviewSummary: { type: ["string", "null"] },
    grantedAt: { type: ["number", "null"] },
  },
  required: ["mode", "state", "version", "reviewSummary", "grantedAt"],
} as const

const correctionReceiptSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    receiptID: { type: "string" },
    at: { type: "number" },
  },
  required: ["receiptID", "at"],
} as const

const correctionRecoverySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    progressReportID: { type: "string" },
    resultReference: { type: "string" },
    at: { type: "number" },
  },
  required: ["progressReportID", "resultReference", "at"],
} as const

const correctionAttemptSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    attemptID: { type: "string" },
    ordinal: { type: "number" },
    phase: { type: "string", enum: ["reserved", "sending", "accepted", "rejected", "unknown", "receipted", "recovered"] },
    reservedAt: { type: "number" },
    claimedAt: { type: ["number", "null"] },
    acceptedAt: { type: ["number", "null"] },
    rejectedAt: { type: ["number", "null"] },
    unknownAt: { type: ["number", "null"] },
    receipt: { ...correctionReceiptSchema, type: ["object", "null"] },
    recovery: { ...correctionRecoverySchema, type: ["object", "null"] },
    stopReason: {
      type: ["string", "null"],
      enum: [
        "grant-missing",
        "grant-pending",
        "grant-expired",
        "attempt-limit",
        "session-unresolved",
        "reservation-pending",
        "sending-unaccounted",
        "accepted-without-receipt",
        "unknown-result",
        "receipted-awaiting-recovery",
        "rejected",
        "recovered",
        "runtime-unsupported",
        "single-host-unconfirmed",
        "cross-location",
        "protocol-unseen",
        "task-paused",
        "task-ended",
        "task-completed",
        "observation-untrusted",
        "normal-wait",
        "observation-gap",
        "executor-unavailable",
        null,
      ],
    },
  },
  required: [
    "attemptID",
    "ordinal",
    "phase",
    "reservedAt",
    "claimedAt",
    "acceptedAt",
    "rejectedAt",
    "unknownAt",
    "receipt",
    "recovery",
    "stopReason",
  ],
} as const

const correctionGateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    gate: { type: "string", enum: ["grant", "attempts", "pending-attempt", "business-unfinished", "executor"] },
    ok: { type: "boolean" },
    reason: { type: ["string", "null"] },
  },
  required: ["gate", "ok", "reason"],
} as const

const correctionStopSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string" },
    missingEvidence: { type: ["string", "null"] },
  },
  required: ["reason", "missingEvidence"],
} as const

const correctionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    authorization: correctionGrantSchema,
    actual: { type: "string", enum: ["unavailable", "ready"] },
    actualReason: { type: "string" },
    attempts: attemptsSchema,
    phase: {
      type: "string",
      enum: ["idle", "reserved", "sending", "accepted", "rejected", "unknown", "receipted", "recovered"],
    },
    pending: { ...correctionAttemptSchema, type: ["object", "null"] },
    last: { ...correctionAttemptSchema, type: ["object", "null"] },
    history: { type: "array", items: correctionAttemptSchema },
    stop: { ...correctionStopSchema, type: ["object", "null"] },
    gates: { type: "array", items: correctionGateSchema },
    businessCompleted: { type: "boolean" },
    controls: {
      type: "object",
      additionalProperties: false,
      properties: {
        grant: correctionControlSchema,
        downgrade: correctionControlSchema,
      },
      required: ["grant", "downgrade"],
    },
  },
  required: [
    "authorization",
    "actual",
    "actualReason",
    "attempts",
    "phase",
    "pending",
    "last",
    "history",
    "stop",
    "gates",
    "businessCompleted",
    "controls",
  ],
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
    correction: correctionSchema,
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
    "correction",
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
    monitoring: { type: "string", enum: ["observer-alerts"] },
    automaticDetection: { type: "string", enum: ["partial"] },
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
    acknowledge: controlSchema,
    resume: controlSchema,
    correction: controlSchema,
    transfer: controlSchema,
  },
  required: ["pause", "end", "acknowledge", "resume", "correction", "transfer"],
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

const waitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    waitID: { type: "string" },
    source: { type: "string", enum: ["permission", "form", "retry", "ask", "reported"] },
    object: { type: "string" },
    reason: { type: "string" },
    reference: { type: ["string", "null"] },
    startedAt: { type: "number" },
    deadline: { type: ["number", "null"] },
    status: { type: "string", enum: ["active", "overdue", "cleared", "denied", "unknown"] },
    clearEvidence: { type: ["string", "null"] },
    denyEvidence: { type: ["string", "null"] },
  },
  required: [
    "waitID",
    "source",
    "object",
    "reason",
    "reference",
    "startedAt",
    "deadline",
    "status",
    "clearEvidence",
    "denyEvidence",
  ],
} as const

const thresholdsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    idleMs: { type: "number" },
    runningSilentMs: { type: "number" },
    waitOverdueMs: { type: "number" },
  },
  required: ["idleMs", "runningSilentMs", "waitOverdueMs"],
} as const

const observationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: {
      type: "string",
      enum: ["active", "idle-candidate", "running-silence", "normal-waiting", "blocked", "unknown", "unavailable"],
    },
    reason: { type: ["string", "null"] },
    observedAt: { type: ["number", "null"] },
    baselineAt: { type: ["number", "null"] },
    idleSince: { type: ["number", "null"] },
    trusted: { type: "boolean" },
    waits: { type: "array", items: waitSchema },
    waitsPartial: { type: "boolean" },
    waitsTruncated: { type: "boolean" },
    effective: thresholdsSchema,
  },
  required: [
    "state",
    "reason",
    "observedAt",
    "baselineAt",
    "idleSince",
    "trusted",
    "waits",
    "waitsPartial",
    "waitsTruncated",
    "effective",
  ],
} as const

const activitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lastAt: { type: ["number", "null"] },
    kind: { type: ["string", "null"] },
    judgement: { type: "string", enum: ["not-judged"] },
  },
  required: ["lastAt", "kind", "judgement"],
} as const

const alertSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    alertID: { type: "string" },
    taskID: { type: "string" },
    kind: {
      type: "string",
      enum: ["idle", "blocked", "running-silent", "wait-overdue", "observation-unknown", "approval-rejected"],
    },
    state: { type: "string", enum: ["unread", "read"] },
    summary: { type: "string" },
    reason: { type: "string" },
    nextStep: { type: "string" },
    plainText: { type: "string" },
    firstAt: { type: "number" },
    updatedAt: { type: "number" },
    readAt: { type: ["number", "null"] },
    escalatedAt: { type: ["number", "null"] },
    resolvedAt: { type: ["number", "null"] },
  },
  required: [
    "alertID",
    "taskID",
    "kind",
    "state",
    "summary",
    "reason",
    "nextStep",
    "plainText",
    "firstAt",
    "updatedAt",
    "readAt",
    "escalatedAt",
    "resolvedAt",
  ],
} as const

const alertsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: { type: "array", items: alertSchema },
    unread: { type: "number" },
    total: { type: "number" },
    active: { type: "number" },
    truncated: { type: "boolean" },
    available: { type: "boolean" },
    reason: { type: ["string", "null"] },
  },
  required: ["items", "unread", "total", "active", "truncated", "available", "reason"],
} as const

export const watchRpcMethod = {
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: { type: "string", enum: ["show", "enroll", "pause", "end", "ack"] },
      sessionID: { type: "string", minLength: 1 },
      taskID: { type: "string", minLength: 1 },
      alertID: { type: "string", minLength: 1 },
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
      observation: { ...observationSchema, type: ["object", "null"] },
      activity: { ...activitySchema, type: ["object", "null"] },
      alerts: alertsSchema,
      failure: { ...failureSchema, type: ["object", "null"] },
    },
    required: ["enabled", "ledger", "task", "capability", "controls", "observation", "activity", "alerts", "failure"],
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
  const observation = payload["observation"] === null ? null : readObservation(payload["observation"])
  const activity = payload["activity"] === null ? null : readActivity(payload["activity"])
  const alerts = readAlerts(payload["alerts"])
  const failure = payload["failure"] === null ? null : readFailure(payload["failure"])
  if (typeof enabled !== "boolean" || ledger === undefined || task === undefined) return undefined
  if (capability === undefined || controls === undefined || observation === undefined) return undefined
  if (activity === undefined || alerts === undefined || failure === undefined) return undefined
  return { enabled, ledger, task, capability, controls, observation, activity, alerts, failure }
}

function readObservation(value: unknown): WatchObservationView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const state = record["state"]
  const reason = record["reason"]
  const observedAt = record["observedAt"]
  const baselineAt = record["baselineAt"]
  const idleSince = record["idleSince"]
  const trusted = record["trusted"]
  const waitsPartial = record["waitsPartial"]
  const waitsTruncated = record["waitsTruncated"]
  const effective = readThresholds(record["effective"])
  if (!isObservationState(state) || !isStringOrNull(reason) || !isNumberOrNull(observedAt)) return undefined
  if (!isNumberOrNull(baselineAt) || !isNumberOrNull(idleSince) || typeof trusted !== "boolean") return undefined
  if (typeof waitsPartial !== "boolean" || typeof waitsTruncated !== "boolean" || effective === undefined) {
    return undefined
  }
  if (!Array.isArray(record["waits"])) return undefined
  const waits: WatchWaitView[] = []
  for (const candidate of record["waits"]) {
    const wait = readWait(candidate)
    if (wait === undefined) return undefined
    waits.push(wait)
  }
  return {
    state,
    reason,
    observedAt,
    baselineAt,
    idleSince,
    trusted,
    waits,
    waitsPartial,
    waitsTruncated,
    effective,
  }
}

function readWait(value: unknown): WatchWaitView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const source = record["source"]
  const status = record["status"]
  if (
    (source !== "permission" && source !== "form" && source !== "retry" && source !== "ask" && source !== "reported") ||
    (status !== "active" && status !== "overdue" && status !== "cleared" && status !== "denied" && status !== "unknown")
  ) {
    return undefined
  }
  const waitID = record["waitID"]
  const object = record["object"]
  const reason = record["reason"]
  const reference = record["reference"]
  const startedAt = record["startedAt"]
  const deadline = record["deadline"]
  const clearEvidence = record["clearEvidence"]
  const denyEvidence = record["denyEvidence"]
  if (
    typeof waitID !== "string" ||
    typeof object !== "string" ||
    typeof reason !== "string" ||
    !isStringOrNull(reference) ||
    !isFiniteNumber(startedAt) ||
    !isNumberOrNull(deadline) ||
    !isStringOrNull(clearEvidence) ||
    !isStringOrNull(denyEvidence)
  ) {
    return undefined
  }
  return {
    waitID,
    source,
    object,
    reason,
    reference,
    startedAt,
    deadline,
    status,
    clearEvidence,
    denyEvidence,
  }
}

function readThresholds(value: unknown): { idleMs: number; runningSilentMs: number; waitOverdueMs: number } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const idleMs = record["idleMs"]
  const runningSilentMs = record["runningSilentMs"]
  const waitOverdueMs = record["waitOverdueMs"]
  if (!isFiniteNumber(idleMs) || !isFiniteNumber(runningSilentMs) || !isFiniteNumber(waitOverdueMs)) {
    return undefined
  }
  if (idleMs <= 0 || runningSilentMs <= 0 || waitOverdueMs <= 0) return undefined
  return { idleMs, runningSilentMs, waitOverdueMs }
}

function readActivity(value: unknown): WatchActivityView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const lastAt = record["lastAt"]
  const kind = record["kind"]
  const judgement = record["judgement"]
  if (!isNumberOrNull(lastAt)) return undefined
  if (
    kind !== null &&
    kind !== "text" &&
    kind !== "reasoning" &&
    kind !== "step" &&
    kind !== "tool" &&
    kind !== "shell" &&
    kind !== "execution"
  ) {
    return undefined
  }
  if (judgement !== "not-judged") return undefined
  return { lastAt, kind, judgement }
}

function readAlerts(value: unknown): WatchAlertsView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const unread = record["unread"]
  const total = record["total"]
  const active = record["active"]
  const truncated = record["truncated"]
  const available = record["available"]
  const reason = record["reason"]
  if (
    !isNonNegativeInteger(unread) ||
    !isNonNegativeInteger(total) ||
    !isNonNegativeInteger(active) ||
    unread > total ||
    active > total ||
    typeof truncated !== "boolean" ||
    typeof available !== "boolean" ||
    !isStringOrNull(reason) ||
    !Array.isArray(record["items"])
  ) {
    return undefined
  }
  const items: WatchAlertView[] = []
  for (const candidate of record["items"]) {
    const alert = readAlert(candidate)
    if (alert === undefined) return undefined
    items.push(alert)
  }
  return { items, unread, total, active, truncated, available, reason }
}

function readAlert(value: unknown): WatchAlertView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const kind = record["kind"]
  const state = record["state"]
  if (
    (kind !== "idle" &&
      kind !== "blocked" &&
      kind !== "running-silent" &&
      kind !== "wait-overdue" &&
      kind !== "observation-unknown" &&
      kind !== "approval-rejected") ||
    (state !== "unread" && state !== "read")
  ) {
    return undefined
  }
  const alertID = record["alertID"]
  const taskID = record["taskID"]
  const summary = record["summary"]
  const reason = record["reason"]
  const nextStep = record["nextStep"]
  const plainText = record["plainText"]
  const firstAt = record["firstAt"]
  const updatedAt = record["updatedAt"]
  const readAt = record["readAt"]
  const escalatedAt = record["escalatedAt"]
  const resolvedAt = record["resolvedAt"]
  if (
    typeof alertID !== "string" ||
    typeof taskID !== "string" ||
    typeof summary !== "string" ||
    typeof reason !== "string" ||
    typeof nextStep !== "string" ||
    typeof plainText !== "string" ||
    !isFiniteNumber(firstAt) ||
    !isFiniteNumber(updatedAt) ||
    !isNumberOrNull(readAt) ||
    !isNumberOrNull(escalatedAt) ||
    !isNumberOrNull(resolvedAt)
  ) {
    return undefined
  }
  return {
    alertID,
    taskID,
    kind,
    state,
    summary,
    reason,
    nextStep,
    plainText,
    firstAt,
    updatedAt,
    readAt,
    escalatedAt,
    resolvedAt,
  }
}

function isObservationState(value: unknown): value is WatchObservationView["state"] {
  return (
    value === "active" ||
    value === "idle-candidate" ||
    value === "running-silence" ||
    value === "normal-waiting" ||
    value === "blocked" ||
    value === "unknown" ||
    value === "unavailable"
  )
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
  const correction = readCorrection(record["correction"])
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
    correction === undefined ||
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
    correction,
    pause,
    lastReport,
    createdAt,
    updatedAt,
    completedAt,
    endedAt,
  }
}

function readCorrection(value: unknown): WatchCorrectionView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const authorization = readCorrectionGrant(record["authorization"])
  const actual = record["actual"]
  const actualReason = record["actualReason"]
  const attempts = readAttempts(record["attempts"])
  const phase = record["phase"]
  const pending = record["pending"] === null ? null : readCorrectionAttempt(record["pending"])
  const last = record["last"] === null ? null : readCorrectionAttempt(record["last"])
  const historyValue = record["history"]
  const stop = record["stop"] === null ? null : readCorrectionStop(record["stop"])
  const gatesValue = record["gates"]
  const businessCompleted = record["businessCompleted"]
  const controls = readCorrectionControls(record["controls"])
  if (authorization === undefined || attempts === undefined) return undefined
  if (actual !== "unavailable" && actual !== "ready") return undefined
  if (typeof actualReason !== "string") return undefined
  if (!isCorrectionPhase(phase) || phase === undefined) return undefined
  if (pending === undefined || last === undefined || stop === undefined) return undefined
  if (typeof businessCompleted !== "boolean" || controls === undefined) return undefined
  if (!Array.isArray(historyValue) || !Array.isArray(gatesValue)) return undefined
  const history: WatchCorrectionAttemptView[] = []
  for (const item of historyValue) {
    const attempt = readCorrectionAttempt(item)
    if (attempt === undefined) return undefined
    history.push(attempt)
  }
  const gates: WatchCorrectionGateView[] = []
  for (const item of gatesValue) {
    const gate = readCorrectionGate(item)
    if (gate === undefined) return undefined
    gates.push(gate)
  }
  return {
    authorization,
    actual,
    actualReason,
    attempts,
    phase,
    pending,
    last,
    history,
    stop,
    gates,
    businessCompleted,
    controls,
  }
}

function readCorrectionGrant(value: unknown): WatchCorrectionGrantView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const mode = record["mode"]
  const state = record["state"]
  const version = record["version"]
  const reviewSummary = record["reviewSummary"]
  const grantedAt = record["grantedAt"]
  if (!isCorrectionGrantMode(mode) || !isCorrectionGrantState(state)) return undefined
  if (typeof version !== "number") return undefined
  if (!isStringOrNull(reviewSummary) || !isNumberOrNull(grantedAt)) return undefined
  return { mode, state, version, reviewSummary, grantedAt }
}

function readCorrectionAttempt(value: unknown): WatchCorrectionAttemptView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const attemptID = record["attemptID"]
  const ordinal = record["ordinal"]
  const phase = record["phase"]
  const reservedAt = record["reservedAt"]
  const claimedAt = record["claimedAt"]
  const acceptedAt = record["acceptedAt"]
  const rejectedAt = record["rejectedAt"]
  const unknownAt = record["unknownAt"]
  const receipt = record["receipt"] === null ? null : readCorrectionReceipt(record["receipt"])
  const recovery = record["recovery"] === null ? null : readCorrectionRecovery(record["recovery"])
  const stopReason = record["stopReason"] === null ? null : record["stopReason"]
  if (typeof attemptID !== "string" || typeof ordinal !== "number") return undefined
  if (!isCorrectionAttemptPhase(phase) || phase === undefined) return undefined
  if (typeof reservedAt !== "number") return undefined
  if (!isNumberOrNull(claimedAt) || !isNumberOrNull(acceptedAt) || !isNumberOrNull(rejectedAt)) return undefined
  if (!isNumberOrNull(unknownAt) || receipt === undefined || recovery === undefined) return undefined
  if (stopReason !== null && !isCorrectionStopReason(stopReason)) return undefined
  return {
    attemptID,
    ordinal,
    phase,
    reservedAt,
    claimedAt,
    acceptedAt,
    rejectedAt,
    unknownAt,
    receipt,
    recovery,
    stopReason,
  }
}

function readCorrectionReceipt(value: unknown): { readonly receiptID: string; readonly at: number } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const receiptID = record["receiptID"]
  const at = record["at"]
  if (typeof receiptID !== "string" || typeof at !== "number") return undefined
  return { receiptID, at }
}

function readCorrectionRecovery(value: unknown): WatchCorrectionRecoveryView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const progressReportID = record["progressReportID"]
  const resultReference = record["resultReference"]
  const at = record["at"]
  if (typeof progressReportID !== "string" || typeof resultReference !== "string" || typeof at !== "number") {
    return undefined
  }
  return { progressReportID, resultReference, at }
}

function readCorrectionStop(
  value: unknown,
): { readonly reason: WatchCorrectionStopReason; readonly missingEvidence: string | null } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const reason = record["reason"]
  const missingEvidence = record["missingEvidence"]
  if (!isCorrectionStopReason(reason) || !isStringOrNull(missingEvidence)) return undefined
  return { reason, missingEvidence }
}

function readCorrectionGate(value: unknown): WatchCorrectionGateView | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const gate = record["gate"]
  const ok = record["ok"]
  const reason = record["reason"]
  if (
    (gate !== "grant" &&
      gate !== "attempts" &&
      gate !== "pending-attempt" &&
      gate !== "business-unfinished" &&
      gate !== "executor") ||
    typeof ok !== "boolean" ||
    !isStringOrNull(reason)
  ) {
    return undefined
  }
  return { gate, ok, reason }
}

function readCorrectionControls(value: unknown): { readonly grant: WatchControl; readonly downgrade: WatchControl } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const grant = readCorrectionControl(record["grant"])
  const downgrade = readCorrectionControl(record["downgrade"])
  if (grant === undefined || downgrade === undefined) return undefined
  return { grant, downgrade }
}

function readCorrectionControl(value: unknown): WatchControl | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const enabled = record["enabled"]
  const reason = record["reason"]
  if (typeof enabled !== "boolean" || !isStringOrNull(reason)) return undefined
  return { enabled, reason }
}

function isCorrectionPhase(value: unknown): value is WatchCorrectionAttemptPhase | "idle" {
  return (
    value === "idle" ||
    value === "reserved" ||
    value === "sending" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "unknown" ||
    value === "receipted" ||
    value === "recovered"
  )
}

function isCorrectionAttemptPhase(value: unknown): value is WatchCorrectionAttemptPhase {
  return (
    value === "reserved" ||
    value === "sending" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "unknown" ||
    value === "receipted" ||
    value === "recovered"
  )
}

function isCorrectionGrantMode(value: unknown): value is WatchCorrectionGrantMode {
  return value === "alert-only" || value === "single-attempt"
}

function isCorrectionGrantState(value: unknown): value is WatchCorrectionGrantState {
  return value === "not-granted" || value === "pending-confirmation" || value === "granted" || value === "revoked"
}

function isCorrectionStopReason(value: unknown): value is WatchCorrectionStopReason {
  return (
    value === "grant-missing" ||
    value === "grant-pending" ||
    value === "grant-expired" ||
    value === "attempt-limit" ||
    value === "session-unresolved" ||
    value === "reservation-pending" ||
    value === "sending-unaccounted" ||
    value === "accepted-without-receipt" ||
    value === "unknown-result" ||
    value === "receipted-awaiting-recovery" ||
    value === "rejected" ||
    value === "recovered" ||
    value === "runtime-unsupported" ||
    value === "single-host-unconfirmed" ||
    value === "cross-location" ||
    value === "protocol-unseen" ||
    value === "task-paused" ||
    value === "task-ended" ||
    value === "task-completed" ||
    value === "observation-untrusted" ||
    value === "normal-wait" ||
    value === "observation-gap" ||
    value === "executor-unavailable"
  )
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
  const waitID = record["waitID"]
  const waitUntil = record["waitUntil"]
  const clearsWaitID = record["clearsWaitID"]
  const clearEvidence = record["clearEvidence"]
  if (
    (summary !== undefined && typeof summary !== "string") ||
    (reference !== undefined && typeof reference !== "string") ||
    (waitFor !== undefined && typeof waitFor !== "string") ||
    (reason !== undefined && typeof reason !== "string") ||
    (waitID !== undefined && typeof waitID !== "string") ||
    (waitUntil !== undefined && (typeof waitUntil !== "number" || !Number.isSafeInteger(waitUntil))) ||
    (clearsWaitID !== undefined && typeof clearsWaitID !== "string") ||
    (clearEvidence !== undefined && typeof clearEvidence !== "string")
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
    ...(waitID === undefined ? {} : { waitID }),
    ...(waitUntil === undefined ? {} : { waitUntil }),
    ...(clearsWaitID === undefined ? {} : { clearsWaitID }),
    ...(clearEvidence === undefined ? {} : { clearEvidence }),
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
    monitoring !== "observer-alerts" ||
    automaticDetection !== "partial" ||
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
  const acknowledge = readControl(record["acknowledge"])
  const resume = readControl(record["resume"])
  const correction = readControl(record["correction"])
  const transfer = readControl(record["transfer"])
  if (pause === undefined || end === undefined || acknowledge === undefined || resume === undefined) {
    return undefined
  }
  if (correction === undefined || transfer === undefined) return undefined
  return { pause, end, acknowledge, resume, correction, transfer }
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
  return value === null || isFiniteNumber(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
