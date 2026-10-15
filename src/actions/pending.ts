/**
 * The `pending` action: the questions waiting on this session (待答).
 *
 * What it lists is exactly what `reply` will find without being told which
 * question: each row carries the asker, the question id and a preview, so a
 * session holding more than one can name the one it is answering. A question
 * whose asker has stopped waiting is not listed — nothing is blocked on it any
 * more — and neither is one this session already answered.
 */

import { describeError, failure } from "../domain/errors.ts"
import { pendingAskRow } from "../domain/format.ts"
import { pendingAsksFor } from "../domain/policy.ts"
import type { ActionResult, AskRecord } from "../domain/types.ts"
import type { PluginStorage } from "../host/storage.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readAsks } from "../ask/handshake.ts"
import { refusal } from "./delivery.ts"

export interface PendingDeps {
  readonly storage: PluginStorage
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function pendingAction(deps: PendingDeps, call: ToolCall): Promise<ActionResult> {
  if (deps.roster === undefined) return refusal(failure("E_DISABLED"))

  const now = Date.now()
  let pending: readonly AskRecord[]
  try {
    pending = pendingAsksFor(await readAsks(deps.storage), call.sessionID, now)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  if (pending.length === 0) {
    return { text: "No unresolved inbound asks.", details: { pending: 0 } }
  }

  return {
    text: `**Pending asks:**\n${pending.map((ask) => pendingAskRow(ask, now)).join("\n")}`,
    details: {
      pending: pending.length,
      asks: pending.map((ask) => ({
        askID: ask.askID,
        sessionID: ask.askerSessionID,
        title: ask.askerTitle,
        askedAt: ask.createdAt,
        expiresAt: ask.expiresAt,
        question: ask.question,
      })),
    },
  }
}
