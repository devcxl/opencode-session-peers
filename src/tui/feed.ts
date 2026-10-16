/**
 * What the panel reads: one snapshot when the view opens, then the plugin's own
 * events keep it current.
 *
 * The order is what makes the snapshot trustworthy. Events replay nothing, so a
 * reader that subscribed after taking its snapshot could miss a change that
 * happened in between and show it forever. Here the subscription is installed
 * first and the first read happens after it, so the snapshot is at least as new
 * as the moment the subscription began; every event after that marks the state
 * stale, and a stale state takes one more read — if a read was already in
 * flight when the event arrived, its answer may predate the event, so exactly
 * one more read follows it.
 *
 * A failed read is a state, not silence: the panel says the call failed and why,
 * rather than rendering an old roster as if it were current.
 */

import { createSignal } from "solid-js"

import type { RosterSource } from "../host/tui.ts"
import { readRosterPayload } from "../rpc.ts"
import type { RosterState } from "./view.ts"

export interface RosterFeed {
  readonly state: () => RosterState
  /** The one call the view opens with. */
  open(): void
  /** Ends the subscription; reads still in flight stop updating the state. */
  dispose(): void
}

export function createRosterFeed(source: RosterSource): RosterFeed {
  const [state, setState] = createSignal<RosterState>({ kind: "loading" })
  let reading = false
  let stale = false
  let closed = false

  const read = (): void => {
    if (closed) return
    if (reading) {
      // The answer in flight may predate whatever asked for this read, so it is
      // followed by exactly one more.
      stale = true
      return
    }
    reading = true
    void source
      .read()
      .then((answer) => {
        if (closed) return
        const payload = readRosterPayload(answer)
        // A malformed answer is its own state: rendering it as a roster would
        // claim more than the view knows.
        setState(payload === undefined ? { kind: "unreadable" } : { kind: "payload", payload })
      })
      .catch((cause: unknown) => {
        if (closed) return
        setState({ kind: "failed", reason: failureText(cause) })
      })
      .finally(() => {
        reading = false
        if (stale) {
          stale = false
          read()
        }
      })
  }

  // Before the first read, never after: see the note at the top of this file.
  const stop = source.onChange(() => read())

  return {
    state,
    open: () => read(),
    dispose: () => {
      closed = true
      stop()
    },
  }
}

/**
 * An RPC failure arrives as a plain `{ type, message }` object rather than an
 * Error (`docs/research/tui-surface-data-path.md` §1.4); anything else is shown
 * by whatever it can say about itself.
 */
function failureText(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return cause instanceof Error ? cause.message : String(cause)
}
