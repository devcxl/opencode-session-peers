/**
 * Domain types.
 *
 * Everything under `domain/` is host-independent: no imports from `host/`,
 * `peers/`, `actions/`, and no reference to the plugin context. `host/` is the
 * only place that talks to opencode. `test/boundaries.test.ts` enforces this.
 */

/** A host session identifier. */
export type SessionID = string

/** When the host should hand a message to its recipient. */
export type Delivery = "steer" | "queue"

/**
 * Content carried along with a message. The original keeps these inline in the
 * message body rather than referring to files, so a peer can read them without
 * sharing a filesystem view.
 */
export interface Attachment {
  type: "file" | "snippet" | "context"
  name: string
  content: string
  language?: string
}

export interface MessageBody {
  text: string
  attachments?: readonly Attachment[]
}

/**
 * A session as it appears on the roster.
 *
 * Plugin instances are per project directory, so a peer record has to carry
 * everything a reader needs — including which instance published it, so a reply
 * can be routed back to the ask that is waiting for it.
 */
export interface Peer {
  sessionID: SessionID
  /** Session title; the name peers address each other by. */
  title: string
  directory: string
  projectID?: string
  model?: string
  status?: string
  /** Visibility partition; peers only resolve within their own scope. */
  scope: string
  /** Parent session, for sessions spawned as subagents. */
  parentID?: SessionID
  instanceID: string
  /** Epoch milliseconds of the last heartbeat; readers expire records past the TTL. */
  updatedAt: number
}

/** An outstanding ask, published so a reply can find its way back to its asker. */
export interface AskRecord {
  askID: string
  askerSessionID: SessionID
  askerInstanceID: string
  askerTitle: string
  targetSessionID: SessionID
  question: string
  createdAt: number
  expiresAt: number
}

export interface ReplyBody {
  askID: string
  fromSessionID: SessionID
  text: string
  attachments?: readonly Attachment[]
}
