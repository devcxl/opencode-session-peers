/**
 * The `peers` tool.
 *
 * One tool with an action enum, registered directly for the model (ADR-0003).
 * The enum is part of the model-facing contract, so it lists only what this
 * build can do: an action that exists but answers "not implemented" is a lie
 * the model has no way to see through. Later tickets add their actions here,
 * one enum member and one case each.
 */

import { listCwdAction } from "./actions/list-cwd.ts"
import { listAction } from "./actions/list.ts"
import { statusAction } from "./actions/status.ts"
import type { Config } from "./config.ts"
import type { SessionLookup } from "./host/session.ts"
import type { ToolSpec } from "./host/tools.ts"
import type { Roster } from "./peers/roster.ts"

export const PEERS_TOOL_NAME = "peers"

const PEERS_TOOL_DESCRIPTION =
  `Find the other opencode sessions on this machine and check that this one is reachable. ` +
  `Use "list" before addressing a peer, so the target is one this session actually saw. ` +
  `Actions: "list" — every live peer in this session's scope, this session first; ` +
  `"list-cwd" — only the peers working in this session's directory; ` +
  `"status" — this session's id, its scope, and whether the host is answering.`

const PEERS_TOOL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["list", "list-cwd", "status"],
      description:
        `Action to run: "list" every live peer in scope, "list-cwd" the peers in this ` +
        `session's directory, "status" this session's id and connectivity.`,
    },
  },
  required: ["action"],
} as const

export interface PeersToolDeps {
  readonly config: Config
  readonly sessions: SessionLookup
  /** Absent exactly when the plugin is disabled: a disabled instance publishes nothing. */
  readonly roster?: Roster
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
