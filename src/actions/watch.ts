/**
 * The `watch` action family of the single `peers` tool.
 *
 * The action is a bounded DTO (`watch: { operation, ... }`), not a row of
 * optional top-level parameters. Enrolling, reading, pausing and ending all go
 * through the watchdog application; reporting uses the caller identity the host
 * supplies on the tool call. No branch here asks the host to prompt, generate
 * or interrupt anything.
 */

import {
  MANUAL_CORRECTION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  TRANSFER_UNAVAILABLE_REASON,
  type WatchAlertsView,
  type WatchCapability,
  type WatchEvidence,
  type WatchFailure,
  type WatchReportKind,
} from "../domain/watch.ts"
import type { ActionResult } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"
import type { ToolCall } from "../host/tools.ts"
import { sessionAtLocation } from "../watch/access.ts"
import {
  emptyWatchAlerts,
  type WatchApplication,
  type WatchObservationSource,
  type WatchOutcome,
  type WatchReceiptOutcome,
} from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"

export interface WatchActionDeps {
  /** Absent exactly when the plugin is disabled at this location. */
  readonly watch?: WatchApplication
  readonly observe?: WatchObservationSource
  readonly sessions: SessionLookup
  /** The directory this instance serves; enrollment is limited to it. */
  readonly directory: string
}

const WATCH_FIELDS = new Set([
  "operation",
  "taskID",
  "alertID",
  "expectedVersion",
  "requestId",
  "goal",
  "targetSessionID",
  "mode",
  "reportId",
  "kind",
  "evidence",
  "attemptID",
  "correlation",
])
const EVIDENCE_FIELDS = new Set([
  "summary",
  "reference",
  "waitKind",
  "waitFor",
  "reason",
  "waitID",
  "waitUntil",
  "clearsWaitID",
  "clearEvidence",
])

const OPERATIONS = [
  "show",
  "enroll",
  "report",
  "pause",
  "end",
  "ack",
  "grant",
  "correct",
  "receipt",
  "delegate",
  "transfer",
  "resume",
] as const

type Operation = (typeof OPERATIONS)[number]

/** Operations that read or mutate the ledger, and therefore need a local session. */
const LOCAL_OPERATIONS: readonly Operation[] = [
  "show",
  "enroll",
  "report",
  "pause",
  "end",
  "ack",
  "receipt",
  "delegate",
]

