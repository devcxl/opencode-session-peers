/**
 * The feed providing the read-only direct child delegation view.
 *
 * It polls the delegation view snapshot while the delegation panel is open,
 * and pauses when closed. An epoch stamp ensures out-of-order responses do not
 * overwrite newer states. Opening or reading does not prompt, wake or correct
 * any session.
 */

import { createSignal } from "solid-js"

import type { WatchDelegationSource, WatchDelegationViewRequest } from "../host/tui.ts"
import { readWatchDelegationViewPayload, type WatchDelegationViewPayload } from "../rpc.ts"
import type { DelegationPaneState } from "./watch-delegation.ts"

const REFRESH_MS = 60_000

export interface WatchDelegationFeed {
  readonly state: () => DelegationPaneState
  open(sessionID: string, parentTaskID: string): void
  refresh(): void
  apply(payload: WatchDelegationViewPayload): void
  close(): void
  dispose(): void
}

export function createWatchDelegationFeed(
  source: WatchDelegationSource | undefined,
  options: { readonly refreshMs?: number } = {},
): WatchDelegationFeed {
  const refreshMs = options.refreshMs ?? REFRESH_MS
  const [state, setState] = createSignal<DelegationPaneState>({ kind: "loading" })
  let sessionID: string | undefined
  let parentTaskID: string | undefined
  let opened = false
  let disposed = false
  let stale = false
  let epoch = 0
  let inFlightEpoch: number | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const read = (): void => {
    if (disposed || !opened || sessionID === undefined || parentTaskID === undefined) return
    if (source === undefined) {
      setState({
        kind: "failed",
        reason: "Delegation view is unavailable in this host/build.",
      })
      return
    }
    if (inFlightEpoch === epoch) {
      stale = true
      return
    }
    const requestEpoch = epoch
    const request: WatchDelegationViewRequest = { sessionID, parentTaskID }
    inFlightEpoch = requestEpoch
    void source
      .read(request)
      .then((answer) => {
        if (disposed || !opened || requestEpoch !== epoch) return
        const payload = readWatchDelegationViewPayload(answer)
        if (payload === undefined) {
          setState({
            kind: "failed",
            reason: "The delegation view response was not understood.",
          })
          return
        }
        if (payload.parentTaskID !== parentTaskID || payload.parentSessionID !== sessionID) {
          setState({
            kind: "failed",
            reason: "The delegation view response belonged to another task or session.",
          })
          return
        }
        setState({ kind: "payload", payload })
      })
      .catch(() => {
        if (disposed || !opened || requestEpoch !== epoch) return
        setState({ kind: "failed", reason: "Could not read the delegation view." })
      })
      .finally(() => {
        if (inFlightEpoch === requestEpoch) inFlightEpoch = undefined
        if (!disposed && opened && requestEpoch === epoch && stale) {
          stale = false
          read()
        }
      })
  }

  const open = (nextSessionID: string, nextParentTaskID: string): void => {
    if (disposed) return
    const same = opened && sessionID === nextSessionID && parentTaskID === nextParentTaskID
    sessionID = nextSessionID
    parentTaskID = nextParentTaskID
    opened = true
    if (!same) {
      epoch += 1
      setState({ kind: "loading" })
    }
    if (timer === undefined) timer = setInterval(read, refreshMs)
    read()
  }

  const refresh = (): void => {
    if (disposed || !opened) return
    read()
  }

  const apply = (payload: WatchDelegationViewPayload): void => {
    if (disposed || !opened) return
    epoch += 1
    setState({ kind: "payload", payload })
  }

  const close = (): void => {
    opened = false
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const dispose = (): void => {
    disposed = true
    close()
  }

  return {
    state,
    open,
    refresh,
    apply,
    close,
    dispose,
  }
}
