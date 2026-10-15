/**
 * The parked-parent rule (ADR-0002).
 *
 * A foreground `subagent` call parks the parent's turn in `Job.block`, with no
 * timeout: its inbox still admits a child's message, but nothing is delivered
 * until the tool returns, and the tool returns only when the child's run ends
 * (`docs/research/subagent-lifecycle.md` §3). A child that asks its parent in
 * that state waits for a decision that cannot come until it has stopped waiting
 * — the one deadlock the supervisor channel must not walk into.
 *
 * The evidence is the parent's own transcript: a `subagent` tool call that is
 * still running and names this child. The call names it in its input when it
 * continues an existing child, and in the progress metadata the tool writes when
 * it creates one (`{sessionID, status: "running"}`). Anything less is not proof,
 * and an unprovable case is *asked*, not refused: a wrong refusal would take a
 * decision away from a parent that could still answer.
 */

import type { SessionID, ToolCallRecord } from "./types.ts"

/** The host's own tool for spawning a subagent session. */
const SUBAGENT_TOOL = "subagent"

export type ParentParking =
  /** No session spawned the caller: there is no supervisor channel here. */
  | "not-parent"
  /** The parent is inside the `subagent` call that started the caller. */
  | "parked"
  /** The parent's transcript shows no such call, so an ask may reach it. */
  | "answerable"
  /** The parent's transcript could not be read; the ask proceeds and may still be answered. */
  | "unknown"

export interface ParentParkingInput {
  /** The caller's parent, as the caller's own session record declares it. */
  readonly parentID?: SessionID
  /** The session about to ask. */
  readonly childID: SessionID
  /** The parent's transcript tool calls, or undefined when they could not be read. */
  readonly calls?: readonly ToolCallRecord[]
}

export function parentParking(input: ParentParkingInput): ParentParking {
  if (input.parentID === undefined) return "not-parent"
  if (input.calls === undefined) return "unknown"
  return input.calls.some((call) => isSubagentCallFor(call, input.childID)) ? "parked" : "answerable"
}

/** Whether one transcript record proves the parent is parked on this child. */
function isSubagentCallFor(call: ToolCallRecord, childID: SessionID): boolean {
  if (call.name !== SUBAGENT_TOOL || call.status !== "running") return false
  const named = [call.input["sessionID"], call.metadata["sessionID"]]
  return named.some((sessionID) => sessionID === childID)
}
