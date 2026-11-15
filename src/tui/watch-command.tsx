/** @jsxImportSource @opentui/solid */

/**
 * `/peers-watch`: the one human entry to the watchdog.
 *
 * Opening the command (or `show`) is one read-only snapshot of this session's
 * task. `enroll` is explicit and alert-only; `pause` and `end` carry the task
 * id and version the reader saw. The panel's `p`/`x` keys use the same RPC
 * calls after their own confirmation. No branch here prompts, generates or
 * interrupts a business session, and no branch reads the roster or another
 * location.
 *
 * A control answer is applied before the follow-up read, so the panel does not
 * briefly show the state the user just changed. A failure is a toast plus a
 * read, never an automatic retry of the write. Alert acknowledgement is the
 * same lifecycle but changes only the read flag; the single non-intrusive
 * reminder is driven by a durable `escalatedAt` fact, never by the event alone.
 */

import { randomUUID } from "node:crypto"

import type { TuiPort } from "../host/tui.ts"
import { readWatchPayload, type WatchPayload } from "../rpc.ts"
import { alertItems } from "./watch-alerts.ts"
import { failureText } from "./feed.ts"
import { WatchDialog } from "./watch-dialog.tsx"
import { createGrantFlow } from "./watch-grant-flow.ts"
import { createWatchFeed } from "./watch-feed.ts"

const USAGE =
  "usage: /peers-watch [enroll <goal> | pause <taskID> <version> | end <taskID> <version>]"

const NO_SESSION = "Peers watch: no session is open here."

/**
 * Registers the command and returns the disposer that ends the feed's
 * subscription. Tests call this through a fake TuiPort; the plugin's setup
 * calls it with the real one.
 */
export interface WatchCommandOptions {
  /** Local clock for notification freshness only; never used for task decisions. */
  readonly now?: () => number
}

