/**
 * Inbound policy and admission rules — the pure decisions, separated from the
 * host calls that carry them out.
 *
 * The defaults behind these types come from pi-intercom v0.17.0: peer messages
 * trigger a turn by default, a recipient that is mid-turn gets a steering
 * delivery, one ask is outstanding at a time, and two sessions may not ask each
 * other simultaneously.
 */

import type { ErrorCode } from "./errors.ts"
import type { AskRecord, Delivery, InboundTrigger, SessionID } from "./types.ts"

export interface InboundPolicy {
  /** What this session accepts from peers; published on its roster record. */
  trigger: InboundTrigger
  /** Delivery to use when the recipient is mid-turn. */
  busyDelivery: Delivery
}

export function deliveryFor(input: { recipientIdle: boolean; policy: InboundPolicy }): Delivery {
  return input.recipientIdle ? "queue" : input.policy.busyDelivery
}

export type Admission = { ok: true } | { ok: false; code: ErrorCode }

/**
 * Whether a peer's *declared* trigger admits one message.
 *
 * The declaration travels on the peer's roster record, so the sending instance
 * decides with the recipient's own policy — there is no receiving-side hook to
 * ask. A record that carries no declaration fails closed.
 */
export function admitInbound(input: {
  readonly declared: InboundTrigger | undefined
  /** True for a question waiting for an answer, or for the answer to one. */
  exchange: boolean
}): Admission {
  switch (input.declared) {
    case "always":
      return { ok: true }
    case "replies":
      return input.exchange ? { ok: true } : { ok: false, code: "E_TARGET_REPLIES_ONLY" }
    case "never":
      return { ok: false, code: "E_TARGET_REFUSES" }
    default:
      return { ok: false, code: "E_TARGET_POLICY_UNKNOWN" }
  }
}

export function canStartAsk(input: { askInFlight: boolean; targetAskToUs: boolean }): Admission {
  if (input.askInFlight) return { ok: false, code: "E_ASK_IN_FLIGHT" }
  if (input.targetAskToUs) return { ok: false, code: "E_MUTUAL_ASK" }
  return { ok: true }
}

/**
 * The asks a session has received and has not answered while their askers are
 * still waiting — its 待答 (pending asks), oldest first. Once `expiresAt` passes
 * the asker has stopped waiting, so the ask no longer counts as pending: an
 * answer to it would be delivered as an ordinary message instead.
 */
export function pendingAsksFor(
  asks: readonly AskRecord[],
  sessionID: SessionID,
  now: number,
): readonly AskRecord[] {
  return byAge(asks.filter((ask) => ask.targetSessionID === sessionID && isWaiting(ask, now)))
}

/** The asks a session raised that nobody has answered yet, oldest first. */
export function outstandingAsksFrom(
  asks: readonly AskRecord[],
  sessionID: SessionID,
  now: number,
): readonly AskRecord[] {
  return byAge(asks.filter((ask) => ask.askerSessionID === sessionID && isWaiting(ask, now)))
}

/**
 * The ask that makes a `send` to `targetSessionID` a misdirected answer, if
 * there is one.
 *
 * The original refused a non-reply send to anyone but the asker *inside the
 * turn that ask triggered*; this host reports no turn context, so any send from
 * a session holding an unanswered ask is refused unless it goes to the asker
 * (`docs/research/ask-reply-handshake.md`). Fails closed by design: answering
 * the question is what the session is expected to do next.
 */
export function blockingAsk(
  asks: readonly AskRecord[],
  sessionID: SessionID,
  targetSessionID: SessionID,
  now: number,
): AskRecord | undefined {
  const blocked = pendingAsksFor(asks, sessionID, now).filter(
    (ask) => ask.askerSessionID !== targetSessionID,
  )
  return byAge(blocked).at(-1)
}

export type ReplyChoice =
  | { kind: "answer"; ask: AskRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; asks: readonly AskRecord[] }

/**
 * Which ask a `reply` is answering.
 *
 * `replyTo` names the question, `from` names the asker (exact id, exact title,
 * then id prefix — the same order as addressing a peer), and a question whose
 * asker is still waiting is preferred over one whose wait has ended: the
 * common case is a session answering the question in front of it, and guessing
 * between two of them is how an answer ends up with the wrong asker. Ambiguity
 * is reported, never resolved by picking one.
 */
export function chooseAskToAnswer(input: {
  readonly asks: readonly AskRecord[]
  readonly sessionID: SessionID
  readonly now: number
  readonly replyTo?: string
  readonly from?: string
}): ReplyChoice {
  let candidates: readonly AskRecord[] = input.asks.filter(
    (ask) => ask.targetSessionID === input.sessionID,
  )

  const replyTo = input.replyTo?.trim() ?? ""
  if (replyTo.length > 0) candidates = candidates.filter((ask) => ask.askID === replyTo)

  const from = input.from?.trim() ?? ""
  if (from.length > 0) candidates = matchAskSender(candidates, from)

  if (candidates.length === 0) return { kind: "none" }
  if (candidates.length === 1) return { kind: "answer", ask: candidates[0]! }

  const waiting = candidates.filter((ask) => isWaiting(ask, input.now))
  if (waiting.length === 1) return { kind: "answer", ask: waiting[0]! }
  return { kind: "ambiguous", asks: waiting.length > 0 ? byAge(waiting) : byAge(candidates) }
}

/** The asker as the answering session wrote it, read the way a peer is addressed. */
function matchAskSender(asks: readonly AskRecord[], target: string): readonly AskRecord[] {
  const byID = asks.filter((ask) => ask.askerSessionID === target)
  if (byID.length > 0) return byID

  const lower = target.toLowerCase()
  const byTitle = asks.filter((ask) => ask.askerTitle.toLowerCase() === lower)
  if (byTitle.length > 0) return byTitle

  return asks.filter((ask) => ask.askerSessionID.startsWith(target))
}

function isWaiting(ask: AskRecord, now: number): boolean {
  return ask.expiresAt > now
}

function byAge(asks: readonly AskRecord[]): readonly AskRecord[] {
  return [...asks].sort((left, right) => left.createdAt - right.createdAt)
}
