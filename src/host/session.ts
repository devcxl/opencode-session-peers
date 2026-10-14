/**
 * Session lookups.
 *
 * A tool call says which session invoked the tool; whether the host still knows
 * that session is the host's to answer. `docs/development-plan.md` gives this
 * file the session adapters — prompt, context, get, wait, rename — of which
 * only `get` exists so far.
 */

import type { Plugin } from "@opencode/plugin"

import type { SessionID } from "../domain/types.ts"

/** What the plugin knows about a session it addresses. */
export interface SessionRecord {
  readonly id: SessionID
}

export interface SessionLookup {
  /** Resolves a session; rejects when the host does not know it. */
  get(sessionID: SessionID): Promise<SessionRecord>
}

export function sessionLookup(session: Pick<Plugin.Context["session"], "get">): SessionLookup {
  return {
    async get(sessionID) {
      const record = await session.get({ sessionID })
      return { id: record.id }
    },
  }
}
