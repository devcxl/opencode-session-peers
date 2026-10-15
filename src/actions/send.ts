/**
 * The `send` action: one message, one peer, no waiting (直发).
 *
 * The target is resolved through the domain's addressing rules — exact session
 * id, then a case-insensitive title, then an id prefix — and every `send`
 * fails closed rather than guessing a recipient. The delivery is decided from
 * what the roster last saw of the target and from the recipient's declared
 * policy, and the body is what the receiver reads: sender, directory, reply
 * hint, message, attachments.
 *
 * Nothing waits here: a message the host refuses is reported undelivered
 * instead of being held for a session that has already exited — the mailbox
 * the original had lived in a broker this build does not have (ADR-0001).
 */

import { describeError, failure } from "../domain/errors.ts"
import { resolvePeer } from "../domain/addressing.ts"
import { blockingAsk } from "../domain/policy.ts"
import type { ActionResult, AskRecord } from "../domain/types.ts"
import type { Config } from "../config.ts"
import type { SessionLookup } from "../host/session.ts"
import type { PluginStorage } from "../host/storage.ts"
import type { ToolCall } from "../host/tools.ts"
import type { Roster } from "../peers/roster.ts"
import { readAsks } from "../ask/handshake.ts"
import { deliverTo, refusal } from "./delivery.ts"
import { readMessage, readText } from "./input.ts"
import { probeParent } from "./parked-parent.ts"
import { readRoster, peerDetails, type RosterView } from "./roster-view.ts"

export interface SendDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  readonly storage: PluginStorage
  /** Absent while the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
  /** Reports what went wrong in a way the caller can see but the send survives. */
  readonly warn: (message: string) => void
}

export async function sendAction(deps: SendDeps, call: ToolCall, input: unknown): Promise<ActionResult> {
  const { roster } = deps
  if (roster === undefined) return refusal(failure("E_DISABLED"))

  const message = readMessage(input)
  if (!message.ok) return refusal(message.failure)
  const target = readText(input, "to")

  let view: RosterView
  try {
    view = await readRoster(roster, call.sessionID)
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }

  const resolution = resolvePeer(target, view.peers, call.sessionID)
  if (resolution.kind === "self") return refusal(failure("E_SELF_TARGET"))
  if (resolution.kind === "not-found") return refusal(failure("E_TARGET_NOT_FOUND", target))
  if (resolution.kind === "ambiguous") {
    return refusal(failure("E_TARGET_AMBIGUOUS", target), {
      candidates: resolution.candidates.map((peer) => peer.sessionID),
    })
  }

  const peer = resolution.peer
  // The same check catches a target that names the caller by title or prefix.
  if (peer.sessionID === call.sessionID) return refusal(failure("E_SELF_TARGET"))

  // A session with an unanswered question of its own does not get to talk to
  // anyone else: the answer is what this turn owes, and a send to a third
  // session is how an answer ends up with the wrong peer.
  let blocked: AskRecord | undefined
  try {
    blocked = blockingAsk(await readAsks(deps.storage), call.sessionID, peer.sessionID, Date.now())
  } catch (error) {
    return refusal(failure("E_NOT_CONNECTED", describeError(error)))
  }
  if (blocked !== undefined) {
    return refusal(failure("E_ASK_UNANSWERED", blocked.askerTitle), {
      sessionID: peer.sessionID,
      askID: blocked.askID,
      askerSessionID: blocked.askerSessionID,
    })
  }

  const attempt = await deliverTo(deps, {
    from: view.self,
    to: peer,
    body: { text: message.value.message, attachments: message.value.attachments },
    exchange: false,
    replyHint: deps.config.replyHint,
    detail: target,
  })
  if (attempt.kind === "refused") return attempt.refusal

  // A progress report to a parent that is inside a `subagent` call is admitted
  // now and read when that call returns — the one thing a child cannot see for
  // itself, and the honest answer to "did it arrive".
  const probe = await probeParent({
    sessions: deps.sessions,
    parentID: view.self.parentID,
    targetID: peer.sessionID,
    warn: deps.warn,
  })
  const parked = probe.parking === "parked"

  return {
    text: parked
      ? `Message sent to ${peer.title}; its turn is inside a subagent call that has not returned, so it will read the message when that call returns.`
      : `Message sent to ${peer.title}`,
    details: {
      delivered: true,
      delivery: attempt.delivery,
      ...(parked ? { parentProbe: probe.parking } : {}),
      ...peerDetails(peer, call.sessionID),
    },
  }
}
