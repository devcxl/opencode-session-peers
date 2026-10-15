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
 * The evidence is the parent's own transcript: a `subagent` tool call that has
 * not returned. ADR-0002 expected such a call to name this child, and on
 * opencode 2.0.29 it does not: a running call carries no child id in its input
 * (a new spawn is never given one) and its progress metadata is empty for the
 * whole run (measured), so the child cannot be attributed to the call at all.
 * The running call is therefore read as the parking itself, which is what it is:
 * while any subagent call of the parent is running, that turn cannot drain its
 * inbox, and no ask addressed to it can be answered inside that time.
 *
 * Anything less than a running call is not proof, and an unprovable parent is
 * asked, not refused: a wrong refusal would take a decision away from a parent
 * that could still answer.
 */

import type { SessionID, ToolCallRecord } from "./types.ts"

/** The host's own tool for spawning a subagent session. */
const SUBAGENT_TOOL = "subagent"

export type ParentParking =
  /** No session spawned the caller: there is no supervisor channel here. */
  | "not-parent"
  /** The parent is inside a `subagent` call that has not returned. */
  | "parked"
  /** The parent's transcript shows no such call, so an ask may reach it. */
  | "answerable"
  /** The parent's transcript could not be read; the ask proceeds and may still be answered. */
  | "unknown"

export interface ParentParkingInput {
  /** The caller's parent, as the caller's own session record declares it. */
  readonly parentID?: SessionID
  /** The parent's transcript tool calls, or undefined when they could not be read. */
  readonly calls?: readonly ToolCallRecord[]
}

export function parentParking(input: ParentParkingInput): ParentParking {
  if (input.parentID === undefined) return "not-parent"
  if (input.calls === undefined) return "unknown"
  return input.calls.some(isRunningSubagentCall) ? "parked" : "answerable"
}

function isRunningSubagentCall(call: ToolCallRecord): boolean {
  return call.name === SUBAGENT_TOOL && call.status === "running"
}
