/**
 * The failure surface.
 *
 * Codes exist for our own branching; the texts are for the model, and are ported
 * from pi-intercom v0.17.0 so that the same situation reads the same way here
 * (see `docs/research/pi-intercom.md`, "Failure modes"). Codes that exist only
 * because the original had a broker — delivery receipts, mailbox eviction,
 * supersession — are deliberately absent.
 */

import type { Delivery } from "./types.ts"

export type ErrorCode =
  | "E_DISABLED"
  | "E_NOT_CONNECTED"
  | "E_MESSAGE_EMPTY"
  | "E_ATTACHMENT_INVALID"
  | "E_SELF_TARGET"
  | "E_TARGET_NOT_FOUND"
  | "E_TARGET_AMBIGUOUS"
  | "E_TARGET_REFUSES"
  | "E_TARGET_REPLIES_ONLY"
  | "E_TARGET_POLICY_UNKNOWN"
  | "E_DELIVERY_FAILED"
  | "E_TARGET_UNREACHABLE"
  | "E_ASK_IN_FLIGHT"
  | "E_MUTUAL_ASK"
  | "E_NO_PENDING_ASK"

export interface Failure {
  delivered: false
  code: ErrorCode
  reason: string
  /** Whether trying the same thing again could plausibly succeed. */
  retryable: boolean
}

export type DeliveryResult = { delivered: true; delivery: Delivery } | Failure

export function delivered(delivery: Delivery): DeliveryResult {
  return { delivered: true, delivery }
}

/**
 * `detail` is the thing the failure is about — a target as the caller wrote it,
 * a session title — interpolated into the text when the code calls for it.
 */
export function failure(code: ErrorCode, detail = "", retryable = false): Failure {
  return { delivered: false, code, reason: reasonFor(code, detail), retryable }
}

function reasonFor(code: ErrorCode, detail: string): string {
  switch (code) {
    case "E_DISABLED":
      return "Session peers is disabled by configuration."
    case "E_NOT_CONNECTED":
      return `Session peers is not connected${detail.length > 0 ? `: ${detail}` : ""}.`
    case "E_MESSAGE_EMPTY":
      return "A message needs text or at least one attachment."
    case "E_ATTACHMENT_INVALID":
      return "Attachments need a type of file, snippet or context, a name, and content."
    case "E_SELF_TARGET":
      return "Cannot message the current session"
    case "E_TARGET_NOT_FOUND":
      return `Session "${detail}" is not connected. Blocking asks are not queued; use "send" or retry once it reconnects.`
    case "E_TARGET_AMBIGUOUS":
      return `Multiple sessions match "${detail}". Address one by the session id shown in parentheses by "list".`
    // The recipient's own declaration, honoured by the sender: the original
    // enforced it on the receiving side, which this host gives no hook for, so
    // the refusal has to name the policy that caused it.
    case "E_TARGET_REFUSES":
      return `Session "${detail}" does not accept peer messages.`
    case "E_TARGET_REPLIES_ONLY":
      return `Session "${detail}" accepts peer messages only as answers to its own questions, and this is a new message.`
    case "E_TARGET_POLICY_UNKNOWN":
      return `Session "${detail}" has not declared what it accepts from peers, so this message is refused. It may still be running an older build.`
    case "E_DELIVERY_FAILED":
      return `Message to "${detail}" was not delivered: the host no longer runs that session. Use "list" to see who is still connected.`
    case "E_TARGET_UNREACHABLE":
      return `"${detail}" is your parent session and is blocked waiting for you to finish, so it cannot answer inside this turn. Use "send" to hand it the question together with your recommendation, or raise it in your final report.`
    case "E_ASK_IN_FLIGHT":
      return "Already waiting for a reply; one ask at a time."
    case "E_MUTUAL_ASK":
      return `"${detail}" has an open question to you. Answer it with "reply" before asking one of your own.`
    case "E_NO_PENDING_ASK":
      return "No pending ask matches that reply."
  }
}

/**
 * A one-line reason for a thrown value, for interpolation into a failure text.
 * Host errors carry their meaning in `name` when the message is empty — a
 * missing session arrives as `Session.NotFoundError` with no message.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.trim().length > 0 ? error.message : error.name
  return String(error)
}
