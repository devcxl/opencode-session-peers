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
  CORRECTION_UNAVAILABLE_REASON,
  DELEGATION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  TRANSFER_UNAVAILABLE_REASON,
  type WatchEvidence,
  type WatchFailure,
  type WatchReportKind,
} from "../domain/watch.ts"
import type { ActionResult } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"
import type { ToolCall } from "../host/tools.ts"
import type { WatchApplication, WatchOutcome } from "../watch/service.ts"
import { watchCapability, watchControls } from "../watch/view.ts"

export interface WatchActionDeps {
  /** Absent exactly when the plugin is disabled at this location. */
  readonly watch?: WatchApplication
  readonly sessions: SessionLookup
  /** The directory this instance serves; enrollment is limited to it. */
  readonly directory: string
}

const OPERATIONS = [
  "show",
  "enroll",
  "report",
  "pause",
  "end",
  "grant",
  "correct",
  "receipt",
  "delegate",
  "transfer",
  "resume",
] as const

type Operation = (typeof OPERATIONS)[number]

export async function watchAction(deps: WatchActionDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  if (deps.watch === undefined) return outcomeResult(failure("E_WATCH_DISABLED", "Session peers is disabled by configuration."))

  const parsed = readWatchInput(input)
  if (!parsed.ok) return outcomeResult(failure("E_WATCH_INVALID", parsed.reason))
  const request = parsed.value

  switch (request.operation) {
    case "grant":
    case "correct":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", CORRECTION_UNAVAILABLE_REASON))
    case "receipt":
      return outcomeResult(
        failure(
          "E_WATCH_UNSUPPORTED",
          "Correction receipts are not implemented in this build because finite correction is not open.",
        ),
      )
    case "delegate":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", DELEGATION_UNAVAILABLE_REASON))
    case "transfer":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", TRANSFER_UNAVAILABLE_REASON))
    case "resume":
      return outcomeResult(failure("E_WATCH_UNSUPPORTED", RECOVERY_UNAVAILABLE_REASON))
    case "show":
      return outcomeResult(deps.watch.show({ sessionID: call.sessionID, ...(request.taskID === undefined ? {} : { taskID: request.taskID }) }))
    case "enroll": {
      const target = request.targetSessionID
      if (target !== undefined && target !== call.sessionID) {
        return outcomeResult(failure("E_WATCH_UNSUPPORTED", DELEGATION_UNAVAILABLE_REASON))
      }
      let sessionDirectory: string
      try {
        const session = await deps.sessions.get(call.sessionID)
        sessionDirectory = session.directory
      } catch (error) {
        return outcomeResult(
          failure("E_WATCH_NOT_FOUND", `The host does not know the calling session: ${describe(error)}`),
        )
      }
      if (sessionDirectory !== deps.directory) {
        return outcomeResult(
          failure("E_WATCH_UNSUPPORTED", "Enrollment is limited to a session served at this plugin location."),
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
  readonly expectedVersion?: number
  readonly requestID?: string
  readonly goal?: string
  readonly targetSessionID?: string
  readonly mode?: string
  readonly reportID?: string
  readonly kind?: WatchReportKind
  readonly evidence?: WatchEvidence
}

type Parsed = { readonly ok: true; readonly value: WatchRequest } | { readonly ok: false; readonly reason: string }

function readWatchInput(input: unknown): Parsed {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "watch must be an object" }
  const watch = (input as Record<string, unknown>)["watch"]
  if (typeof watch !== "object" || watch === null || Array.isArray(watch)) {
    return { ok: false, reason: "the watch action needs a watch object" }
  }
  const fields = watch as Record<string, unknown>
  const operation = fields["operation"]
  if (typeof operation !== "string" || !OPERATIONS.includes(operation as Operation)) {
    return {
      ok: false,
      reason: `watch.operation must be one of ${OPERATIONS.join(", ")}`,
    }
  }

  const taskID = optionalString(fields, "taskID")
  if (!taskID.ok) return taskID
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

  let evidence: WatchEvidence | undefined
  const rawEvidence = fields["evidence"]
  if (rawEvidence !== undefined) {
    if (typeof rawEvidence !== "object" || rawEvidence === null || Array.isArray(rawEvidence)) {
      return { ok: false, reason: "watch.evidence must be an object" }
    }
    evidence = rawEvidence as WatchEvidence
  }

  return {
    ok: true,
    value: {
      operation: operation as Operation,
      ...(taskID.value === undefined ? {} : { taskID: taskID.value }),
      ...(requestID.value === undefined ? {} : { requestID: requestID.value }),
      ...(goal.value === undefined ? {} : { goal: goal.value }),
      ...(targetSessionID.value === undefined ? {} : { targetSessionID: targetSessionID.value }),
      ...(mode.value === undefined ? {} : { mode: mode.value }),
      ...(reportID.value === undefined ? {} : { reportID: reportID.value }),
      ...(kind.value === undefined ? {} : { kind: kind.value }),
      ...(expectedVersion.value === undefined ? {} : { expectedVersion: expectedVersion.value }),
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
        failure: outcome.failure,
        created: outcome.created,
        duplicate: outcome.duplicate,
        changed: outcome.changed,
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
      "Authorization: alert-only (the only mode this build offers).",
      "Actual capability: participant reports only; automatic detection and correction are unavailable.",
    ].join("\n")
  }
  const lines = [
    `**Watched task:** ${task.taskID}`,
    `Goal: ${task.goal}`,
    `Task state: ${task.taskState}`,
    `Supervision: ${task.watchState}`,
    `Authorization: ${task.mode === "alert" ? "alert-only" : task.mode}`,
    "Actual capability: participant reports only; automatic detection is unavailable; correction is unavailable.",
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
  if (task.completedAt !== null) lines.push(`Business completion recorded at ${new Date(task.completedAt).toISOString()}.`)
  if (task.endedAt !== null) lines.push(`Supervision ended at ${new Date(task.endedAt).toISOString()}; this is not a business success.`)

  if (outcome.created) {
    lines.push("Enrollment recorded. No prompt was sent; the task appears in the target's next normal model context without a wakeup.")
  } else if (outcome.duplicate) {
    lines.push("This report was already recorded with the same evidence; no duplicate state change was made.")
  } else if (outcome.changed) {
    lines.push("No prompt, model generation or interrupt was sent.")
  }
  return lines.join("\n")
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.trim().length > 0 ? error.message : error.name
  return String(error)
}
