/**
 * How peers are shown to the model.
 *
 * Shapes are ported from pi-intercom: the roster row and the body a peer
 * receives. What is missing here relative to the original is metadata we do not
 * have (context percentage, terminal panes) and the delivery-metadata line,
 * which existed for a broker that reported receipts.
 */

import type { Attachment, MessageBody, Peer } from "./types.ts"

export interface RosterRowOptions {
  self: boolean
  sameDirectory: boolean
  /** Shortest unique id prefix, so a reader can address this peer unambiguously. */
  prefix: string
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

  return `• ${peer.title} (${options.prefix}) — ${peer.directory}${parenthetical}${suffix}`
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
