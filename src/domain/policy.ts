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
import type { Delivery, InboundTrigger } from "./types.ts"

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
