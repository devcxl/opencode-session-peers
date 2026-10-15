/**
 * Domain types.
 *
 * Everything under `domain/` is host-independent: no imports from `host/`,
 * `peers/`, `actions/`, and no reference to the plugin context. `host/` is the
 * only place that talks to opencode. `test/boundaries.test.ts` enforces this.
 */

/** A host session identifier. */
export type SessionID = string

/**
 * What an action hands back to the tool layer: text the model reads, and
 * details the host records alongside the tool result.
 */
export interface ActionResult {
  readonly text: string
  readonly details: Readonly<Record<string, unknown>>
}

/** When the host should hand a message to its recipient. */
export type Delivery = "steer" | "queue"

/**
 * What a session accepts from peers.
 *
 * The receiving side is the only side that can decide this, and this plugin has
 * no hook there, so a session publishes its trigger on its own roster record and
 * every sender honours what it finds. A record written before the field existed
 * carries none, which a sender treats as a refusal, not as permission.
 */
export type InboundTrigger = "always" | "replies" | "never"

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
  /** What this session accepts from peers, as it declared it. Absent on a record that predates the field. */
  inboundTrigger?: InboundTrigger
  /** Parent session, for sessions spawned as subagents. */
  parentID?: SessionID
  instanceID: string
  /** Epoch milliseconds of the last heartbeat; readers expire records past the TTL. */
  updatedAt: number
}

/**
 * An outstanding ask, published so a reply can find its way back to its asker.
 *
 * The asker carries a display name of its own on the record: the instance that
 * serves the answer reads only this record, never the asker's roster row, so
 * everything the answer needs to be routed and rendered travels here.
 *
 * `expiresAt` is when the asker stops waiting, not when the record is deleted:
 * the record outlives the wait so that an answer arriving later can be
 * delivered as an ordinary message instead of being dropped.
 */
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

/** The answer to one ask, written where the blocked asker polls for it. */
export interface ReplyRecord {
  askID: string
  /** The session that answered; the asker renders its title. */
  fromSessionID: SessionID
  fromTitle: string
  text: string
  attachments?: readonly Attachment[]
}
