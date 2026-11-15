/**
 * The controlled grant flow behind the correction pane.
 *
 * The challenge is kept here, never in the dialog's view state. `prepare`
 * happens only after the user has reviewed the terms and explicitly asked to
 * continue; `confirm` consumes the stored challenge; no operation retries
 * itself. Every response is checked against the panel epoch/session before it
 * can toast, refresh or store a challenge.
 */

import type { TuiPort } from "../host/tui.ts"
import {
  readWatchGrantPayload,
  type WatchGrantChallengeView,
} from "../rpc.ts"
import type { WatchFeed } from "./watch-feed.ts"

export interface GrantFlowDeps {
  readonly port: TuiPort
  readonly feed: WatchFeed
  readonly isDisposed: () => boolean
  readonly panel: () => { readonly sessionID: string | undefined; readonly open: boolean }
  readonly epoch: () => number
}

export interface GrantFlow {
  prepare(): Promise<{ readonly reviewSummary: string; readonly expiresAt: number } | undefined>
  confirm(): Promise<void>
  downgrade(): Promise<void>
  /** Discard a prepared challenge without any RPC. */
  cancel(): void
  /** Forget a challenge when the panel is replaced or unloaded. */
  clear(): void
}

export function createGrantFlow(deps: GrantFlowDeps): GrantFlow {
  const { port, feed } = deps
  let pending: WatchGrantChallengeView | undefined

  const stillCurrent = (sessionID: string, startedEpoch: number): boolean => {
    const panel = deps.panel()
    return (
      !deps.isDisposed() &&
      deps.epoch() === startedEpoch &&
      panel.open &&
      panel.sessionID === sessionID
    )
  }

  const prepare = async (): Promise<
    { readonly reviewSummary: string; readonly expiresAt: number } | undefined
  > => {
    const panel = deps.panel()
    if (deps.isDisposed() || !panel.open || panel.sessionID === undefined) return undefined
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const state = feed.state()
    if (state.kind !== "payload" || state.payload.task === null) return undefined
    const task = state.payload.task
    const control = task.correction.controls.grant
    if (!control.enabled) {
      port.toast(control.reason ?? "Correction grant is unavailable.", "warning")
      return undefined
    }
    const taskID = task.taskID
    const expectedVersion = task.version
    const currentTask = (): boolean => {
      const current = feed.state()
      return (
        current.kind === "payload" &&
        current.payload.task !== null &&
        current.payload.task.taskID === taskID &&
        current.payload.task.version === expectedVersion
      )
    }

    let answer: unknown
    try {
      answer = await port.watchGrant.call({
        operation: "prepare",
        sessionID,
        taskID,
        expectedVersion,
        deployment: "single-host-same-location",
      })
    } catch {
      if (!stillCurrent(sessionID, startedEpoch) || !currentTask()) return undefined
      port.toast(
        "Could not prepare the correction grant: the request failed; re-read the task before trying again.",
        "error",
      )
      feed.refresh()
      return undefined
    }
    if (!stillCurrent(sessionID, startedEpoch) || !currentTask()) return undefined
    const payload = readWatchGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not prepare the correction grant: the answer was not a grant review this view understands.",
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    if (!payload.ok || payload.failure !== null || payload.challenge === null) {
      port.toast(
        `Could not prepare the correction grant: ${payload.failure?.code ?? "no challenge was issued"}.`,
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    if (
      payload.challenge.taskID !== taskID ||
      payload.challenge.expectedVersion !== expectedVersion
    ) {
      port.toast(
        "Could not prepare the correction grant: the challenge belongs to another task version.",
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    pending = payload.challenge
    return {
      reviewSummary: payload.challenge.reviewSummary,
      expiresAt: payload.challenge.expiresAt,
    }
  }

  const confirm = async (): Promise<void> => {
    const challenge = pending
    const panel = deps.panel()
    if (challenge === undefined || deps.isDisposed() || !panel.open || panel.sessionID === undefined) {
      return
    }
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const state = feed.state()
    if (
      state.kind !== "payload" ||
      state.payload.task === null ||
      state.payload.task.taskID !== challenge.taskID ||
      state.payload.task.version !== challenge.expectedVersion
    ) {
      pending = undefined
      port.toast("The watch changed before the grant could be confirmed; re-read and review it again.", "warning")
      feed.refresh()
      return
    }

    let answer: unknown
    try {
      answer = await port.watchGrant.call({
        operation: "confirm",
        sessionID,
        taskID: challenge.taskID,
        expectedVersion: challenge.expectedVersion,
        challenge: challenge.challenge,
        generation: challenge.generation,
        termsDigest: challenge.termsDigest,
        deployment: challenge.deployment,
      })
    } catch {
      if (!stillCurrent(sessionID, startedEpoch)) return
      pending = undefined
      port.toast(
        "Could not confirm the correction grant: the confirmation request failed; the panel will re-read. No retry was attempted.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!stillCurrent(sessionID, startedEpoch)) return
    pending = undefined
    const payload = readWatchGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not confirm the correction grant: the answer was not a grant review this view understands.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!payload.ok || payload.failure !== null) {
      port.toast(
        `Could not confirm the correction grant: ${payload.failure?.code ?? "the grant was not recorded"}.`,
        "error",
      )
      feed.refresh()
      return
    }
    feed.refresh()
    port.toast("Grant recorded; authorization is not delivery. Check attempt status.", "success")
  }

  const downgrade = async (): Promise<void> => {
    const panel = deps.panel()
    if (deps.isDisposed() || !panel.open || panel.sessionID === undefined) return
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const state = feed.state()
    if (state.kind !== "payload" || state.payload.task === null) return
    const task = state.payload.task
    const control = task.correction.controls.downgrade
    if (!control.enabled) {
      port.toast(control.reason ?? "Downgrade is unavailable.", "warning")
      return
    }

    let answer: unknown
    try {
      answer = await port.watchGrant.call({
        operation: "downgrade",
        sessionID,
        taskID: task.taskID,
        expectedVersion: task.version,
      })
    } catch {
      if (!stillCurrent(sessionID, startedEpoch)) return
      port.toast(
        "Could not downgrade the correction grant: the request failed; re-read the task.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!stillCurrent(sessionID, startedEpoch)) return
    pending = undefined
    const payload = readWatchGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not downgrade the correction grant: the answer was not a grant review this view understands.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!payload.ok || payload.failure !== null) {
      port.toast(
        `Could not downgrade the correction grant: ${payload.failure?.code ?? "the grant was not downgraded"}.`,
        "error",
      )
      feed.refresh()
      return
    }
    feed.refresh()
    port.toast(
      "Downgraded to alert-only. Business work continues; used attempts are unchanged.",
      "success",
    )
  }

  return {
    prepare,
    confirm,
    downgrade,
    cancel: () => {
      pending = undefined
    },
    clear: () => {
      pending = undefined
    },
  }
}
