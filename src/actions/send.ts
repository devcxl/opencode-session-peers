/**
 * The `send` action: one message, one peer, no waiting (直发).
 *
 * The target is resolved through the domain's addressing rules — exact session
 * id, then a case-insensitive title, then an id prefix — and every `send`
 * fails closed rather than guessing a recipient. The delivery is decided from
 * what the roster last saw of the target and from this instance's inbound
 * policy, and the body is what the receiver reads: sender, directory, reply
 * hint, message, attachments.
 *
 * Nothing waits here: a message the host refuses is reported undelivered
 * instead of being held for a session that has already exited — the mailbox
 * the original had lived in a broker this build does not have (ADR-0001).
 */

import { describeError, failure, type Failure } from "../domain/errors.ts"
import { resolvePeer } from "../domain/addressing.ts"
import { inboundMessage } from "../domain/format.ts"
import { deliveryFor } from "../domain/policy.ts"
import type { ActionResult, Attachment } from "../domain/types.ts"
import type { Config } from "../config.ts"
import type { SessionLookup } from "../host/session.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readRoster, peerDetails, type RosterView } from "./roster-view.ts"

export interface SendDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
}

export async function sendAction(deps: SendDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  const { roster } = deps
  if (roster === undefined) return refusal(failure("E_DISABLED"))

  const parsed = readRequest(input)
  if (!parsed.ok) return refusal(parsed.failure)

  let view: RosterView
  try {
    view = await readRoster(roster, call.sessionID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  const resolution = resolvePeer(parsed.request.target, view.peers, call.sessionID)
  if (resolution.kind === "self") return refusal(failure("E_SELF_TARGET"))
  if (resolution.kind === "not-found") return refusal(failure("E_TARGET_NOT_FOUND", parsed.request.target))
  if (resolution.kind === "ambiguous") {
    return refusal(failure("E_TARGET_AMBIGUOUS", parsed.request.target), {
      candidates: resolution.candidates.map((peer) => peer.sessionID),
    })
  }

  const peer = resolution.peer
  // The same check catches a target that names the caller by title or prefix.
  if (peer.sessionID === call.sessionID) return refusal(failure("E_SELF_TARGET"))

  // The roster is everything this instance knows about the target; a status it
  // never saw counts as "not idle", so a message never starts a turn on a guess.
  const delivery = deliveryFor({ recipientIdle: peer.status === "idle", policy: deps.config.inbound })
  const body = inboundMessage({
    from: view.self,
    body: { text: parsed.request.text, attachments: parsed.request.attachments },
    replyHint: deps.config.replyHint,
  })

  try {
    await deps.sessions.prompt({ sessionID: peer.sessionID, text: body, delivery })
  } catch (error) {
    // The record was still fresh, so the session went away between the roster
    // read and the delivery. Reporting it is the point: a dropped message the
    // sender believes was delivered is worse than a failure.
    return refusal(failure("E_DELIVERY_FAILED", parsed.request.target), {
      sessionID: peer.sessionID,
      hostError: describeError(error),
    })
  }

  return {
    text: `Message sent to ${peer.title}`,
    details: { delivered: true, delivery, ...peerDetails(peer, call.sessionID) },
  }
}

interface SendRequest {
  readonly target: string
  readonly text: string
  readonly attachments: readonly Attachment[]
}

type ParsedRequest = { ok: true; request: SendRequest } | { ok: false; failure: Failure }

/** The tool's input as plain data; `undefined` here means the model left it out. */
function readRequest(input: unknown): ParsedRequest {
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const attachments = readAttachments(fields["attachments"])
  if (attachments === undefined) return { ok: false, failure: failure("E_ATTACHMENT_INVALID") }

  const request: SendRequest = {
    target: readString(fields["to"]).trim(),
    text: readString(fields["message"]).trim(),
    attachments,
  }
  if (request.text.length === 0 && request.attachments.length === 0) {
    return { ok: false, failure: failure("E_MESSAGE_EMPTY") }
  }
  return { ok: true, request }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** `undefined` means malformed, which is not the same as absent. */
function readAttachments(value: unknown): Attachment[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined

  const attachments: Attachment[] = []
  for (const entry of value) {
    const attachment = readAttachment(entry)
    if (attachment === undefined) return undefined
    attachments.push(attachment)
  }
  return attachments
}

function readAttachment(value: unknown): Attachment | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { type, name, content, language } = value as Record<string, unknown>

  if (type !== "file" && type !== "snippet" && type !== "context") return undefined
  if (typeof name !== "string" || name.trim().length === 0) return undefined
  if (typeof content !== "string") return undefined
  if (language !== undefined && typeof language !== "string") return undefined

  return language === undefined ? { type, name, content } : { type, name, content, language }
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
