/**
 * Session calls: reading one, and handing one a message.
 *
 * A tool call says which session invoked the tool; whether the host still knows
 * that session is the host's to answer. `docs/development-plan.md` gives this
 * file the session adapters — prompt, context, get, wait, rename — of which
 * `get` and `prompt` exist so far.
 */

import type { Plugin } from "@opencode/plugin"

import type { Delivery, SessionID } from "../domain/types.ts"

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

/** One message handed to a session, and when its reader should get it. */
export interface PromptRequest {
  readonly sessionID: SessionID
  readonly text: string
  readonly delivery: Delivery
}

export interface SessionLookup {
  /** Resolves a session; rejects when the host does not know it. */
  get(sessionID: SessionID): Promise<SessionRecord>
  /**
   * Hands one message to a session: `queue` waits for an idle runner and starts
   * a turn, `steer` is injected into the running turn at its next safe boundary.
   * Rejects when the host does not know the session.
   */
  prompt(request: PromptRequest): Promise<void>
}

export function sessionLookup(
  session: Pick<Plugin.Context["session"], "get" | "prompt">,
): SessionLookup {
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

    async prompt(request) {
      // What the host returns is its admission record, not a receipt that the
      // recipient read anything, so there is nothing here to report upwards.
      await session.prompt({
        sessionID: request.sessionID,
        text: request.text,
        delivery: request.delivery,
      })
    },
  }
}
