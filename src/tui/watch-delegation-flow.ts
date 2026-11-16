/**
 * The controlled delegation grant flow behind the delegation dialog.
 *
 * The challenge nonce is kept strictly in this controller's closure, never in
 * Solid signals, props, view state, logs, tools or events. `prepare` happens
 * only after the user has reviewed the terms and target; `confirm` consumes the
 * stored challenge without auto-retry. Every response is checked against the
 * panel epoch and session before it can toast, refresh or store a challenge.
 *
 * Mismatches fail closed with generic nonce-safe errors.
 */

import type { TuiPort } from "../host/tui.ts"
import { WATCH_CORRECTION_TERMS } from "../domain/watch.ts"
import {
  readWatchDelegationGrantPayload,
  type DelegationChallengeView,
} from "../rpc.ts"
import { WATCH_DELEGATION_TERMS } from "../watch/delegation.ts"
import type { WatchDelegationFeed } from "./watch-delegation-feed.ts"

export interface DelegationFlowDeps {
  readonly port: TuiPort
  readonly feed: WatchDelegationFeed
  readonly isDisposed: () => boolean
  readonly panel: () => {
    readonly sessionID: string | undefined
    readonly parentTaskID: string | undefined
    readonly expectedVersion: number | undefined
    readonly open: boolean
  }
  readonly epoch: () => number
}

export interface PreparedDelegationChallengeSafeView {
  readonly reviewSummary: string
  readonly targetSessionID: string
  readonly mode: "alert" | "limited-correction"
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly expiresAt: number
}

export interface DelegationFlow {
  prepare(
    targetSessionID: string,
    mode: "alert" | "limited-correction",
  ): Promise<PreparedDelegationChallengeSafeView | undefined>
  confirm(): Promise<void>
  revoke(targetSessionID: string): Promise<void>
  cancel(): void
  clear(): void
}

