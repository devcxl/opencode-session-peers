/**
 * The host's event stream, and the live session index built from it.
 *
 * Events are live-only and scoped to the server process: an instance sees what
 * happens after it subscribes, never a replay, and only for turns this process
 * runs (`docs/research/opencode-multiprocess-topology.md` §5). Within the
 * process the stream is *not* filtered by location, so seeing an event is no
 * evidence that the session belongs to this instance's directory
 * (`docs/research/plugin-instance-scoping.md` §3).
 *
 * The index is therefore a cache, not a list of sessions: storage seeds it and
 * events correct it. A session nobody has mentioned stays unknown even though
 * it exists.
 */

import type { Plugin } from "@opencode/plugin"

import { describeError } from "../domain/errors.ts"
import type { SessionID } from "../domain/types.ts"

/** One event, exactly as the host streams it. */
export type HostEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event>
    ? Event
    : never

/** Subscribes to the host's stream; ends when the signal aborts. */
export interface EventSource {
  subscribe(options: { readonly signal: AbortSignal }): AsyncIterable<HostEvent>
}

/** What the event stream says about a session. */
export interface SessionActivity {
  readonly sessionID: SessionID
  /** The last status the host reported; absent until an event carries one. */
  readonly status?: string
}

export type SessionChange =
  | { readonly kind: "live"; readonly session: SessionActivity }
  | { readonly kind: "gone"; readonly sessionID: SessionID }

export interface SessionIndex {
  /** The status last seen for a session, if any event carried one. */
  statusOf(sessionID: SessionID): string | undefined
  /** Called for every change from now on; nothing already seen is replayed. */
  observe(listener: (change: SessionChange) => void): void
  /** Ends the subscription. */
  close(): void
}

export function startSessionIndex(events: EventSource, warn: (message: string) => void): SessionIndex {
  const sessions = new Map<SessionID, SessionActivity>()
  const listeners: ((change: SessionChange) => void)[] = []
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of events.subscribe({ signal: controller.signal })) {
        const change = apply(sessions, event)
        if (change === undefined) continue
        for (const listener of listeners) listener(change)
      }
    } catch (error) {
      // The stream is the host's in-process bus: it ends when the host takes the
      // location down. Keep what the index already knows and say so, rather than
      // reconnecting into a host that is going away.
      warn(`event stream ended: ${describeError(error)}`)
    }
  })()

  return {
    statusOf: (sessionID) => sessions.get(sessionID)?.status,
    observe(listener) {
      listeners.push(listener)
    },
    close: () => controller.abort(),
  }
}

/**
 * Folds one event into the index. Only events that change what the roster
 * publishes are tracked — a turn emits hundreds of step and stream events, and
 * none of them say anything about a peer that its row would show.
 */
function apply(
  sessions: Map<SessionID, SessionActivity>,
  event: HostEvent,
): SessionChange | undefined {
  switch (event.type) {
    // A created session is idle; a renamed or newly prompted one keeps the
    // status we last saw, because those events say nothing about the run.
    case "session.created":
      return track(sessions, event.data.sessionID, "idle")
    case "session.renamed":
    case "session.inbox.enqueued":
      return track(sessions, event.data.sessionID)
    case "session.status":
      return track(sessions, event.data.sessionID, event.data.status.type)
    case "session.execution.started":
      return track(sessions, event.data.sessionID, "busy")
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.execution.failed":
    case "session.idle":
      return track(sessions, event.data.sessionID, "idle")
    case "session.deleted": {
      const sessionID = event.data.sessionID
      sessions.delete(sessionID)
      return { kind: "gone", sessionID }
    }
    default:
      return undefined
  }
}

function track(
  sessions: Map<SessionID, SessionActivity>,
  sessionID: SessionID,
  status?: string,
): SessionChange {
  const previous = sessions.get(sessionID)
  const session: SessionActivity = { sessionID, status: status ?? previous?.status }
  sessions.set(sessionID, session)
  return { kind: "live", session }
}