export function installWatch(port: TuiPort, options: WatchCommandOptions = {}): () => void {
  const now = options.now ?? (() => Date.now())
  const feed = createWatchFeed(port.watch)
  let panelSessionID: string | undefined
  let panelOpen = false
  let disposed = false
  /**
   * Local notice bookkeeping for this panel's lifetime. It is not a claim of
   * cross-reload global dedupe; the durable fact is `escalatedAt` in the alert.
   */
  const seenEscalations = new Set<string>()
  const remindedAlertIDs = new Set<string>()
  /**
   * A failed/unavailable or task-less payload is not a trustworthy alert-list
   * seed. Remain in seeding mode until a successful payload for a task with an
   * available alert list arrives; otherwise a later recovery would look like a
   * new escalation and toast old alerts.
   */
  let notificationSeeding = true
  /** First trusted seed boundary; escalations at or before it are history. */
  let notificationReadyAt: number | undefined

  feed.onSnapshot((payload) => {
    if (disposed) return
    if (notificationSeeding) {
      if (!seedableAlerts(payload)) return
      // Opening/reconnect shows existing unread alerts but never re-toasts them.
      seenEscalations.clear()
      remindedAlertIDs.clear()
      for (const alert of alertItems(payload.alerts)) {
        if (alert.escalatedAt !== null) {
          seenEscalations.add(escalationKey(alert))
          // It already had its one escalation before this panel saw it.
          remindedAlertIDs.add(alert.alertID)
        }
      }
      notificationSeeding = false
      notificationReadyAt = now()
      return
    }
    if (!panelOpen) return
    if (!payload.alerts.available) return
    if (payload.task?.watchState !== "active") return
    for (const alert of alertItems(payload.alerts)) {
      if (
        alert.state !== "unread" ||
        alert.resolvedAt !== null ||
        alert.escalatedAt === null
      ) {
        continue
      }
      const key = escalationKey(alert)
      if (seenEscalations.has(key)) continue
      if (notificationReadyAt === undefined || alert.escalatedAt <= notificationReadyAt) {
        seenEscalations.add(key)
        continue
      }
      if (remindedAlertIDs.has(alert.alertID)) {
        seenEscalations.add(key)
        continue
      }
      seenEscalations.add(key)
      remindedAlertIDs.add(alert.alertID)
      port.toast(`Watch alert: ${alert.summary}`, "warning")
    }
  })
  /**
   * Changes whenever the visible panel changes or the plugin unloads. A reply
   * is only allowed to touch the panel epoch it was requested from.
   */
  let lifecycleEpoch = 0
  const grant = createGrantFlow({
    port,
    feed,
    isDisposed: () => disposed,
    panel: () => ({ sessionID: panelSessionID, open: panelOpen }),
    epoch: () => lifecycleEpoch,
  })

  const open = (sessionID: string): void => {
    if (disposed) return
    const openedEpoch = ++lifecycleEpoch
    panelSessionID = sessionID
    panelOpen = true
    grant.clear()
    notificationSeeding = true
    notificationReadyAt = undefined
    seenEscalations.clear()
    remindedAlertIDs.clear()
    feed.open(sessionID)
    port.dialog.show(
      () => (
        <WatchDialog
          state={feed.state}
          sessionID={sessionID}
          palette={port.palette}
          onPause={async (taskID, version) => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return
            await control("pause", taskID, version, true)
          }}
          onEnd={async (taskID, version) => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return
            await control("end", taskID, version, true)
          }}
          onAck={async (alertID) => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return
            await acknowledge(alertID)
          }}
          onGrantPrepare={async () => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return undefined
            return grant.prepare()
          }}
          onGrantConfirm={async () => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return
            await grant.confirm()
          }}
          onGrantCancel={() => grant.cancel()}
          onDowngrade={async () => {
            if (disposed || openedEpoch !== lifecycleEpoch || panelSessionID !== sessionID) return
            await grant.downgrade()
          }}
        />
      ),
      // A close from an older panel must not act for the one on screen now.
      () => {
        if (disposed || openedEpoch !== lifecycleEpoch) return
        panelOpen = false
        panelSessionID = undefined
        grant.clear()
        lifecycleEpoch += 1
        feed.close()
      },
    )
    port.dialog.set({ size: "xlarge", centered: true })
  }

  const openCurrent = (): void => {
    if (disposed) return
    const { sessionID } = port.currentSession()
    if (sessionID === undefined) {
      port.toast(NO_SESSION, "warning")
      return
    }
    open(sessionID)
  }

  const enroll = async (goal: string): Promise<void> => {
    if (disposed) return
    const startedEpoch = lifecycleEpoch
    const stillCurrent = () => !disposed && lifecycleEpoch === startedEpoch
    const { sessionID } = port.currentSession()
    if (sessionID === undefined) {
      port.toast(NO_SESSION, "warning")
      return
    }
    const requestId = `ui-${randomUUID()}`
    let answer: unknown
    try {
      answer = await port.watch.call({
        operation: "enroll",
        sessionID,
        requestId,
        goal,
        targetSessionID: sessionID,
        mode: "alert",
      })
    } catch (error) {
      if (!stillCurrent()) return
      port.toast(`Could not enroll the watch: ${failureText(error)}`, "error")
      open(sessionID)
      return
    }
    if (!stillCurrent()) return
    const payload = readWatchPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not enroll the watch: the answer was not a watch state this view understands.",
        "error",
      )
      open(sessionID)
      return
    }
    if (payload.failure !== null) {
      port.toast(`Could not enroll the watch: ${payload.failure.reason}`, "error")
      open(sessionID)
      return
    }
    open(sessionID)
    port.toast("Watch enrolled. No prompt was sent.", "success")
  }

  const acknowledge = async (alertID: string): Promise<void> => {
    if (disposed || !panelOpen || panelSessionID === undefined) return
    const startedEpoch = lifecycleEpoch
    const sessionID = panelSessionID
    const stillCurrent = () =>
      !disposed &&
      lifecycleEpoch === startedEpoch &&
      panelOpen &&
      panelSessionID === sessionID

    const state = feed.state()
    if (state.kind !== "payload" || state.payload.task === null) return
    if (!state.payload.alerts.available) return
    const allowed = state.payload.controls.acknowledge
    if (!allowed.enabled) {
      port.toast(allowed.reason ?? "Acknowledgement is unavailable.", "warning")
      return
    }
    const alert = alertItems(state.payload.alerts).find((item) => item.alertID === alertID)
    if (alert === undefined) {
      port.toast("That alert is no longer in the current snapshot.", "warning")
      feed.refresh()
      return
    }
    if (alert.state !== "unread") return

    let answer: unknown
    try {
      answer = await port.watch.call({ operation: "ack", sessionID, alertID })
    } catch (error) {
      if (!stillCurrent()) return
      port.toast(`Could not mark the alert read: ${failureText(error)}`, "error")
      feed.refresh()
      return
    }
    if (!stillCurrent()) return
    const payload = readWatchPayload(answer)
    if (payload === undefined) {
      port.toast(
        "Could not mark the alert read: the answer was not a watch state this view understands.",
        "error",
      )
      feed.refresh()
      return
    }
    if (payload.failure !== null) {
      port.toast(
        `Could not mark the alert read: ${payload.failure.code}: ${payload.failure.reason}`,
        "error",
      )
      feed.refresh()
      return
    }
    feed.apply(payload)
    feed.refresh()
    port.toast("Alert marked read. This does not resume, retry or reset the watch.", "success")
  }

  const control = async (
    operation: "pause" | "end",
    taskID: string,
    expectedVersion: number,
    fromPanel: boolean,
  ): Promise<void> => {
    if (disposed) return
    const startedEpoch = lifecycleEpoch
    const sessionID = fromPanel ? panelSessionID : port.currentSession().sessionID
    if (sessionID === undefined) {
      port.toast(NO_SESSION, "warning")
      return
    }
    const stillCurrent = () =>
      !disposed &&
      lifecycleEpoch === startedEpoch &&
      (!fromPanel || (panelOpen && panelSessionID === sessionID))

    if (fromPanel) {
      const state = feed.state()
      if (state.kind !== "payload" || state.payload.task === null) return
      const current = state.payload.task
      const allowed = state.payload.controls[operation]
      if (!allowed.enabled) {
        const verb = operation === "pause" ? "paused" : "ended"
        port.toast(allowed.reason ?? `The watch cannot be ${verb}.`, "warning")
        feed.refresh()
        return
      }
      if (current.taskID !== taskID || current.version !== expectedVersion) {
        port.toast(
          "The watch changed since it was read. The panel now shows the current state.",
          "warning",
        )
        feed.refresh()
        return
      }
    }

    let answer: unknown
    try {
      answer = await port.watch.call({ operation, sessionID, taskID, expectedVersion })
    } catch (error) {
      if (!stillCurrent()) return
      port.toast(`Could not ${operation} the watch: ${failureText(error)}`, "error")
      if (fromPanel) feed.refresh()
      else open(sessionID)
      return
    }
    if (!stillCurrent()) return
    const payload = readWatchPayload(answer)
    if (payload === undefined) {
      port.toast(
        `Could not ${operation} the watch: the answer was not a watch state this view understands.`,
        "error",
      )
      if (fromPanel) feed.refresh()
      else open(sessionID)
      return
    }
    if (payload.failure !== null) {
      port.toast(
        `Could not ${operation} the watch: ${payload.failure.code}: ${payload.failure.reason}`,
        "error",
      )
      if (fromPanel) feed.refresh()
      else open(sessionID)
      return
    }

    if (fromPanel) {
      // The response is the state the plugin just committed; show it before
      // the read that may still have been in flight when it arrived.
      feed.apply(payload)
      feed.refresh()
    } else {
      open(sessionID)
    }
    port.toast(successText(operation, payload.task), "success")
  }

  port.command({
    id: "session-peers.watch",
    title: "Session watch",
    group: "Session",
    slash: "peers-watch",
    arguments: true,
    run: (input) => {
      if (disposed) return
      const text = input?.trim() ?? ""
      if (text === "" || text === "show") {
        openCurrent()
        return
      }
      const words = text.split(/\s+/).filter((word) => word.length > 0)
      const [operation, ...rest] = words
      switch (operation) {
        case "enroll": {
          const goal = rest.join(" ").trim()
          if (goal.length === 0) {
            port.toast(USAGE, "warning")
            return
          }
          void enroll(goal)
          return
        }
        case "pause":
        case "end": {
          const taskID = rest[0]
          const version = rest[1] === undefined ? Number.NaN : Number.parseInt(rest[1], 10)
          if (taskID === undefined || !Number.isSafeInteger(version) || version < 1) {
            port.toast(USAGE, "warning")
            return
          }
          void control(operation, taskID, version, false)
          return
        }
        case "delegate":
          port.toast(
            "Child-task enrollment is unavailable in this build; enroll this session itself.",
            "warning",
          )
          return
        case "grant":
          port.toast(
            "Open /peers-watch, then c: correction and g: review grant; this command cannot grant.",
            "warning",
          )
          return
        case "correct":
        case "receipt":
          port.toast(
            "Sending a correction and submitting a receipt are model-tool paths; this panel cannot do either.",
            "warning",
          )
          return
        case "transfer":
          port.toast("Watch ownership transfer is unavailable in this build.", "warning")
          return
        case "resume":
          port.toast("Resume is unavailable in this build.", "warning")
          return
        default:
          port.toast(USAGE, "warning")
      }
    },
  })

  return () => {
    if (disposed) return
    disposed = true
    panelOpen = false
    panelSessionID = undefined
    grant.clear()
    lifecycleEpoch += 1
    feed.dispose()
  }
}

function successText(operation: "pause" | "end", task: WatchPayload["task"]): string {
  if (operation === "pause") return "Watch paused. The session keeps running."
  if (task?.taskState === "completed") return "Watch ended. The task remains completed."
  return "Watch ended. This is not a business success."
}

function seedableAlerts(payload: WatchPayload): boolean {
  return (
    payload.failure === null &&
    payload.ledger.available &&
    payload.task !== null &&
    payload.alerts.available
  )
}

function escalationKey(alert: { readonly alertID: string; readonly escalatedAt: number | null }): string {
  return `${alert.alertID}:${alert.escalatedAt ?? "none"}`
}
