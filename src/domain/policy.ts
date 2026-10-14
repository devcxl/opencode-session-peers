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
import type { Delivery } from "./types.ts"

export interface InboundPolicy {
  /** Which peer messages may start a turn in the recipient. */
  trigger: "always" | "replies" | "never"
  /** Delivery to use when the recipient is mid-turn. */
  busyDelivery: Delivery
}

export function deliveryFor(input: { recipientIdle: boolean; policy: InboundPolicy }): Delivery {
  return input.recipientIdle ? "queue" : input.policy.busyDelivery
}

/** `replies` admits only answers to an ask; `never` keeps peer messages out entirely. */
export function shouldDeliver(input: { expectsReply: boolean; policy: InboundPolicy }): boolean {
  switch (input.policy.trigger) {
    case "always":
      return true
    case "replies":
      return input.expectsReply
    case "never":
      return false
  }
}

export type Admission = { ok: true } | { ok: false; code: ErrorCode }

export function canStartAsk(input: { askInFlight: boolean; targetAskToUs: boolean }): Admission {
  if (input.askInFlight) return { ok: false, code: "E_ASK_IN_FLIGHT" }
  if (input.targetAskToUs) return { ok: false, code: "E_MUTUAL_ASK" }
  return { ok: true }
}
