/**
 * The `peers` tool.
 *
 * One tool with an action enum, registered directly for the model (ADR-0003).
 * The enum is part of the model-facing contract, so it lists only what this
 * build can do: an action that exists but answers "not implemented" is a lie
 * the model has no way to see through. Later tickets add their actions here,
 * one enum member and one case each.
 */

import { statusAction } from "./actions/status.ts"
import type { Config } from "./config.ts"
import type { SessionLookup } from "./host/session.ts"
import type { ToolSpec } from "./host/tools.ts"

export const PEERS_TOOL_NAME = "peers"

const PEERS_TOOL_DESCRIPTION =
  `Report the state of the session-peers bridge between opencode sessions on this machine. ` +
  `Use "status" to check that this session is connected before trying to reach a peer. ` +
  `Actions: "status" — this session's id, its scope, and whether the host is answering.`

const PEERS_TOOL_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["status"],
      description: `Action to run. "status" reports this session's id and the plugin's connectivity.`,
    },
  },
  required: ["action"],
} as const

export interface PeersToolDeps {
  readonly config: Config
  readonly sessions: SessionLookup
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