export function createDelegationFlow(deps: DelegationFlowDeps): DelegationFlow {
  const { port, feed } = deps
  let pending: DelegationChallengeView | undefined

  const stillCurrent = (sessionID: string, parentTaskID: string, startedEpoch: number): boolean => {
    const panel = deps.panel()
    return (
      !deps.isDisposed() &&
      deps.epoch() === startedEpoch &&
      panel.open &&
      panel.sessionID === sessionID &&
      panel.parentTaskID === parentTaskID
    )
  }

  const prepare = async (
    targetSessionID: string,
    mode: "alert" | "limited-correction",
  ): Promise<PreparedDelegationChallengeSafeView | undefined> => {
    const panel = deps.panel()
    if (
      deps.isDisposed() ||
      !panel.open ||
      panel.sessionID === undefined ||
      panel.parentTaskID === undefined ||
      panel.expectedVersion === undefined
    ) {
      return undefined
    }
    if (port.watchDelegation === undefined) {
      port.toast("Delegation is unavailable in this build.", "warning")
      return undefined
    }
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const parentTaskID = panel.parentTaskID
    const expectedVersion = panel.expectedVersion

    let answer: unknown
    try {
      answer = await port.watchDelegation.call({
        operation: "prepare",
        sessionID,
        parentTaskID,
        expectedVersion,
        targetSessionID,
        mode,
        ...(mode === "limited-correction" ? { deployment: "single-host-same-location" } : {}),
      })
    } catch {
      if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return undefined
      port.toast(
        "Could not prepare delegation grant: the request failed; re-read the task before trying again.",
        "error",
      )
      feed.refresh()
      return undefined
    }
    if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return undefined
    const payload = readWatchDelegationGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not prepare delegation grant: the answer was not understood.",
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    if (!payload.ok || payload.failure !== null || payload.challenge === null) {
      port.toast(
        `Could not prepare delegation grant: ${payload.failure?.code ?? "no challenge was issued"}.`,
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    const challenge = payload.challenge
    if (
      challenge.parentTaskID !== parentTaskID ||
      challenge.expectedVersion !== expectedVersion ||
      challenge.targetSessionID !== targetSessionID ||
      challenge.mode !== mode ||
      (mode === "limited-correction" && challenge.deployment !== "single-host-same-location")
    ) {
      port.toast(
        "Could not prepare delegation grant: the challenge belongs to another task or target parameters.",
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    if (
      challenge.reviewSummary !== WATCH_DELEGATION_TERMS ||
      payload.review.delegationTerms !== WATCH_DELEGATION_TERMS ||
      (mode === "limited-correction" && payload.review.correctionTerms !== WATCH_CORRECTION_TERMS)
    ) {
      port.toast(
        "Could not prepare delegation grant: the challenge terms summary did not match canonical terms.",
        "error",
      )
      pending = undefined
      feed.refresh()
      return undefined
    }
    pending = challenge
    return {
      reviewSummary: challenge.reviewSummary,
      targetSessionID: challenge.targetSessionID,
      mode: challenge.mode,
      scopeDirectory: challenge.scopeDirectory,
      scopePeerScope: challenge.scopePeerScope,
      expiresAt: challenge.expiresAt,
    }
  }

  const confirm = async (): Promise<void> => {
    const challenge = pending
    const panel = deps.panel()
    if (
      challenge === undefined ||
      deps.isDisposed() ||
      !panel.open ||
      panel.sessionID === undefined ||
      panel.parentTaskID === undefined ||
      port.watchDelegation === undefined
    ) {
      return
    }
    if (
      challenge.reviewSummary !== WATCH_DELEGATION_TERMS ||
      challenge.parentTaskID !== panel.parentTaskID ||
      challenge.expectedVersion !== panel.expectedVersion
    ) {
      pending = undefined
      port.toast(
        "Could not confirm delegation grant: the review terms or task version changed.",
        "error",
      )
      feed.refresh()
      return
    }
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const parentTaskID = panel.parentTaskID

    let answer: unknown
    try {
      answer = await port.watchDelegation.call({
        operation: "confirm",
        sessionID,
        parentTaskID: challenge.parentTaskID,
        expectedVersion: challenge.expectedVersion,
        targetSessionID: challenge.targetSessionID,
        challenge: challenge.challenge,
        generation: challenge.generation,
        termsDigest: challenge.termsDigest,
        scopeDirectory: challenge.scopeDirectory,
        scopePeerScope: challenge.scopePeerScope,
        ...(challenge.deployment === undefined ? {} : { deployment: challenge.deployment }),
      })
    } catch {
      if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return
      pending = undefined
      port.toast(
        "Could not confirm delegation grant: the confirmation request failed; no retry was attempted.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return
    pending = undefined
    const payload = readWatchDelegationGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not confirm delegation grant: the answer was not understood.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!payload.ok || payload.failure !== null) {
      port.toast(
        `Could not confirm delegation grant: ${payload.failure?.code ?? "the grant was not recorded"}.`,
        "error",
      )
      feed.refresh()
      return
    }
    feed.refresh()
    port.toast("Delegation grant recorded; authorization is not delivery. Check child status.", "success")
  }

  const revoke = async (targetSessionID: string): Promise<void> => {
    const panel = deps.panel()
    if (
      deps.isDisposed() ||
      !panel.open ||
      panel.sessionID === undefined ||
      panel.parentTaskID === undefined ||
      panel.expectedVersion === undefined ||
      port.watchDelegation === undefined
    ) {
      return
    }
    const startedEpoch = deps.epoch()
    const sessionID = panel.sessionID
    const parentTaskID = panel.parentTaskID
    const expectedVersion = panel.expectedVersion

    let answer: unknown
    try {
      answer = await port.watchDelegation.call({
        operation: "revoke",
        sessionID,
        parentTaskID,
        expectedVersion,
        targetSessionID,
      })
    } catch {
      if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return
      port.toast(
        "Could not revoke delegation grant: the request failed; re-read the task.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!stillCurrent(sessionID, parentTaskID, startedEpoch)) return
    pending = undefined
    const payload = readWatchDelegationGrantPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not revoke delegation grant: the answer was not understood.",
        "error",
      )
      feed.refresh()
      return
    }
    if (!payload.ok || payload.failure !== null) {
      port.toast(
        `Could not revoke delegation grant: ${payload.failure?.code ?? "the grant was not revoked"}.`,
        "error",
      )
      feed.refresh()
      return
    }
    feed.refresh()
    port.toast(
      `Delegation grant revoked for ${targetSessionID}. Existing child attempts are unchanged.`,
      "success",
    )
  }

  return {
    prepare,
    confirm,
    revoke,
    cancel: () => {
      pending = undefined
    },
    clear: () => {
      pending = undefined
    },
  }
}
