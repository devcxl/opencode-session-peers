/**
 * The `ask` action: one question, one peer, and the call blocks until it is
 * answered (询问).
 *
 * A question is a message plus a record: the record is what lets an answer find
 * its way back even when a *different* instance serves the answering session,
 * so it is published before the question is delivered and nothing is left
 * behind if the delivery is refused.
 *
 * The wait ends in exactly one of three ways, and none of them throws the
 * question away: an answer arrives, the deadline passes, or the turn is
 * interrupted. After the wait the asker is no longer listening, so a later
 * answer is delivered as an ordinary message rather than into a slot nobody
 * reads — which is why the timeout text says a timeout is not a cancellation.
 */

import { randomUUID } from "node:crypto"

import { describeError, failure, askInterruptedReason, askTimeoutReason } from "../domain/errors.ts"
import { replyResult } from "../domain/format.ts"
import { resolvePeer } from "../domain/addressing.ts"
import { admitInbound, canStartAsk, outstandingAsksFrom, pendingAsksFor } from "../domain/policy.ts"
import type { ActionResult, AskRecord } from "../domain/types.ts"
import type { Config } from "../config.ts"
import type { SessionLookup } from "../host/session.ts"
import type { PluginStorage } from "../host/storage.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readAsks, replyPollMs, waitForReply } from "../ask/handshake.ts"
import { deliverTo, refusal } from "./delivery.ts"
import { readMessage, readText } from "./input.ts"
import { readRoster, peerDetails, type RosterView } from "./roster-view.ts"

export interface AskDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  readonly storage: PluginStorage
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function askAction(deps: AskDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  const { roster, storage } = deps
  if (roster === undefined) return refusal(failure("E_DISABLED"))

  const message = readMessage(input)
  if (!message.ok) return refusal(message.failure)
  const target = readText(input, "to")

  let view: RosterView
  try {
    view = await readRoster(roster, call.sessionID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  const resolution = resolvePeer(target, view.peers, call.sessionID)
  if (resolution.kind === "self") return refusal(failure("E_SELF_TARGET"))
  if (resolution.kind === "not-found") return refusal(failure("E_TARGET_NOT_FOUND", target))
  if (resolution.kind === "ambiguous") {
    return refusal(failure("E_TARGET_AMBIGUOUS", target), {
      candidates: resolution.candidates.map((peer) => peer.sessionID),
    })
  }

  const peer = resolution.peer
  if (peer.sessionID === call.sessionID) return refusal(failure("E_SELF_TARGET"))

  // A question is one direction of an ask/reply exchange, so a peer that
  // accepts messages only as replies still admits it.
  const admission = admitInbound({ declared: peer.inboundTrigger, exchange: true })
  if (!admission.ok) return refusal(failure(admission.code, target), { sessionID: peer.sessionID })

  const now = Date.now()
  let asks: readonly AskRecord[]
  try {
    asks = await readAsks(storage)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }
  const inFlight = outstandingAsksFrom(asks, call.sessionID, now)
  const targetAskedUs = outstandingAsksFrom(asks, peer.sessionID, now).some(
    (ask) => ask.targetSessionID === call.sessionID,
  )
  const canStart = canStartAsk({ askInFlight: inFlight.length > 0, targetAskToUs: targetAskedUs })
  if (!canStart.ok) return refusal(failure(canStart.code, peer.title), { sessionID: peer.sessionID })

  const askID = randomUUID()
  const ask: AskRecord = {
    askID,
    askerSessionID: call.sessionID,
    askerInstanceID: view.self.instanceID,
    askerTitle: view.self.title,
    targetSessionID: peer.sessionID,
    question: message.value.message,
    createdAt: now,
    expiresAt: now + deps.config.askTimeoutMs,
  }
  try {
    await storage.asks.write(askID, ask)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  // The reply instruction always goes out with a question, whatever the
  // `replyHint` option says: the asker is blocked, and a question nobody can
  // see how to answer is the one shape of this message that must not happen.
  const attempt = await deliverTo(deps, {
    from: view.self,
    to: peer,
    body: { text: message.value.message, attachments: message.value.attachments },
    exchange: true,
    replyHint: true,
    detail: target,
  })
  if (attempt.kind === "refused") {
    // No question was asked, so no record may be left waiting for an answer.
    const cleanupError = await clearRecords(storage, askID)
    return withDetail(attempt.refusal, "cleanupError", cleanupError)
  }

  const wait = await waitForReply({
    replies: storage.replies,
    askID,
    expiresAt: ask.expiresAt,
    pollMs: replyPollMs(deps.config.askTimeoutMs),
    signal: call.signal,
  })

  if (wait.kind === "replied") {
    const cleanupError = await clearRecords(storage, askID)
    return withDetail(
      {
        text: replyResult(wait.reply.fromTitle, {
          text: wait.reply.text,
          attachments: wait.reply.attachments,
        }),
        details: { answered: true, askID, ...peerDetails(peer, call.sessionID) },
      },
      "cleanupError",
      cleanupError,
    )
  }

  if (wait.kind === "timeout") {
    const reason = askTimeoutReason({
      target: peer.title,
      askID,
      timeoutMs: deps.config.askTimeoutMs,
      delivery: attempt.delivery,
    })
    return {
      text: reason,
      details: {
        answered: false,
        delivered: true,
        delivery: attempt.delivery,
        code: "E_ASK_TIMEOUT",
        reason,
        retryable: false,
        askID,
        ...peerDetails(peer, call.sessionID),
      },
    }
  }

  // Interrupted: the wait is over, so the record must stop saying otherwise —
  // a reply that arrives afterwards is delivered as an ordinary message.
  const recordError = await endWait(storage, ask)
  const reason = askInterruptedReason({ target: peer.title, askID })
  return {
    text: reason,
    details: {
      answered: false,
      delivered: true,
      delivery: attempt.delivery,
      code: "E_ASK_INTERRUPTED",
      reason,
      askID,
      ...(recordError === undefined ? {} : { recordError }),
      ...peerDetails(peer, call.sessionID),
    },
  }
}

/**
 * The question and its slot go together, whatever happened to the wait. A
 * failure here is reported rather than thrown: the caller already has the
 * answer (or the refusal) in hand, and a leftover record only wastes a slot.
 */
async function clearRecords(storage: PluginStorage, askID: string): Promise<string | undefined> {
  const errors: string[] = []
  try {
    await storage.replies.remove(askID)
  } catch (error) {
    errors.push(describeError(error))
  }
  try {
    await storage.asks.remove(askID)
  } catch (error) {
    errors.push(describeError(error))
  }
  return errors.length > 0 ? errors.join("; ") : undefined
}

/** Moves the deadline to now: the asker has stopped waiting for this answer. */
async function endWait(storage: PluginStorage, ask: AskRecord): Promise<string | undefined> {
  try {
    await storage.asks.write(ask.askID, { ...ask, expiresAt: Date.now() })
    return undefined
  } catch (error) {
    return describeError(error)
  }
}

/** Adds a cleanup report to a result that already stands on its own. */
function withDetail(result: ActionResult, key: string, message: string | undefined): ActionResult {
  if (message === undefined) return result
  return { text: result.text, details: { ...result.details, [key]: message } }
}
