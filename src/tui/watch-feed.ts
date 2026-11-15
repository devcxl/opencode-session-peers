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
 * back to active a moment later. A same-epoch event coalesces into one more
 * read; a new opening or a control starts its own epoch, so an old request can
 * no longer block or overwrite it.
 *
 * Closing stops the floor and stops applying answers, but leaves the
 * subscription installed so the next opening can still hear events. Disposing
 * is final: open, apply and refresh become no-ops and no timer is restarted.
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
  /** Takes a snapshot and starts the floor; ignored after dispose. */
  open(sessionID: string): void
  /** Reads again now; a same-epoch read in flight becomes one follow-up. */
  refresh(): void
  /** Applies a committed control answer while the panel is open. */
  apply(payload: WatchPayload): void
  /** Stops reads and the floor; the subscription stays until dispose. */
  close(): void
  /** Ends the subscription; later open/apply/refresh do nothing. */
  dispose(): void
}

export function createWatchFeed(
  source: WatchSource,
  options: { readonly refreshMs?: number } = {},
): WatchFeed {
  const refreshMs = options.refreshMs ?? REFRESH_MS
  const [state, setState] = createSignal<WatchState>({ kind: "loading" })
  let sessionID: string | undefined
  let opened = false
  let disposed = false
  let stale = false
  let epoch = 0
  /** The epoch of the read in flight, if any. A newer epoch may run beside it. */
  let inFlightEpoch: number | undefined
  let refresh: ReturnType<typeof setInterval> | undefined

  const read = (): void => {
    if (disposed || !opened || sessionID === undefined) return
    if (inFlightEpoch === epoch) {
      // The answer in flight may predate whatever asked for this read.
      stale = true
      return
    }
    const requestEpoch = epoch
    const request: WatchReadRequest = { sessionID }
    inFlightEpoch = requestEpoch
    void source
      .read(request)
      .then((answer) => {
        if (disposed || !opened || requestEpoch !== epoch) return
        const payload = readWatchPayload(answer)
        setState(
          payload === undefined ? { kind: "unreadable" } : { kind: "payload", payload },
        )
      })
      .catch((cause: unknown) => {
        if (disposed || !opened || requestEpoch !== epoch) return
        setState({ kind: "failed", reason: failureText(cause) })
      })
      .finally(() => {
        if (inFlightEpoch === requestEpoch) inFlightEpoch = undefined
        if (!disposed && opened && requestEpoch === epoch && stale) {
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
      if (disposed) return
      opened = true
      sessionID = openedSessionID
      // A read for the previous open is no longer about this panel.
      epoch += 1
      stale = false
      setState({ kind: "loading" })
      read()
      if (refresh === undefined) refresh = setInterval(() => read(), refreshMs)
    },
    refresh: read,
    apply: (payload) => {
      if (disposed || !opened) return
      // Anything already in flight was requested before this commit.
      epoch += 1
      stale = false
      setState({ kind: "payload", payload })
    },
    close: () => {
      if (disposed) return
      opened = false
      sessionID = undefined
      // A late answer or event now belongs to a panel that is no longer shown.
      epoch += 1
      stale = false
      if (refresh !== undefined) {
        clearInterval(refresh)
        refresh = undefined
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      opened = false
      sessionID = undefined
      epoch += 1
      stale = false
      stop()
      if (refresh !== undefined) clearInterval(refresh)
      refresh = undefined
    },
  }
}
