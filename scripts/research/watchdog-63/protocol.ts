/**
 * Pure pieces of the #63 isolated real-host run.
 *
 * They are kept free of host, server and filesystem access so the scripted
 * model plan and the bounded directives can be tested without starting an
 * opencode instance or a model endpoint.
 */

export const PARENT_SUBAGENT_MARKER = "WATCH63_PARENT_SUBAGENT"
export const PARENT_BEGIN_MARKER = "WATCH63_PARENT_BEGIN"
export const PARENT_DELEGATE_MARKER = "WATCH63_PARENT_DELEGATE"
export const PARENT_RECEIPT_MARKER = "WATCH63_PARENT_RECEIPT"
export const CHILD_IDLE_MARKER = "WATCH63_CHILD_IDLE"
export const CHILD_BEGIN_MARKER = "WATCH63_CHILD_BEGIN"
export const DUPLICATE_MARKER = "WATCH63_DUPLICATE"
export const CORRECTION_PREFIX = "[session-peers correction]"
export const PROGRESS_MARKER = "WATCH63_PROGRESS"
export const STUB_DONE_TEXT = "WATCH63_REALHOST_DONE"

export type Scenario = "positive" | "revoke" | "scope"

export function scenarioFromValue(value: string | undefined): Scenario {
  if (value === undefined || value === "") return "positive"
  if (value === "positive" || value === "revoke" || value === "scope") return value
  throw new Error("WATCH63_SCENARIO must be positive, revoke or scope")
}

/** Parse one `key=value` marker line into a bounded field map. */
export function directiveFields(text: string, marker: string): Record<string, string> | undefined {
  if (!text.includes(marker)) return undefined
  const fields: Record<string, string> = {}
  for (const forKey of ["taskID", "version", "reportId", "targetSessionID", "requestId", "goal", "attemptID", "correlation"] as const) {
    const match = new RegExp(`(?:^|\\s)${forKey}=(\\S+)`).exec(text)
    if (match?.[1] !== undefined) fields[forKey] = match[1]
  }
  return fields
}

export interface CorrectionCall {
  readonly taskID: string
  readonly attemptID: string
  readonly correlation: string
  /** The task state version printed in the correction prompt. */
  readonly stateVersion: number
}

/** Read the concrete receipt call the correction prompt carries; never guess ids. */
export function parseCorrectionCall(text: string): CorrectionCall | undefined {
  if (!text.includes(CORRECTION_PREFIX)) return undefined
  const parsed = /peers\((\{.*\})\)/.exec(text)?.[1]
  if (parsed === undefined) return undefined
  let call: unknown
  try {
    call = JSON.parse(parsed)
  } catch {
    return undefined
  }
  if (typeof call !== "object" || call === null) return undefined
  const watch = (call as { watch?: unknown }).watch
  if (typeof watch !== "object" || watch === null) return undefined
  const record = watch as Record<string, unknown>
  const taskID = record["taskID"]
  const attemptID = record["attemptID"]
  const correlation = record["correlation"]
  const version = Number(/task state version after reservation: (\d+)/.exec(text)?.[1])
  if (
    typeof taskID !== "string" ||
    typeof attemptID !== "string" ||
    typeof correlation !== "string" ||
    !Number.isSafeInteger(version)
  ) {
    return undefined
  }
  return { taskID, attemptID, correlation, stateVersion: version }
}

/** One bounded view of what a transcript/driver pass added. */
export interface SessionCounts {
  readonly user: number
  readonly assistant: number
  readonly correctionUsers: number
  readonly synthetic: number
}

export interface CountableMessage {
  readonly type?: string
  readonly text?: string
}

export function countMessages(messages: readonly CountableMessage[]): SessionCounts {
  let user = 0
  let assistant = 0
  let correctionUsers = 0
  let synthetic = 0
  for (const message of messages) {
    if (message.type === "user") {
      user += 1
      if (typeof message.text === "string" && message.text.includes(CORRECTION_PREFIX)) correctionUsers += 1
    } else if (message.type === "assistant") {
      assistant += 1
    }
    if (message.type === "synthetic") synthetic += 1
  }
  return { user, assistant, correctionUsers, synthetic }
}

export function isCorrectionUser(message: CountableMessage): boolean {
  return message.type === "user" && typeof message.text === "string" && message.text.includes(CORRECTION_PREFIX)
}


export interface MetadataMessage {
  readonly type?: string
  readonly text?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface NativeReportCounts {
  /** Synthetic child-completion reports whose metadata and tag both name this child. */
  readonly nativeHostReports: number
  /** Other synthetic messages, including a report for another child. */
  readonly otherSynthetic: number
  /** A source/child metadata match whose text tag or child id is inconsistent. */
  readonly invalidNativeReports: number
}

export type NativeReportKind = "native" | "other" | "invalid"

/**
 * Classify a child-completion report by the public metadata and tag. A
 * `<subagent>` text alone is not enough: the source and childID must match and
 * the tag must name the same child. Anything inconsistent is invalid, never
 * silently exempted.
 */
export function classifyNativeSubagentReport(
  message: MetadataMessage,
  expectedChildID: string,
): NativeReportKind {
  if (message.type !== "synthetic") return "other"
  const metadata = message.metadata
  if (metadata === undefined || metadata["source"] !== "subagent" || metadata["childID"] !== expectedChildID) {
    return "other"
  }
  const text = typeof message.text === "string" ? message.text : ""
  const taggedChild = /<subagent\b[^>]*\bsessionID="([^"]+)"/.exec(text)?.[1]
  return taggedChild === expectedChildID ? "native" : "invalid"
}

export function countNativeSubagentReports(
  messages: readonly MetadataMessage[],
  expectedChildID: string | null,
): NativeReportCounts {
  let nativeHostReports = 0
  let otherSynthetic = 0
  let invalidNativeReports = 0
  for (const message of messages) {
    if (message.type !== "synthetic") continue
    if (expectedChildID === null) {
      otherSynthetic += 1
      continue
    }
    const kind = classifyNativeSubagentReport(message, expectedChildID)
    if (kind === "native") nativeHostReports += 1
    else if (kind === "invalid") invalidNativeReports += 1
    else otherSynthetic += 1
  }
  return { nativeHostReports, otherSynthetic, invalidNativeReports }
}
