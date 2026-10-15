/**
 * How peers are shown to the model.
 *
 * Shapes are ported from pi-intercom: the roster row and the body a peer
 * receives. What is missing here relative to the original is metadata we do not
 * have (context percentage, terminal panes) and the delivery-metadata line,
 * which existed for a broker that reported receipts.
 */

import type { AskRecord, Attachment, MessageBody, Peer } from "./types.ts"

export interface RosterRowOptions {
  self: boolean
  sameDirectory: boolean
}

export function rosterRow(peer: Peer, options: RosterRowOptions): string {
  const facts: string[] = []
  if (peer.model !== undefined) facts.push(peer.model)
  if (peer.status !== undefined) facts.push(peer.status)
  const parenthetical = facts.length > 0 ? ` (${facts.join(" · ")})` : ""

  const tags: string[] = []
  if (options.self) tags.push("self")
  if (options.sameDirectory) tags.push("same cwd")
  const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : ""

  // The id is the whole id, not a prefix: a row is read by a person as often as
  // by a model, and only the whole id can be pasted into anything else — the
  // host's own CLI, a log, a listing from another scope.
  return `• ${peer.title} (${peer.sessionID}) — ${peer.directory}${parenthetical}${suffix}`
}

export function formatAttachments(attachments: readonly Attachment[]): string {
  return attachments
    .map((attachment) => {
      const language = attachment.language !== undefined ? ` ${attachment.language}` : ""
      return `--- ${attachment.type}: ${attachment.name}${language} ---\n${attachment.content}`
    })
    .join("\n")
}

export interface InboundMessageOptions {
  from: Peer
  body: MessageBody
  /** Append the reply hint the receiver needs to answer with `reply`. */
  replyHint: boolean
  /** Free-form provenance line, rendered in italics. */
  meta?: string
}

export function inboundMessage(options: InboundMessageOptions): string {
  const lines = [`**From ${options.from.title}** (${options.from.directory})`]
  if (options.replyHint) {
    lines.push(`To reply: peers({ action: "reply", message: "..." })`)
  }
  if (options.meta !== undefined && options.meta.length > 0) {
    lines.push(`_${options.meta}_`)
  }
  lines.push("", options.body.text)

  const attachments = options.body.attachments ?? []
  if (attachments.length > 0) lines.push("", formatAttachments(attachments))

  return lines.join("\n")
}

/**
 * What a blocked asker reads when the answer arrives — the original's result
 * (`pi-intercom` `index.ts:2804`), attachments and all. The body is the
 * answerer's own words, so it is not squeezed into one line.
 */
export function replyResult(fromTitle: string, body: MessageBody): string {
  const lines = [`**Reply from ${fromTitle}:**`, body.text]
  const attachments = body.attachments ?? []
  if (attachments.length > 0) lines.push("", formatAttachments(attachments))
  return lines.join("\n")
}

/**
 * One pending ask as `pending` lists it: sender, question id, how long it has
 * been waiting, and a preview — the original's row (`index.ts:2884-2888`),
 * which is also what a session copies into `replyTo` when several are waiting.
 */
export function pendingAskRow(ask: AskRecord, now: number): string {
  const preview = ask.question.replace(/\s+/g, " ").trim().slice(0, 80) || "(no text)"
  const elapsedSeconds = Math.max(0, Math.floor((now - ask.createdAt) / 1000))
  return `- ${ask.askerTitle} · ${ask.askID} · ${elapsedSeconds}s ago · ${preview}`
}
