/**
 * The `status` action.
 *
 * It answers "which session am I, and is the host still answering me?" — the
 * smallest question that proves the whole plugin path, and the check a session
 * runs when it is not sure it can reach a peer.
 */

import type { Config } from "../config.ts"
import { describeError, failure, type ErrorCode } from "../domain/errors.ts"
import type { ActionResult } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"
import type { ToolCall } from "../host/tools.ts"

export interface StatusDeps {
  readonly config: Config
  readonly sessions: SessionLookup
}

export async function statusAction(deps: StatusDeps, call: ToolCall): Promise<ActionResult> {
  // A disabled plugin still answers, so the model is told why nothing works.
  if (!deps.config.enabled) return failureResult("E_DISABLED", "", deps, call)

  try {
    const session = await deps.sessions.get(call.sessionID)
    return {
      text: [
        "**Session peers status:**",
        "Connected: yes",
        `Session ID: ${session.id}`,
        `Scope: ${deps.config.scope}`,
      ].join("\n"),
      details: { connected: true, sessionID: session.id, scope: deps.config.scope },
    }
  } catch (error) {
    return failureResult("E_NOT_CONNECTED", describeError(error), deps, call)
  }
}

/** A failure the model reads as text, with the code kept for the result details. */
function failureResult(
  code: ErrorCode,
  detail: string,
  deps: StatusDeps,
  call: ToolCall,
): ActionResult {
  const { reason } = failure(code, detail)
  return {
    text: reason,
    details: { connected: false, sessionID: call.sessionID, scope: deps.config.scope, code, reason },
  }
}
