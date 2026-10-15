/**
 * The parked-parent probe: reading the host for the rule in
 * `src/domain/parked-parent.ts` (ADR-0002).
 *
 * `ask` and `send` both address a session that may be the caller's own parent,
 * and both need the same answer: is that parent inside a `subagent` call that
 * has not returned? Only the host can say. A probe that cannot read the parent
 * is reported as `unknown` — never as parked — because the refusal it feeds must
 * be provable; the failure itself is handed to the caller to report, so it does
 * not disappear.
 */

import { describeError } from "../domain/errors.ts"
import { parentParking, type ParentParking } from "../domain/parked-parent.ts"
import type { SessionID, ToolCallRecord } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"

export interface ParentProbe {
  readonly parking: ParentParking
  /** Why the parent could not be read, when it could not. */
  readonly error?: string
}

export interface ParentProbeInput {
  readonly sessions: SessionLookup
  /** The caller's parent, as the caller's own roster row declares it. */
  readonly parentID?: SessionID
  /** The session the call addresses. */
  readonly targetID: SessionID
  /** Reports a probe that could not run; the message itself continues either way. */
  readonly warn: (message: string) => void
}

export async function probeParent(input: ParentProbeInput): Promise<ParentProbe> {
  const { parentID, targetID } = input
  // Someone other than the caller's parent: there is no supervisor channel in
  // this call, and reading any transcript would be work with no decision in it.
  if (parentID === undefined || parentID !== targetID) return { parking: "not-parent" }

  let calls: readonly ToolCallRecord[] | undefined
  try {
    calls = await input.sessions.toolCalls(parentID)
  } catch (error) {
    const detail = describeError(error)
    input.warn(`could not read ${parentID} before addressing it: ${detail}`)
    return { parking: "unknown", error: detail }
  }

  return { parking: parentParking({ parentID, calls }) }
}
