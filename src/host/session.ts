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
  /** Session title; peers address each other by it. Absent until the host names the session. */
  readonly title?: string
  /** The directory this session works in; one plugin instance serves one directory. */
  readonly directory: string
  readonly projectID: string
  readonly parentID?: SessionID
  /** The model id the session runs, if one is selected. */
  readonly modelID?: string
}

export interface SessionLookup {
  /** Resolves a session; rejects when the host does not know it. */
  get(sessionID: SessionID): Promise<SessionRecord>
}

export function sessionLookup(session: Pick<Plugin.Context["session"], "get">): SessionLookup {
  return {
    async get(sessionID) {
      const record = await session.get({ sessionID })
      const title = record.title?.trim()
      return {
        id: record.id,
        title: title !== undefined && title.length > 0 ? title : undefined,
        directory: record.location.directory,
        projectID: record.projectID,
        parentID: record.parentID,
        modelID: record.model?.id,
      }
    },
  }
}
