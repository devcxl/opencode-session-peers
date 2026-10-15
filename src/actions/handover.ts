/**
 * The `handover` action: summarise this session and send the summary (交接).
 *
 * The body is written by the sending session's own model, the header is
 * assembled from what the host knows about this session, and the result is a
 * message: it goes out through the same delivery path as `send` — resolution,
 * the recipient's declared inbound policy, the inbound body, the delivery
 * outcome — because to the receiving session that is exactly what it is. A
 * handover starts a new message by construction: attachments and a reply
 * reference are refused before anything is generated.
 */

import { describeError, failure, type Failure } from "../domain/errors.ts"
import { resolvePeer } from "../domain/addressing.ts"
import { inboundMessage } from "../domain/format.ts"
import {
  buildHandoverPrompt,
  checkHandoverShape,
  handoverBody,
  handoverMessage,
} from "../domain/handover.ts"
import { admitInbound, deliveryFor } from "../domain/policy.ts"
import type { ActionResult, Attachment } from "../domain/types.ts"
import type { Config } from "../config.ts"
import type { HandoverSupport } from "../host/handover.ts"
import type { SessionLookup } from "../host/session.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { peerDetails, readRoster, type RosterView } from "./roster-view.ts"

export interface HandoverDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
  /** The session's own model, the version control facts, and the sender's directory. */
  readonly handover: HandoverSupport
}

export async function handoverAction(
  deps: HandoverDeps,
  call: ToolCall,
  input: unknown,
): Promise<ActionResult> {
  const { roster } = deps
  if (roster === undefined) return refusal(failure("E_DISABLED"))

  const parsed = readRequest(input)
  if (parsed === undefined) return refusal(failure("E_HANDOVER_NO_GOAL"))

  // Refused before the model is asked to write anything: neither can travel,
  // and a refusal should not cost a generation.
  const shape = checkHandoverShape(parsed)
  if (!shape.ok) return refusal(failure(shape.code))

  let view: RosterView
  try {
    view = await readRoster(roster, call.sessionID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  const resolution = resolvePeer(parsed.target, view.peers, call.sessionID)
  if (resolution.kind === "self") return refusal(failure("E_SELF_TARGET"))
  if (resolution.kind === "not-found") return refusal(failure("E_TARGET_NOT_FOUND", parsed.target))
  if (resolution.kind === "ambiguous") {
    return refusal(failure("E_TARGET_AMBIGUOUS", parsed.target), {
      candidates: resolution.candidates.map((peer) => peer.sessionID),
    })
  }

  const peer = resolution.peer
  // The same check catches a target that names the caller by title or prefix.
  if (peer.sessionID === call.sessionID) return refusal(failure("E_SELF_TARGET"))

  // A handover is a new message, never part of an ask/reply exchange, so the
  // recipient's declaration is read exactly as `send` reads it.
  const admission = admitInbound({ declared: peer.inboundTrigger, exchange: false })
  if (!admission.ok) {
    return refusal(failure(admission.code, parsed.target), { sessionID: peer.sessionID })
  }

  let generated: string
  try {
    generated = await deps.handover.generation.generate({
      sessionID: call.sessionID,
      prompt: buildHandoverPrompt(parsed.goal),
      signal: call.signal,
    })
  } catch (error) {
    // Reported, never swallowed: an unreported failure here would look like a
    // delivered handover that says nothing.
    return refusal(failure("E_HANDOVER_GENERATION_FAILED", describeError(error), true), {
      sessionID: peer.sessionID,
    })
  }

  const verdict = handoverBody(generated)
  if (!verdict.ok) {
    // The model's answer is kept in the details, so the refusal is diagnosable
    // without a second model call.
    return refusal(failure(verdict.code, "", true), {
      sessionID: peer.sessionID,
      generated: generated.trim(),
    })
  }

  const facts = await deps.handover.versionControl.facts(deps.handover.senderDirectory)
  const text = handoverMessage(
    {
      sender: view.self.title,
      directory: deps.handover.senderDirectory,
      ...(facts === undefined ? {} : { versionControl: facts }),
    },
    verdict.body,
  )

  // The roster is everything this instance knows about the target; a status it
  // never saw counts as "not idle", so a handover never starts a turn on a guess.
  const delivery = deliveryFor({ recipientIdle: peer.status === "idle", policy: deps.config.inbound })
  const inbound = inboundMessage({
    from: view.self,
    body: { text },
    replyHint: deps.config.replyHint,
  })

  try {
    await deps.sessions.prompt({ sessionID: peer.sessionID, text: inbound, delivery })
  } catch (error) {
    return refusal(failure("E_DELIVERY_FAILED", parsed.target), {
      sessionID: peer.sessionID,
      hostError: describeError(error),
    })
  }

  return {
    text: `Handover sent to ${peer.title}`,
    details: {
      delivered: true,
      delivery,
      ...peerDetails(peer, call.sessionID),
    },
  }
}

interface HandoverRequest {
  readonly target: string
  /** The next task for the receiver; the original made this the whole message field. */
  readonly goal: string
  readonly attachments: readonly Attachment[]
  readonly replyTo: string
}

/**
 * The tool's input as plain data. A handover without a goal is refused rather
 * than generated from the conversation alone: the original allowed that in its
 * human flow, but a tool call is explicit, and the receiver needs to know what
 * to do next.
 */
function readRequest(input: unknown): HandoverRequest | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const fields = input as Record<string, unknown>

  const goal = readString(fields["message"]).trim()
  if (goal.length === 0) return undefined

  return {
    target: readString(fields["to"]).trim(),
    goal,
    attachments: readArray(fields["attachments"]),
    replyTo: readString(fields["replyTo"]),
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Only emptiness is decided here. A malformed attachment is a `send` concern
 * (`E_ATTACHMENT_INVALID`); a handover refuses the key outright, whatever it
 * holds, so the refusal text is the same either way.
 */
function readArray(value: unknown): readonly Attachment[] {
  return Array.isArray(value) ? (value as readonly Attachment[]) : []
}

/** A refusal the model reads as text, with the code kept for the result details. */
function refusal(f: Failure, extra: Readonly<Record<string, unknown>> = {}): ActionResult {
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