export async function watchAction(deps: WatchActionDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  if (deps.watch === undefined) return outcomeResult(failure("E_WATCH_DISABLED", "Session peers is disabled by configuration."))
  if (deps.watch.isClosing()) {
    return outcomeResult(failure("E_WATCH_UNAVAILABLE", "The watch application is closing; no action was taken."))
  }

  const parsed = readWatchInput(input)
  if (!parsed.ok) return outcomeResult(failure("E_WATCH_INVALID", parsed.reason))
  const request = parsed.value

  if (LOCAL_OPERATIONS.includes(request.operation)) {
    if (!(await sessionAtLocation(deps.sessions, call.sessionID, deps.directory))) {
      return outcomeResult(
        failure(
          "E_WATCH_NOT_FOUND",
          `This location does not serve the calling session "${call.sessionID}".`,
        ),
      )
    }
    if (deps.watch.isClosing()) {
      return outcomeResult(failure("E_WATCH_UNAVAILABLE", "The watch application is closing; no action was taken."))
    }
  }

  switch (request.operation) {
    case "grant":
      return outcomeResult(
        failure(
          "E_WATCH_UNSUPPORTED",
          "A correction grant must be prepared and confirmed from the controlled TUI surface. A model tool call cannot confirm it.",
        ),
      )
    case "correct":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", MANUAL_CORRECTION_UNAVAILABLE_REASON))
    case "receipt": {
      if (
        request.taskID === undefined ||
        request.attemptID === undefined ||
        request.correlation === undefined
      ) {
        return outcomeResult(failure("E_WATCH_INVALID", "receipt needs taskID, attemptID and correlation"))
      }
      return receiptResult(
        await deps.watch.receipt({
          callerSessionID: call.sessionID,
          taskID: request.taskID,
          attemptID: request.attemptID,
          correlation: request.correlation,
        }),
      )
    }
    case "delegate":
      if (
        request.taskID === undefined ||
        request.targetSessionID === undefined ||
        request.requestID === undefined ||
        request.goal === undefined ||
        request.expectedVersion === undefined
      ) {
        return outcomeResult(
          failure(
            "E_WATCH_INVALID",
            "delegate needs taskID (the parent task), targetSessionID, requestId, goal and expectedVersion",
          ),
        )
      }
      return outcomeResult(
        await deps.watch.delegate({
          callerSessionID: call.sessionID,
          parentTaskID: request.taskID,
          targetSessionID: request.targetSessionID,
          requestID: request.requestID,
          goal: request.goal,
          expectedVersion: request.expectedVersion,
          ...(request.mode === undefined ? {} : { mode: request.mode }),
        }),
      )
    case "transfer":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", TRANSFER_UNAVAILABLE_REASON))
    case "resume":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", RECOVERY_UNAVAILABLE_REASON))
    case "show":
      return outcomeResult(deps.watch.show({ sessionID: call.sessionID, ...(request.taskID === undefined ? {} : { taskID: request.taskID }) }))
    case "enroll": {
      const target = request.targetSessionID
      if (target !== undefined && target !== call.sessionID) {
        if (
          request.requestID === undefined ||
          request.goal === undefined ||
          request.expectedVersion === undefined
        ) {
          return outcomeResult(
            failure(
              "E_WATCH_INVALID",
              "a non-self enroll needs requestId, goal and expectedVersion; it is a direct-child delegation",
            ),
          )
        }
        const parentTaskID = request.taskID ?? deps.watch.show({ sessionID: call.sessionID }).task?.taskID
        if (parentTaskID === undefined) {
          return outcomeResult(
            failure("E_WATCH_INVALID", "a non-self enroll needs taskID of the parent task"),
          )
        }
        return outcomeResult(
          await deps.watch.delegate({
            callerSessionID: call.sessionID,
            parentTaskID,
            targetSessionID: target,
            requestID: request.requestID,
            goal: request.goal,
            expectedVersion: request.expectedVersion,
            ...(request.mode === undefined ? {} : { mode: request.mode }),
          }),
        )
      }
      if (request.requestID === undefined || request.goal === undefined) {
        return outcomeResult(failure("E_WATCH_INVALID", "enroll needs requestId and goal"))
      }
      return outcomeResult(
        deps.watch.enroll({
          callerSessionID: call.sessionID,
          requestID: request.requestID,
          goal: request.goal,
          ...(target === undefined ? {} : { targetSessionID: target }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
        }),
      )
    }
    case "report": {
      if (
        request.taskID === undefined ||
        request.expectedVersion === undefined ||
        request.reportID === undefined ||
        request.kind === undefined
      ) {
        return outcomeResult(failure("E_WATCH_INVALID", "report needs taskID, expectedVersion, reportId and kind"))
      }
      return outcomeResult(
        deps.watch.report({
          callerSessionID: call.sessionID,
          taskID: request.taskID,
          expectedVersion: request.expectedVersion,
          reportID: request.reportID,
          kind: request.kind,
          evidence: request.evidence ?? {},
        }),
      )
    }
    case "ack": {
      if (request.alertID === undefined) {
        return outcomeResult(failure("E_WATCH_INVALID", "ack needs an alertID"))
      }
      return outcomeResult(deps.watch.ack({ callerSessionID: call.sessionID, alertID: request.alertID }))
    }
    case "pause":
    case "end": {
      if (request.taskID === undefined || request.expectedVersion === undefined) {
        return outcomeResult(failure("E_WATCH_INVALID", `${request.operation} needs taskID and expectedVersion`))
      }
      return outcomeResult(
        deps.watch.control({
          callerSessionID: call.sessionID,
          taskID: request.taskID,
          expectedVersion: request.expectedVersion,
          operation: request.operation,
        }),
      )
    }
  }
}

interface WatchRequest {
  readonly operation: Operation
  readonly taskID?: string
  readonly alertID?: string
  readonly expectedVersion?: number
  readonly requestID?: string
  readonly goal?: string
  readonly targetSessionID?: string
  readonly mode?: string
  readonly reportID?: string
  readonly kind?: WatchReportKind
  readonly evidence?: WatchEvidence
  readonly attemptID?: string
  readonly correlation?: string
}

type Parsed = { readonly ok: true; readonly value: WatchRequest } | { readonly ok: false; readonly reason: string }

function readWatchInput(input: unknown): Parsed {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "watch must be an object" }
  const watch = (input as Record<string, unknown>)["watch"]
  if (typeof watch !== "object" || watch === null || Array.isArray(watch)) {
    return { ok: false, reason: "the watch action needs a watch object" }
  }
  const fields = watch as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (!WATCH_FIELDS.has(key)) return { ok: false, reason: `watch.${key} is not a supported field` }
  }
  const operation = fields["operation"]
  if (typeof operation !== "string" || !OPERATIONS.includes(operation as Operation)) {
    return {
      ok: false,
      reason: `watch.operation must be one of ${OPERATIONS.join(", ")}`,
    }
  }

  const taskID = optionalString(fields, "taskID")
  if (!taskID.ok) return taskID
  const alertID = optionalString(fields, "alertID")
  if (!alertID.ok) return alertID
  const requestID = optionalString(fields, "requestId")
  if (!requestID.ok) return requestID
  const goal = optionalString(fields, "goal")
  if (!goal.ok) return goal
  const targetSessionID = optionalString(fields, "targetSessionID")
  if (!targetSessionID.ok) return targetSessionID
  const mode = optionalString(fields, "mode")
  if (!mode.ok) return mode
  const reportID = optionalString(fields, "reportId")
  if (!reportID.ok) return reportID
  const kind = optionalKind(fields["kind"])
  if (!kind.ok) return kind
  const expectedVersion = optionalVersion(fields["expectedVersion"])
  if (!expectedVersion.ok) return expectedVersion
  const attemptID = optionalString(fields, "attemptID")
  if (!attemptID.ok) return attemptID
  const correlation = optionalString(fields, "correlation")
  if (!correlation.ok) return correlation

  let evidence: WatchEvidence | undefined
  const rawEvidence = fields["evidence"]
  if (rawEvidence !== undefined) {
    if (typeof rawEvidence !== "object" || rawEvidence === null || Array.isArray(rawEvidence)) {
      return { ok: false, reason: "watch.evidence must be an object" }
    }
    for (const key of Object.keys(rawEvidence)) {
      if (!EVIDENCE_FIELDS.has(key)) return { ok: false, reason: `watch.evidence.${key} is not a supported field` }
    }
    evidence = rawEvidence as WatchEvidence
  }

  return {
    ok: true,
    value: {
      operation: operation as Operation,
      ...(taskID.value === undefined ? {} : { taskID: taskID.value }),
      ...(alertID.value === undefined ? {} : { alertID: alertID.value }),
      ...(requestID.value === undefined ? {} : { requestID: requestID.value }),
      ...(goal.value === undefined ? {} : { goal: goal.value }),
      ...(targetSessionID.value === undefined ? {} : { targetSessionID: targetSessionID.value }),
      ...(mode.value === undefined ? {} : { mode: mode.value }),
      ...(reportID.value === undefined ? {} : { reportID: reportID.value }),
      ...(kind.value === undefined ? {} : { kind: kind.value }),
      ...(expectedVersion.value === undefined ? {} : { expectedVersion: expectedVersion.value }),
      ...(attemptID.value === undefined ? {} : { attemptID: attemptID.value }),
      ...(correlation.value === undefined ? {} : { correlation: correlation.value }),
      ...(evidence === undefined ? {} : { evidence }),
    },
  }
}

