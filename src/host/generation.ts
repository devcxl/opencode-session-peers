/**
 * Handover generation: the session's own model writes the summary.
 *
 * The original asked the host's model registry to complete one request against
 * the session's model with the conversation serialized into it
 * (`handover.ts:38-77`). The v2 host has a session-scoped call for exactly this
 * purpose — `session.generate`, whose hook is `SessionGenerate` and which runs
 * against the session's own agent and model — so the prompt goes there and the
 * conversation stays where it already is.
 */

import type { Plugin } from "@opencode/plugin"

import type { SessionID } from "../domain/types.ts"

export interface GenerationRequest {
  readonly sessionID: SessionID
  /** The instructions and the goal; the session's history is the context. */
  readonly prompt: string
  /** Cancelled when the calling turn is interrupted. */
  readonly signal: AbortSignal
}

export interface Generation {
  /**
   * The model's answer. Rejects when the host cannot run the request; an empty
   * answer is returned as it came, for the caller to refuse.
   */
  generate(request: GenerationRequest): Promise<string>
}

export function sessionGeneration(
  session: Pick<Plugin.Context["session"], "generate">,
): Generation {
  return {
    async generate(request) {
      const response = await session.generate(
        { sessionID: request.sessionID, prompt: request.prompt },
        { signal: request.signal },
      )
      return response.text
    },
  }
}
