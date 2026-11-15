/**
 * The server-side `/peers-watch` command.
 *
 * Its default (no arguments) is a read-only check: it opens nothing for
 * mutation and sends no prompt. Explicit `enroll`, `pause` and `end` words call
 * the same application as the tool and RPC; the visible panel is the TUI half's
 * job, so a successful command does not fabricate a message or a model turn.
 */

import { randomUUID } from "node:crypto"

import {
  CORRECTION_UNAVAILABLE_REASON,
  DELEGATION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  TRANSFER_UNAVAILABLE_REASON,
} from "../domain/watch.ts"
import type { SessionLookup } from "../host/session.ts"
import { sessionAtLocation } from "../watch/access.ts"
import type { WatchApplication } from "../watch/service.ts"

export interface WatchCommandDeps {
  readonly watch?: WatchApplication
  readonly sessions: SessionLookup
  readonly directory: string
}

const USAGE =
  "usage: /peers-watch [enroll <goal> | pause <taskID> <version> | end <taskID> <version>]"

export async function watchCommand(deps: WatchCommandDeps, sessionID: string, input: string): Promise<void> {
  if (deps.watch === undefined) throw new Error("the plugin is disabled at this location")
  if (!(await sessionAtLocation(deps.sessions, sessionID, deps.directory))) {
    throw new Error("this location does not serve this session")
  }
  const words = input.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return

  const [operation, ...rest] = words
  switch (operation) {
    case "show":
      requireShow(deps.watch, sessionID)
      return
    case "enroll": {
      const goal = rest.join(" ").trim()
      if (goal.length === 0) throw new Error(USAGE)
      const outcome = deps.watch.enroll({
        callerSessionID: sessionID,
        requestID: randomUUID(),
        goal,
        targetSessionID: sessionID,
      })
      if (!outcome.ok) throw new Error(outcome.failure?.reason ?? "watch enrollment failed")
      return
    }
    case "pause":
    case "end": {
      const taskID = rest[0]
      const version = rest[1] === undefined ? Number.NaN : Number.parseInt(rest[1], 10)
      if (taskID === undefined || !Number.isSafeInteger(version) || version < 1) throw new Error(USAGE)
      const outcome = deps.watch.control({
        callerSessionID: sessionID,
        taskID,
        expectedVersion: version,
        operation,
      })
      if (!outcome.ok) throw new Error(outcome.failure?.reason ?? `watch ${operation} failed`)
      return
    }
    case "delegate":
      throw new Error(DELEGATION_UNAVAILABLE_REASON)
    case "grant":
    case "correct":
    case "receipt":
      throw new Error(CORRECTION_UNAVAILABLE_REASON)
    case "transfer":
      throw new Error(TRANSFER_UNAVAILABLE_REASON)
    case "resume":
      throw new Error(RECOVERY_UNAVAILABLE_REASON)
    default:
      throw new Error(USAGE)
  }
}

function requireShow(watch: WatchApplication, sessionID: string): void {
  const outcome = watch.show({ sessionID })
  if (!outcome.ok) throw new Error(outcome.failure?.reason ?? "could not read the watched task")
}
