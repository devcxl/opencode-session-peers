/**
 * What the watch panel reads.
 *
 * The order is the same as the roster feed: subscribe first, then snapshot, so
 * an event that lands between the two cannot be missed. Events replay nothing,
 * so the snapshot is the truth and a slow refresh is only the floor under it.
 *
 * A control answer is different from a read: it is the newest state the plugin
 * just committed, so it is applied at once. An older read may still be in
 * flight; the epoch stamp makes that answer ineligible, so a pause cannot flip
 * back to active a moment later. A refresh asked for during that read waits
 * for it to settle and then reads once more, rather than stacking requests.
 */

import { createSignal } from "solid-js"

import type { WatchReadRequest, WatchSource } from "../host/tui.ts"
import { readWatchPayload, type WatchPayload } from "../rpc.ts"
import { failureText } from "./feed.ts"
import type { WatchState } from "./watch-view.ts"

/** The floor under live events: one snapshot a minute, not the mechanism. */
const REFRESH_MS = 60_000

export interface WatchFeed {
  readonly state: () => WatchState
  /** Takes a snapshot for this session and starts the refresh floor. */
  open(sessionID: string): void
  /** Reads again now, coalescing with a read already in flight. */
  refresh(): void
  /** Applies the answer a control just committed, before any later read. */
  apply(payload: WatchPayload): void
  /** Stops the floor; the subscription stays until dispose. */
  close(): void
  /** Ends the subscription; reads still in flight stop updating the state. */
  dispose(): void
}

export function createWatchFeed(
  source: WatchSource,
  options: { readonly refreshMs?: number } = {},
): WatchFeed {
  const refreshMs = options.refreshMs ?? REFRESH_MS
  const [state, setState] = createSignal<WatchState>({ kind: "loading" })
  let sessionID: string | undefined
  let reading = false
  let stale = false
  let closed = false
  let epoch = 0
  let refresh: ReturnType<typeof setInterval> | undefined

  const read = (): void => {
    if (closed || sessionID === undefined) return
    if (reading) {
      // The answer in flight may predate whatever asked for this read.
      stale = true
      return
    }
    const requestEpoch = epoch
    const request: WatchReadRequest = { sessionID }
    reading = true
    void source
      .read(request)
      .then((answer) => {
        if (closed || requestEpoch !== epoch) return
        const payload = readWatchPayload(answer)
        setState(
          payload === undefined ? { kind: "unreadable" } : { kind: "payload", payload },
        )
      })
      .catch((cause: unknown) => {
        if (closed || requestEpoch !== epoch) return
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

  // Before the first read, never after: an event between subscription and
  // snapshot must not be lost.
  const stop = source.onChange(() => read())

  return {
    state,
    open: (openedSessionID) => {
      sessionID = openedSessionID
      // A read for the previous open is no longer about this panel.
      epoch += 1
      setState({ kind: "loading" })
      read()
      if (refresh === undefined) refresh = setInterval(() => read(), refreshMs)
    },
    refresh: read,
    apply: (payload) => {
      if (closed) return
      // Anything already in flight was requested before this commit.
      epoch += 1
      setState({ kind: "payload", payload })
    },
    close: () => {
      if (refresh === undefined) return
      clearInterval(refresh)
      refresh = undefined
    },
    dispose: () => {
      closed = true
      stop()
      if (refresh !== undefined) clearInterval(refresh)
      refresh = undefined
    },
  }
}