function optionalString(
  fields: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly reason: string } {
  const value = fields[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "string") return { ok: false, reason: `watch.${key} must be a string` }
  const trimmed = value.trim()
  return { ok: true, ...(trimmed.length === 0 ? {} : { value: trimmed }) }
}

function optionalKind(
  value: unknown,
): { readonly ok: true; readonly value?: WatchReportKind } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (value === "begin" || value === "progress" || value === "waiting" || value === "blocked" || value === "completed") {
    return { ok: true, value }
  }
  return { ok: false, reason: "watch.kind must be begin, progress, waiting, blocked or completed" }
}

function optionalVersion(
  value: unknown,
): { readonly ok: true; readonly value?: number } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, reason: "watch.expectedVersion must be a positive integer" }
  }
  return { ok: true, value }
}

function failure(code: WatchFailure["code"], reason: string): WatchOutcome {
  return {
    ok: false,
    task: null,
    capability: watchCapability(),
    controls: watchControls(null),
    alerts: emptyWatchAlerts(false, reason),
    failure: { code, reason },
    created: false,
    duplicate: false,
    changed: false,
  }
}

function outcomeResult(outcome: WatchOutcome): ActionResult {
  return {
    text: watchText(outcome),
    details: {
      watch: {
        ok: outcome.ok,
        task: outcome.task,
        capability: outcome.capability,
        controls: outcome.controls,
        alerts: outcome.alerts,
        failure: outcome.failure,
        created: outcome.created,
        duplicate: outcome.duplicate,
        changed: outcome.changed,
      },
    },
  }
}

