/**
 * Reading the tool's input.
 *
 * The actions that carry a message — `send`, `ask`, `reply` — take the same
 * fields and must refuse the same malformed input with the same text, so the
 * parsing is one function and the failures stay the ported ones. A field an
 * action does not take is simply not read.
 */

import { failure, type Failure } from "../domain/errors.ts"
import type { Attachment } from "../domain/types.ts"

export interface MessageFields {
  readonly message: string
  readonly attachments: readonly Attachment[]
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure }

/** The text and attachments of one message; a message needs at least one of them. */
export function readMessage(input: unknown): Parsed<MessageFields> {
  const fields = fieldsOf(input)
  const attachments = readAttachments(fields["attachments"])
  if (attachments === undefined) return { ok: false, failure: failure("E_ATTACHMENT_INVALID") }

  const message = readText(input, "message")
  if (message.length === 0 && attachments.length === 0) {
    return { ok: false, failure: failure("E_MESSAGE_EMPTY") }
  }
  return { ok: true, value: { message, attachments } }
}

/** A string field as the model wrote it, trimmed; anything else reads as absent. */
export function readText(input: unknown, key: string): string {
  const value = fieldsOf(input)[key]
  return typeof value === "string" ? value.trim() : ""
}

function fieldsOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
}

/** `undefined` means malformed, which is not the same as absent. */
function readAttachments(value: unknown): Attachment[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined

  const attachments: Attachment[] = []
  for (const entry of value) {
    const attachment = readAttachment(entry)
    if (attachment === undefined) return undefined
    attachments.push(attachment)
  }
  return attachments
}

function readAttachment(value: unknown): Attachment | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { type, name, content, language } = value as Record<string, unknown>

  if (type !== "file" && type !== "snippet" && type !== "context") return undefined
  if (typeof name !== "string" || name.trim().length === 0) return undefined
  if (typeof content !== "string") return undefined
  if (language !== undefined && typeof language !== "string") return undefined

  return language === undefined ? { type, name, content } : { type, name, content, language }
}
