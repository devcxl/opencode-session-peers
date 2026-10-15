/**
 * Handing one message to one peer.
 *
 * Every message this plugin delivers ends the same way — a question, an answer,
 * or a plain send: the recipient's own declaration decides whether it is
 * admitted at all, the roster decides when it lands, and the body is rendered
 * identically, so a peer reads the same shape from every path. The refusal
 * shapes live here too, because `send`, `ask` and `reply` report them the same
 * way: the text the model reads, the code and reason in the details.
 */

import type { Config } from "../config.ts"
import { describeError, failure, type Failure } from "../domain/errors.ts"
import { inboundMessage } from "../domain/format.ts"
import { admitInbound, deliveryFor } from "../domain/policy.ts"
import type { ActionResult, Delivery, MessageBody, Peer } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"

export interface DeliveryDeps {
  readonly config: Config
  readonly sessions: SessionLookup
}

export interface DeliveryRequest {
  readonly from: Peer
  readonly to: Peer
  readonly body: MessageBody
  /** True for a question or an answer to one: a peer that declared "replies" admits these. */
  readonly exchange: boolean
  /**
   * True for a question and nothing else: the asker is blocked, so the hint
   * tells the receiver how its answer travels back. A send, an answer and a
   * handover all leave nothing to answer.
   */
  readonly expectsReply: boolean
  readonly meta?: string
  /** How the model referred to the target, for the refusal text. */
  readonly detail: string
}

export type DeliveryAttempt =
  | { readonly kind: "delivered"; readonly delivery: Delivery }
  | { readonly kind: "refused"; readonly refusal: ActionResult }

export async function deliverTo(deps: DeliveryDeps, request: DeliveryRequest): Promise<DeliveryAttempt> {
  const admission = admitInbound({ declared: request.to.inboundTrigger, exchange: request.exchange })
  if (!admission.ok) {
    return {
      kind: "refused",
      refusal: refusal(failure(admission.code, request.detail), { sessionID: request.to.sessionID }),
    }
  }

  const delivery = deliveryFor({ recipientIdle: request.to.status === "idle", policy: deps.config.inbound })
  const text = inboundMessage({
    from: request.from,
    body: request.body,
    // The option can only take the instruction away: a hint on a message that
    // expects no reply would send the receiver to a refusal (issue #24).
    replyHint: request.expectsReply && deps.config.replyHint,
    ...(request.meta === undefined ? {} : { meta: request.meta }),
  })

  try {
    await deps.sessions.prompt({ sessionID: request.to.sessionID, text, delivery })
  } catch (error) {
    // The message was admitted but the host would not take it. Reporting it is
    // the point: a message the sender believes was delivered is worse.
    return {
      kind: "refused",
      refusal: refusal(failure("E_DELIVERY_FAILED", request.detail), {
        sessionID: request.to.sessionID,
        hostError: describeError(error),
      }),
    }
  }

  return { kind: "delivered", delivery }
}

/** A failure the model reads as text, with the code kept for the result details. */
export function refusal(f: Failure, extra: Readonly<Record<string, unknown>> = {}): ActionResult {
  return {
    text: f.reason,
    details: {
      delivered: false,
      code: f.code,
      reason: f.reason,
      retryable: f.retryable,
      ...extra,
    },
  }
}
