/**
 * The `cancel` action: withdraw a question this session asked.
 *
 * A session cannot call this while its own ask blocks it — the turn is inside
 * that call — so the questions it withdraws are the ones nobody is waiting on
 * any more: an ask whose turn was interrupted, or one left behind when the
 * instance that asked it went away. "What became of it" is therefore the honest
 * report: either the question was still waiting and is now withdrawn, or its
 * wait had already ended and the record is left where a late answer can still
 * degrade into an ordinary message.
 */

import { describeError, failure } from "../domain/errors.ts"
import type { ActionResult, AskRecord } from "../domain/types.ts"
import type { PluginStorage } from "../host/storage.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readAsks } from "../ask/handshake.ts"
import { refusal } from "./delivery.ts"
import { readText } from "./input.ts"

export interface CancelDeps {
  readonly storage: PluginStorage
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function cancelAction(deps: CancelDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  if (deps.roster === undefined) return refusal(failure("E_DISABLED"))

  const replyTo = readText(input, "replyTo")
  const now = Date.now()

  let mine: readonly AskRecord[]
  try {
    mine = (await readAsks(deps.storage)).filter(
      (ask) => ask.askerSessionID === call.sessionID && (replyTo.length === 0 || ask.askID === replyTo),
    )
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  // A question still waiting is the one to withdraw; only when there is none
  // is an ended one — the record a late answer can still degrade through — the
  // thing this call is about.
  const waiting = mine.filter((ask) => ask.expiresAt > now)
  const ask = [...(waiting.length > 0 ? waiting : mine)].sort((left, right) => left.createdAt - right.createdAt).at(-1)
  if (ask === undefined) return refusal(failure("E_NO_ASK_TO_CANCEL", replyTo))

  if (ask.expiresAt <= now) {
    return {
      text:
        `Cancellation for ${ask.askID} was not delivered: its wait had already ended, so an answer ` +
        `that arrives later will arrive as an ordinary message.`,
      details: {
        delivered: false,
        cancelled: false,
        ended: true,
        askID: ask.askID,
        sessionID: ask.targetSessionID,
      },
    }
  }

  try {
    await deps.storage.asks.remove(ask.askID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)), { askID: ask.askID })
  }

  return {
    text: `Cancellation requested for ${ask.askID}`,
    details: {
      delivered: true,
      cancelled: true,
      askID: ask.askID,
      sessionID: ask.targetSessionID,
    },
  }
}
