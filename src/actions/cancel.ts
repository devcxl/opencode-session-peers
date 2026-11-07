/** Request cancellation of an ask wait owned by this plugin instance. */
import { failure } from "../domain/errors.ts"
import type { ActionResult } from "../domain/types.ts"
import type { LocalAskWaits } from "../ask/handshake.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { refusal } from "./delivery.ts"
import { readText } from "./input.ts"

export interface CancelDeps {
  readonly waits: LocalAskWaits
  readonly roster?: Roster
}

export async function cancelAction(deps: CancelDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  if (deps.roster === undefined) return refusal(failure("E_DISABLED"))

  const replyTo = readText(input, "replyTo")
  const matches = [...deps.waits].filter(
    ([id, wait]) => wait.sessionID === call.sessionID && (replyTo.length === 0 || id === replyTo),
  )
  if (matches.length === 0) return refusal(failure("E_NO_ASK_TO_CANCEL", replyTo))
  if (matches.length > 1) return refusal(failure("E_CANCEL_AMBIGUOUS"))

  const [askID, wait] = matches[0]!
  wait.controller.abort()
  return {
    text: `Cancellation requested for local wait ${askID}; the question was not withdrawn.`,
    details: { requested: true, cancelled: false, askID },
  }
}