function receiptResult(outcome: WatchReceiptOutcome): ActionResult {
  const text = !outcome.ok
    ? `${outcome.failure?.reason ?? "The correction receipt was refused."}\n\nCode: ${outcome.failure?.code ?? "E_WATCH_UNAVAILABLE"}. No continuation was authorized.`
    : outcome.continuePermit
      ? [
          "**Correction receipt recorded.**",
          "One continue permit was issued for this attempt. Continue only within the original authorization with the smallest next step.",
          "This permit is for this attempt only. A receipt is not recovery; report a real state change or completion with a new result reference when it exists.",
          "Do not repeat completed or unknown side effects, expand permissions, or rerun tools whose result is unknown.",
        ].join("\n")
      : outcome.duplicate
        ? "**Correction receipt already recorded.** No second continue permit was issued. Do not use the earlier receipt as a new permission."
        : [
            "**Correction receipt recorded as seen, but no continue permit was issued.**",
            `Reason: ${outcome.refusalReason ?? "the attempt is not eligible for continuation"}.`,
            "Do not continue business work on the basis of this receipt.",
          ].join("\n")
  return {
    text,
    details: {
      watch: {
        ok: outcome.ok,
        task: outcome.task,
        capability: outcome.capability,
        controls: outcome.controls,
        alerts: outcome.alerts,
        failure: outcome.failure,
        continuePermit: outcome.continuePermit,
        duplicate: outcome.duplicate,
        seen: outcome.seen,
        refusalReason: outcome.refusalReason,
      },
    },
  }
}

