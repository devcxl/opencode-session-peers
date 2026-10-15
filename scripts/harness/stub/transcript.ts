/**
 * Reading a session's transcript, and waiting for one turn's tool call.
 *
 * The offline pass waits on transcripts rather than on a session's `outcome`:
 * a session that already succeeded keeps that outcome, so the only reliable
 * signal for *this* turn is one more tool call than there was before — and,
 * when the call is the point, one that has stopped running. A `send` reports
 * its result in the same breath, but an `ask` stays running for as long as it
 * waits, so "the call appeared" and "the call returned" are different states
 * and the pass has to read both.
 */

import type { HarnessOptions } from "../args.ts"
import type { HarnessClient, SessionMessage, SessionToolPart } from "../client.ts"
import { sleep } from "../instance.ts"

/** How often a transcript is read while waiting; the host offers no watch to subscribe to. */
const POLL_MS = 500

/** One tool call from a transcript, with its result, its state and the host's timings. */
export interface ToolCall {
  name: string
  /** The host's state for the call: running, completed or error. */
  status: string
  input: unknown
  text: string
  metadata: Readonly<Record<string, unknown>>
  /** The host's own timestamps for the call, when the transcript carries them. */
  ranAt?: number
  completedAt?: number
}

export function toolCalls(messages: readonly SessionMessage[]): ToolCall[] {
  return messages.flatMap((message) =>
    (message.content ?? [])
      .filter((part): part is SessionToolPart => part.type === "tool")
      .map((part) => {
        const time = part.time
        return {
          name: part.name,
          status: part.state?.status ?? "unknown",
          input: part.state?.input,
          text: (part.state?.content ?? []).map((entry) => entry.text ?? "").join(""),
          metadata: part.state?.metadata ?? {},
          ...(typeof time?.ran === "number" ? { ranAt: time.ran } : {}),
          ...(typeof time?.completed === "number" ? { completedAt: time.completed } : {}),
        }
      }),
  )
}

/** A terminal call has a result; a running one has nothing to assert on yet. */
export function isTerminal(call: ToolCall): boolean {
  return call.status === "completed" || call.status === "error"
}

/** Time spent inside the call itself, from the host's own record, when it kept one. */
export function elapsedInCall(call: ToolCall): number | undefined {
  if (call.ranAt === undefined || call.completedAt === undefined) return undefined
  return call.completedAt - call.ranAt
}

/**
 * Ask a session to run one scripted turn and return the tool call it produced,
 * once that call has stopped running. The wait is bounded, so a turn that never
 * produces a terminal call fails the run naming what was last there instead of
 * hanging.
 */
export async function promptForResult(
  client: HarnessClient,
  options: HarnessOptions,
  sessionID: string,
  prompt: string,
): Promise<ToolCall> {
  const before = toolCalls(await client.context(sessionID)).length
  await client.prompt(sessionID, prompt)
  const deadline = Date.now() + options.turnTimeoutMs
  let last: ToolCall | undefined

  for (;;) {
    const calls = toolCalls(await client.context(sessionID)).slice(before)
    const done = calls.find(isTerminal)
    if (done !== undefined) return done
    last = calls.at(-1) ?? last
    if (Date.now() >= deadline) {
      throw new Error(
        `the tool call in ${sessionID} reached no terminal state within ${options.turnTimeoutMs} ms` +
          (last === undefined ? "" : ` (last: ${describeCall(last)})`),
      )
    }
    await sleep(POLL_MS)
  }
}

/**
 * Wait, inside a bounded window, for a call already in the transcript that
 * matches. Used after the fact: the peer's own reply call is recorded by the
 * peer's turn, which may still be finishing when the asker's result arrives.
 * Not finding it is the caller's to report, so this returns nothing rather than
 * throwing.
 */
export async function waitForCall(
  client: HarnessClient,
  sessionID: string,
  match: (call: ToolCall) => boolean,
  boundMs: number,
): Promise<ToolCall | undefined> {
  const deadline = Date.now() + boundMs
  for (;;) {
    const found = toolCalls(await client.context(sessionID)).find(match)
    if (found !== undefined) return found
    if (Date.now() >= deadline) return undefined
    await sleep(POLL_MS)
  }
}

/** A call as one line, for an `observed` field. */
export function describeCall(call: ToolCall): string {
  return `${call.name} [${call.status}] ${oneLine(call.text)}`
}

export function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
}
