/**
 * The `peers` tool.
 *
 * One tool with an action enum, registered directly for the model (ADR-0003).
 * The enum is part of the model-facing contract, so it lists only what this
 * build can do: an action that exists but answers "not implemented" is a lie
 * the model has no way to see through. Later tickets add their actions here,
 * one enum member and one case each.
 */

import { askAction } from "./actions/ask.ts"
import { cancelAction } from "./actions/cancel.ts"
import { handoverAction } from "./actions/handover.ts"
import { listCwdAction } from "./actions/list-cwd.ts"
import { listAction } from "./actions/list.ts"
import { pendingAction } from "./actions/pending.ts"
import { replyAction } from "./actions/reply.ts"
import { sendAction } from "./actions/send.ts"
import { statusAction } from "./actions/status.ts"
import type { Config } from "./config.ts"
import type { HandoverSupport } from "./host/handover.ts"
import type { SessionLookup } from "./host/session.ts"
import type { PluginStorage } from "./host/storage.ts"
import type { ToolSpec } from "./host/tools.ts"
import type { Roster } from "./peers/roster.ts"

export const PEERS_TOOL_NAME = "peers"

const PEERS_TOOL_DESCRIPTION =
  `Find the other opencode sessions on this machine and check that this one is reachable. ` +
  `Use "list" before addressing a peer, so the target is one this session actually saw. ` +
  `Actions: "list" — every live peer in this session's scope, this session first; ` +
  `"list-cwd" — only the peers working in this session's directory; ` +
  `"send" — deliver a message to one peer and report whether it was delivered; ` +
  `"ask" — put a question to one peer and wait, inside this call, until it answers or the wait times out; ` +
  `"reply" — answer a question another peer is waiting on; ` +
  `"pending" — the questions waiting for this session's answer; ` +
  `"cancel" — withdraw a question this session asked; ` +
  `"handover" — summarize this session with this session's own model and send the summary ` +
  `to one peer, which continues the work; ` +
  `"status" — this session's id, its scope, and whether the host is answering.`

const PEERS_TOOL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["list", "list-cwd", "send", "ask", "reply", "pending", "cancel", "handover", "status"],
      description:
        `Action to run: "list" every live peer in scope, "list-cwd" the peers in this ` +
        `session's directory, "send" a message to one peer, "ask" a question that waits for ` +
        `its answer inside this call, "reply" the answer to a peer's question, "pending" the ` +
        `questions waiting here, "cancel" withdraw a question this session asked, "handover" ` +
        `summarize this session and send the summary to one peer, "status" this session's id ` +
        `and connectivity.`,
    },
    to: {
      type: "string",
      description:
        `Target for "send", "ask" and "handover": a session id, the short id shown in ` +
        `parentheses by "list", or a session title. For "reply": the peer whose question you ` +
        `are answering, when more than one is waiting.`,
    },
    message: {
      type: "string",
      description:
        `Text for "send", "ask" or "reply". For "handover", the next task for the receiving ` +
        `session, which the handover addresses to it. A message needs text or at least one ` +
        `attachment; a handover needs the next task.`,
    },
    attachments: {
      type: "array",
      description:
        `Attachments for "send", "ask" or "reply", delivered inline inside the message body. ` +
        `A "handover" does not carry attachments.`,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["file", "snippet", "context"],
            description: `What the attachment is: a whole file, an excerpt, or background material.`,
          },
          name: { type: "string", description: `What the receiver should call it.` },
          content: { type: "string", description: `The attachment's text.` },
          language: { type: "string", description: `Language of "content", for a snippet.` },
        },
        required: ["type", "name", "content"],
      },
    },
    replyTo: {
      type: "string",
      description:
        `For "reply": the id of the question being answered, as shown by "pending", when ` +
        `more than one peer is waiting. For "cancel": the id of the question to withdraw; ` +
        `omit it to withdraw the one this session is waiting on. Not for "send", "ask" or ` +
        `"handover": a handover that carries a reply reference is refused.`,
    },
  },
  required: ["action"],
} as const

export interface PeersToolDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  /** The rendezvous every instance shares; where asks and their answers meet. */
  readonly storage: PluginStorage
  /** Absent exactly when the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
  /** Reports what went wrong in a way the caller can see but the call survives. */
  readonly warn: (message: string) => void
  /** What a handover needs from the host: the session's own model, version control, the sender's directory. */
  readonly handover: HandoverSupport
}

export function peersTool(deps: PeersToolDeps): ToolSpec {
  return {
    name: PEERS_TOOL_NAME,
    description: PEERS_TOOL_DESCRIPTION,
    input: PEERS_TOOL_INPUT,
    async handle(input, call) {
      // The schema requires an action, so anything else is a caller bug.
      const action = readAction(input)
      switch (action) {
        case "list":
          return listAction(deps, call)
        case "list-cwd":
          return listCwdAction(deps, call)
        case "send":
          return sendAction(deps, call, input)
        case "ask":
          return askAction(deps, call, input)
        case "reply":
          return replyAction(deps, call, input)
        case "pending":
          return pendingAction(deps, call)
        case "cancel":
          return cancelAction(deps, call, input)
        case "handover":
          return handoverAction(deps, call, input)
        case "status":
          return statusAction(deps, call)
        default:
          throw new Error(`Unknown peers action: ${action}`)
      }
    },
  }
}

function readAction(input: unknown): string {
  if (typeof input === "object" && input !== null && "action" in input) {
    const action = (input as { action: unknown }).action
    if (typeof action === "string") return action
  }
  throw new Error("The peers tool needs an action.")
}