function watchText(outcome: WatchOutcome): string {
  if (!outcome.ok) {
    const code = outcome.failure?.code ?? "E_WATCH_UNAVAILABLE"
    return `${outcome.failure?.reason ?? "The watch operation failed."}\n\nCode: ${code}. No prompt, model generation or interrupt was sent.`
  }
  const task = outcome.task
  if (task === null) {
    return [
      "**Watched task:** none enrolled for this session.",
      ...capabilityLines(outcome.capability),
      ...alertsLines(outcome.alerts),
    ].join("\n")
  }
  const lines = [
    `**Watched task:** ${task.taskID}`,
    `Goal: ${task.goal}`,
    `Task state: ${task.taskState}`,
    `Supervision: ${task.watchState}${task.pause === null ? "" : ` (${task.pause.kind}: ${task.pause.reason})`}`,
    ...capabilityLines(outcome.capability),
    `Correction attempts: ${task.attempts.used}/${task.attempts.limit} permanent; policy: ${task.correction.executionPolicy}.`,
    `Correction actual: ${task.correction.actual} — ${task.correction.actualReason}`,
    `Correction grant: ${task.correction.authorization.mode}/${task.correction.authorization.state}, version ${task.correction.authorization.version}; deployment ${task.correction.authorization.deployment}; phase ${task.correction.phase}.`,
    ...(task.correction.stop === null
      ? []
      : [`Correction stop: ${task.correction.stop.reason}${task.correction.stop.missingEvidence === null ? "" : ` — ${task.correction.stop.missingEvidence}`}`]),
    ...(task.correction.pending === null
      ? []
      : [
          `Correction attempt: #${task.correction.pending.ordinal} ${task.correction.pending.phase}${task.correction.pending.receipt?.continuePermitIssuedAt != null ? " (continue permit issued)" : ""}.`,
        ]),
    `Protocol participation: ${task.participation === "seen" ? "seen (a report has been recorded)" : "not seen (no report yet)"}`,
    `Ownership: ${task.ownership === "this-instance" ? "this plugin instance" : "another activation (read-only observation; no takeover)"}`,
    `State version: ${task.version}; generation: ${task.generation}`,
  ]
  if (task.lastReport !== null) {
    const report = task.lastReport
    const evidence = [
      report.evidence.summary,
      report.evidence.reference,
      report.evidence.waitFor === undefined ? undefined : `waiting for ${report.evidence.waitFor}`,
      report.evidence.reason,
    ]
      .filter((part): part is string => part !== undefined)
      .join("; ")
    lines.push(`Last report: ${report.kind} at ${new Date(report.at).toISOString()}${evidence.length === 0 ? "" : ` — ${evidence}`}`)
  }
  if (task.completedAt !== null) {
    lines.push(
      `Business completion recorded at ${new Date(task.completedAt).toISOString()}; supervision ended because the task completed.`,
    )
  } else if (task.endedAt !== null) {
    lines.push(`Supervision ended at ${new Date(task.endedAt).toISOString()}; this is not a business success.`)
  }

  if (outcome.created) {
    lines.push("Enrollment recorded. No prompt was sent; the task appears in the target's next normal model context without a wakeup.")
  } else if (outcome.duplicate) {
    lines.push("This report was already recorded with the same evidence; no duplicate state change was made.")
  } else if (outcome.changed) {
    lines.push("No prompt, model generation or interrupt was sent.")
  }
  lines.push(...alertsLines(outcome.alerts))
  return lines.join("\n")
}

/** The real capability, not the mode the user selected. */
function capabilityLines(capability: WatchCapability): readonly string[] {
  return [
    `Authorization: ${capability.mode === "alert" ? "alert-only" : capability.mode}`,
    `Actual capability: ${capability.monitoring}; automatic detection is ${capability.automaticDetection} — ${capability.automaticDetectionReason}`,
    `Correction: ${capability.correction} — ${capability.correctionReason}`,
  ]
}

/** Bounded alert list plus the real availability/count/truncation facts. */
function alertsLines(alerts: WatchAlertsView): readonly string[] {
  if (!alerts.available) {
    return [`**Alerts:** unavailable${alerts.reason === null ? "" : ` — ${alerts.reason}`}.`]
  }
  const lines = [
    `**Alerts:** ${alerts.active} active, ${alerts.unread} unread, ${alerts.total} total; showing ${alerts.items.length}${alerts.truncated ? " (truncated; older stored alerts are not listed)" : ""}.`,
  ]
  for (const alert of alerts.items) {
    const resolved = alert.resolvedAt === null ? "" : ", resolved"
    lines.push(`- ${alert.alertID} [${alert.kind}, ${alert.state}${resolved}] ${alert.summary} Next: ${alert.nextStep}`)
  }
  return lines
}
