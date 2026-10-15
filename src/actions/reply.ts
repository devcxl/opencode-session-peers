/**
 * The `reply` action: the answer to a question someone is waiting on (应答).
 *
 * Which question is being answered is resolved, never guessed: the input may
 * name it (`replyTo`) or name the asker (`to`), and otherwise the single
 * question this session is holding decides — with several of them the answer is
 * refused and the candidates are named, because an answer that lands with the
 * wrong asker is worse than one that has to be asked for again.
 *
 * The answer travels through storage, which is the point: the instance that
 * serves the answering session is usually *not* the one blocked on the
 * question, and the reply record is what reaches across that boundary. When the
 * asker has already stopped waiting, there is nothing to reach: the answer is
 * delivered to its session as an ordinary message instead of being dropped.
 */

import { describeError, failure } from "../domain/errors.ts"
import { chooseAskToAnswer, type ReplyChoice } from "../domain/policy.ts"
import type { ActionResult } from "../domain/types.ts"
import type { Config } from "../config.ts"
import type { SessionLookup } from "../host/session.ts"
import type { PluginStorage } from "../host/storage.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readAsks } from "../ask/handshake.ts"
import { deliverTo, refusal } from "./delivery.ts"
import { readMessage, readText } from "./input.ts"
import { readRoster, type RosterView } from "./roster-view.ts"

/** Provenance for an answer that arrived after the asker stopped waiting. */
const LATE_ANSWER_META = "Reply to your question, arriving after the wait for it had ended."

export interface ReplyDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  readonly storage: PluginStorage
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function replyAction(deps: ReplyDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  const { roster, storage } = deps
  if (roster === undefined) return refusal(failure("E_DISABLED"))

  const message = readMessage(input)
  if (!message.ok) return refusal(message.failure)
  const to = readText(input, "to")
  const replyTo = readText(input, "replyTo")

  let view: RosterView
  try {
    view = await readRoster(roster, call.sessionID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  const now = Date.now()
  let choice: ReplyChoice
  try {
    choice = chooseAskToAnswer({
      asks: await readAsks(storage),
      sessionID: call.sessionID,
      now,
      ...(replyTo.length === 0 ? {} : { replyTo }),
      ...(to.length === 0 ? {} : { from: to }),
    })
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  if (choice.kind === "none") return refusal(failure("E_NO_PENDING_ASK"))
  if (choice.kind === "ambiguous") {
    return refusal(
      failure("E_REPLY_AMBIGUOUS", choice.asks.map((ask) => ask.askerTitle).join(", ")),
      {
        candidates: choice.asks.map((ask) => ({
          askID: ask.askID,
          sessionID: ask.askerSessionID,
          title: ask.askerTitle,
        })),
      },
    )
  }

  const ask = choice.ask
  const body = { text: message.value.message, attachments: message.value.attachments }

  if (ask.expiresAt > now) {
    // The blocked asker is the only reader of this slot, and it removes the
    // answer the moment it has it. Nothing waits here: writing the record is
    // the whole answer, whatever instance asked the question.
    try {
      await storage.replies.write(ask.askID, {
        askID: ask.askID,
        fromSessionID: call.sessionID,
        fromTitle: view.self.title,
        text: body.text,
        attachments: body.attachments,
      })
    } catch (error) {
      return refusal(failure("E_NOT_CONNECTED", describeError(error)))
    }
    return {
      text: `Reply sent to ${ask.askerTitle}`,
      details: {
        delivered: true,
        askID: ask.askID,
        sessionID: ask.askerSessionID,
        title: ask.askerTitle,
      },
    }
  }

  // The wait had already ended, so the answer degrades into an ordinary
  // message — the asker is no longer listening anywhere else.
  const asker = view.peers.find((peer) => peer.sessionID === ask.askerSessionID)
  if (asker === undefined) {
    return refusal(failure("E_TARGET_NOT_FOUND", ask.askerTitle), { sessionID: ask.askerSessionID })
  }

  const attempt = await deliverTo(deps, {
    from: view.self,
    to: asker,
    body,
    exchange: true,
    replyHint: deps.config.replyHint,
    meta: LATE_ANSWER_META,
    detail: ask.askerTitle,
  })
  if (attempt.kind === "refused") return attempt.refusal

  let cleanupError: string | undefined
  try {
    await storage.asks.remove(ask.askID)
  } catch (error) {
    cleanupError = describeError(error)
  }

  return {
    text: `Reply sent to ${ask.askerTitle} (late: the wait for its answer had ended, so it arrived as an ordinary message)`,
    details: {
      delivered: true,
      late: true,
      delivery: attempt.delivery,
      askID: ask.askID,
      sessionID: ask.askerSessionID,
      title: ask.askerTitle,
      ...(cleanupError === undefined ? {} : { cleanupError }),
    },
  }
}
