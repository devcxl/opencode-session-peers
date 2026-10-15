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
  | "E_REPLY_AMBIGUOUS"
  | "E_ASK_UNANSWERED"
  | "E_NO_ASK_TO_CANCEL"

/**
 * How a blocked ask stopped waiting without an answer.
 *
 * Not an `ErrorCode`: nothing was refused and nothing failed to be delivered —
 * the question reached the recipient and stayed answerable.
 */
export type AskStopCode = "E_ASK_TIMEOUT" | "E_ASK_INTERRUPTED"

export interface AskStop {
  readonly code: AskStopCode
  readonly reason: string
}

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
      return `"${detail}" is your parent session and cannot answer inside this turn: it is inside a subagent call that has not returned. Use "send" to hand it the question together with your recommendation, or raise it in your final report.`
    case "E_ASK_IN_FLIGHT":
      return "Already waiting for a reply; one ask at a time."
    case "E_MUTUAL_ASK":
      return `"${detail}" has an open question to you. Answer it with "reply" before asking one of your own.`
    case "E_NO_PENDING_ASK":
      return "No pending ask matches that reply."
    case "E_REPLY_AMBIGUOUS":
      return `More than one peer is waiting for a reply: ${detail}. Name the one you are answering with "to", or its question with "replyTo".`
    // The original kept this rule inside a turn it knew was answering an ask;
    // this host reports no turn context, so the plugin refuses any send from a
    // session whose inbox holds an unanswered ask (see `docs/research/ask-reply-handshake.md`).
    case "E_ASK_UNANSWERED":
      return `This session has an unanswered question from ${quote(detail)}. Answer it with "reply" before sending to another peer.`
    case "E_NO_ASK_TO_CANCEL":
      return detail.length > 0
        ? `No question with id "${detail}" is outstanding for this session.`
        : "This session has no question waiting for an answer."
  }
}

/**
 * The ported timeout text (pi-intercom v0.17.0 `index.ts:777-780`), including
 * its duration rule: whole minutes are spelled as minutes, anything else in
 * milliseconds, because the timeout is configurable.
 *
 * "This waiter timeout is not cancellation" is the load-bearing sentence: the
 * question stays in the recipient's hands, so an answer arriving afterwards is
 * still delivered — as an ordinary message, since nobody is waiting for it.
 */
export function askTimeout(input: {
  readonly target: string
  readonly askID: string
  readonly timeoutMs: number
  readonly delivery: Delivery
}): AskStop {
  const minutes = input.timeoutMs / 60_000
  const within =
    input.timeoutMs % 60_000 === 0
      ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
      : `${input.timeoutMs}ms`
  return {
    code: "E_ASK_TIMEOUT",
    reason:
      `No reply from ${quote(input.target)} for message ${input.askID} within ${within}. ` +
      `Last known delivery state: ${input.delivery}. ` +
      `This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`,
  }
}

/** What the model reads when the turn waiting for an answer was interrupted. */
export function askInterrupted(input: { readonly target: string; readonly askID: string }): AskStop {
  return {
    code: "E_ASK_INTERRUPTED",
    reason:
      `Waiting for a reply from ${quote(input.target)} for message ${input.askID} was interrupted. ` +
      `The question was delivered; an answer that arrives later will arrive as an ordinary message.`,
  }
}

/** A session title inside the texts above, quoted so a title with a quote cannot break them. */
function quote(value: string): string {
  return JSON.stringify(value)
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
