/**
 * The correction-specific queue port.
 *
 * It preserves the host's real admission id and distinguishes a definite
 * refusal from an unknown result. The existing send/ask `SessionLookup.prompt`
 * semantics are unchanged; only the watchdog uses this port.
 */

import type { Plugin } from "@opencode/plugin"

export type CorrectionDeliveryOutcome =
  | { readonly kind: "accepted"; readonly admissionID: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string }

export interface CorrectionDeliveryRequest {
  readonly targetSessionID: string
  readonly text: string
  readonly attemptID: string
  readonly correlation: string
}

export interface CorrectionDeliveryPort {
  send(request: CorrectionDeliveryRequest): Promise<CorrectionDeliveryOutcome>
}

export function correctionDelivery(
  session: Pick<Plugin.Context["session"], "prompt">,
): CorrectionDeliveryPort {
  return {
    async send(request) {
      try {
        const admission = await session.prompt({
          sessionID: request.targetSessionID,
          text: request.text,
          delivery: "queue",
        })
        return { kind: "accepted", admissionID: admission.id }
      } catch (error) {
        const name = error instanceof Error ? error.name : ""
        if (
          name === "Session.NotFoundError" ||
          name === "InvalidRequestError" ||
          name === "UnauthorizedError" ||
          name === "ConflictError"
        ) {
          return { kind: "rejected", reason: name }
        }
        return { kind: "unknown", reason: name.length === 0 ? "queue call failed" : name }
      }
    },
  }
}
