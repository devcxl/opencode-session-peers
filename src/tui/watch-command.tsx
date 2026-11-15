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
 * read, never an automatic retry of the write.
 */

import { randomUUID } from "node:crypto"

import type { TuiPort } from "../host/tui.ts"
import { readWatchPayload, type WatchPayload } from "../rpc.ts"
import { failureText } from "./feed.ts"
import { WatchDialog } from "./watch-dialog.tsx"
import { createWatchFeed } from "./watch-feed.ts"

const USAGE =
  "usage: /peers-watch [enroll <goal> | pause <taskID> <version> | end <taskID> <version>]"

const NO_SESSION = "Peers watch: no session is open here."

/**
 * Registers the command and returns the disposer that ends the feed's
 * subscription. Tests call this through a fake TuiPort; the plugin's setup
 * calls it with the real one.
 */
export function installWatch(port: TuiPort): () => void {
  const feed = createWatchFeed(port.watch)
  let panelSessionID: string | undefined

  const open = (sessionID: string): void => {
    panelSessionID = sessionID
    feed.open(sessionID)
    port.dialog.show(
      () => (
        <WatchDialog
          state={feed.state}
          sessionID={sessionID}
          palette={port.palette}
          onPause={(taskID, version) => control("pause", taskID, version, true)}
          onEnd={(taskID, version) => control("end", taskID, version, true)}
        />
      ),
      // The host closes on escape; the feed keeps its subscription but stops
      // its refresh floor until the next opening.
      () => feed.close(),
    )
    port.dialog.set({ size: "xlarge", centered: true })
  }

  const openCurrent = (): void => {
    const { sessionID } = port.currentSession()
    if (sessionID === undefined) {
      port.toast(NO_SESSION, "warning")
      return
    }
    open(sessionID)
  }

  const enroll = async (goal: string): Promise<void> => {
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
      port.toast(`Could not enroll the watch: ${failureText(error)}`, "error")
      open(sessionID)
      return
    }
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

  const control = async (
    operation: "pause" | "end",
    taskID: string,
    expectedVersion: number,
    fromPanel: boolean,
  ): Promise<void> => {
    const sessionID = fromPanel ? panelSessionID : port.currentSession().sessionID
    if (sessionID === undefined) {
      port.toast(NO_SESSION, "warning")
      return
    }

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
      port.toast(`Could not ${operation} the watch: ${failureText(error)}`, "error")
      if (fromPanel) feed.refresh()
      else open(sessionID)
      return
    }
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
        case "correct":
        case "receipt":
          port.toast(
            "Finite correction and correction receipts are unavailable in this build; this watch records reports only.",
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

  return () => feed.dispose()
}

function successText(operation: "pause" | "end", task: WatchPayload["task"]): string {
  if (operation === "pause") return "Watch paused. The session keeps running."
  if (task?.taskState === "completed") return "Watch ended. The task remains completed."
  return "Watch ended. This is not a business success."
}
