/**
 * One location-bound session check shared by the tool, RPC, command and the
 * normal-context notice.
 *
 * The ledger is machine-wide, but a task is only visible and controllable from
 * the directory that serves its session. This is a location check, not peer
 * authentication: the trust boundary remains the operating-system user.
 */

import type { SessionID } from "../domain/types.ts"
import type { SessionLookup } from "../host/session.ts"

export async function sessionAtLocation(
  sessions: SessionLookup,
  sessionID: SessionID,
  directory: string,
): Promise<boolean> {
  try {
    const session = await sessions.get(sessionID)
    return session.directory === directory
  } catch {
    // Unknown, deleted or moved out of reach: the safe answer is "not here".
    return false
  }
}
