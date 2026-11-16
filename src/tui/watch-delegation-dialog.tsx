/**
 * The controlled direct-child delegation dialog.
 *
 * It provides an inspection view of direct children under the parent task and a
 * two-step controlled grant review flow. The challenge nonce is never kept in
 * view state or rendered to the screen.
 */

import { createMemo, createSignal, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"

import type { TuiPalette } from "../host/tui.ts"
import { WATCH_CORRECTION_TERMS } from "../domain/watch.ts"
import { WATCH_DELEGATION_TERMS } from "../watch/delegation.ts"
import { colourFor, tableStyle } from "./table.ts"
import {
  watchDelegationContent,
  type DelegationPaneState,
} from "./watch-delegation.ts"
import type { PreparedDelegationChallengeSafeView } from "./watch-delegation-flow.ts"
import { formatWatchTime } from "./watch-format.ts"

export interface WatchDelegationDialogProps {
  readonly state: () => DelegationPaneState
  readonly sessionID: string
  readonly parentTaskID: string
  readonly parentVersion: number
  readonly palette: () => TuiPalette
  readonly initialTargetSessionID?: string
  readonly initialMode?: "alert" | "limited-correction"
  readonly onPrepare?: (
    targetSessionID: string,
    mode: "alert" | "limited-correction",
  ) => Promise<PreparedDelegationChallengeSafeView | undefined>
  readonly onConfirm?: () => Promise<void>
  readonly onRevoke?: (targetSessionID: string) => Promise<void>
  readonly onCancel?: () => void
  readonly onClose?: () => void
}

type DelegationStage = "input" | "review" | "confirm" | "revoke"

export function WatchDelegationDialog(props: WatchDelegationDialogProps): JSX.Element {
  const [stage, setStage] = createSignal<DelegationStage | undefined>(
    props.initialTargetSessionID !== undefined ? "review" : undefined,
  )
  const [targetInput, setTargetInput] = createSignal(props.initialTargetSessionID ?? "")
  const [mode, setMode] = createSignal<"alert" | "limited-correction">(
    props.initialMode ?? "alert",
  )
  const [revokeTarget, setRevokeTarget] = createSignal<string | undefined>()
  const [preparedView, setPreparedView] = createSignal<
    PreparedDelegationChallengeSafeView | undefined
  >()
  const [busy, setBusy] = createSignal(false)

  const colour = (tone: "base" | "muted" | "error") => colourFor(tone, props.palette())

  const activeGrants = createMemo(() => {
    const s = props.state()
    if (s.kind !== "payload" || !s.payload.ok) return []
    return s.payload.grants.filter((g) => g.state === "granted")
  })

  const actPrepare = async (): Promise<void> => {
    const target = targetInput().trim()
    if (target.length === 0 || props.onPrepare === undefined) return
    setBusy(true)
    try {
      const prepared = await props.onPrepare(target, mode())
      if (prepared !== undefined) {
        setPreparedView(prepared)
        setStage("confirm")
      } else {
        setStage(undefined)
        props.onCancel?.()
      }
    } finally {
      setBusy(false)
    }
  }

  const actConfirm = async (): Promise<void> => {
    if (props.onConfirm === undefined) return
    setBusy(true)
    try {
      await props.onConfirm()
    } finally {
      setBusy(false)
      setStage(undefined)
      setPreparedView(undefined)
    }
  }

  const actRevoke = async (target: string): Promise<void> => {
    if (props.onRevoke === undefined) return
    setBusy(true)
    try {
      await props.onRevoke(target)
    } finally {
      setBusy(false)
      setStage(undefined)
      setRevokeTarget(undefined)
    }
  }

  useKeyboard((key) => {
    if (busy()) return
    const currentStage = stage()

    if (currentStage === "input") {
      if (key.name === "escape") {
        setStage(undefined)
        props.onCancel?.()
        return
      }
      if (key.name === "m" || key.name === "tab") {
        setMode((current) => (current === "alert" ? "limited-correction" : "alert"))
        return
      }
      if (key.name === "enter" || key.name === "return") {
        if (targetInput().trim().length > 0) {
          setStage("review")
        }
        return
      }
      if (key.name === "backspace") {
        setTargetInput((current) => current.slice(0, -1))
        return
      }
      if (key.raw !== undefined && key.raw.length === 1 && /^[\w.:-]$/.test(key.raw)) {
        setTargetInput((current) => current + key.raw)
        return
      }
      return
    }

    if (currentStage === "review") {
      if (key.name === "y") {
        void actPrepare()
        return
      }
      if (key.name === "n" || key.name === "escape") {
        setStage(undefined)
        props.onCancel?.()
        return
      }
      return
    }

    if (currentStage === "confirm") {
      if (key.name === "y") {
        void actConfirm()
        return
      }
      if (key.name === "n" || key.name === "escape") {
        setStage(undefined)
        setPreparedView(undefined)
        props.onCancel?.()
        return
      }
      return
    }

    if (currentStage === "revoke") {
      const target = revokeTarget()
      if (key.name === "y" && target !== undefined) {
        void actRevoke(target)
        return
      }
      if (key.name === "n" || key.name === "escape") {
        setStage(undefined)
        setRevokeTarget(undefined)
        return
      }
      return
    }

    // Default stage (table view)
    if (key.name === "escape" || key.name === "esc" || key.name === "q") {
      props.onClose?.()
      return
    }
    if (key.name === "g") {
      if (targetInput().trim().length > 0) {
        setStage("review")
      } else {
        setStage("input")
      }
      return
    }
    if (key.name === "r") {
      const grants = activeGrants()
      if (grants.length > 0) {
        setRevokeTarget(grants[0]!.targetSessionID)
        setStage("revoke")
      }
      return
    }
  })

  const content = createMemo(() => {
    return watchDelegationContent({ state: props.state(), sessionID: props.sessionID })
  })

  const reviewLines = createMemo(() => {
    const lines: string[] = []
    lines.push(`Target child session: ${targetInput().trim()}`)
    lines.push(`Delegation mode: ${mode()}`)
    lines.push("")
    lines.push(WATCH_DELEGATION_TERMS)
    if (mode() === "limited-correction") {
      lines.push("")
      lines.push(WATCH_CORRECTION_TERMS)
      lines.push("Single-host declaration is not proof of uniqueness; controlled channel is not human authentication.")
      lines.push("Effective round parameters: defaults 5m post-attempt cooldown, 20m problem round limit.")
    }
    return lines
  })

  const confirmLines = createMemo(() => {
    const prep = preparedView()
    if (prep === undefined) return ["Challenge prepared."]
    return [
      `Challenge prepared for child session: ${prep.targetSessionID}`,
      `Mode: ${prep.mode}`,
      `Scope: ${prep.scopeDirectory} (${prep.scopePeerScope})`,
      `Expires: ${formatWatchTime(prep.expiresAt)}`,
    ]
  })

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <text fg={colour("base")}>
        <b>
          {stage() === "review"
            ? "Session watch — delegation review"
            : stage() === "confirm"
              ? "Session watch — delegation confirmation"
              : stage() === "input"
                ? "Session watch — select delegation target"
                : stage() === "revoke"
                  ? "Session watch — revoke delegation grant"
                  : content().title}
        </b>
      </text>

      {stage() === undefined && (
        <>
          <text fg={colour("muted")}>{content().contextLines.join("\n")}</text>
          <text_table
            style={tableStyle(content().columns, content().rows, props.palette())}
          />
          <text fg={colour("muted")}>
            {busy() ? "Working…" : "g: grant delegation · r: revoke delegation · esc: close"}
          </text>
          <text fg={colour(content().noteTone)}>{content().notes.join("\n")}</text>
        </>
      )}

      {stage() === "input" && (
        <>
          <text fg={colour("base")}>
            Target child session ID: {targetInput() || "_(type session ID)_"}
          </text>
          <text fg={colour("muted")}>
            Mode: {mode()} (press m or tab to toggle mode)
          </text>
          <text fg={colour("base")}>
            {busy() ? "Working…" : "enter: review terms · escape: cancel"}
          </text>
        </>
      )}

      {stage() === "review" && (
        <>
          <text fg={colour("base")}>{reviewLines().join("\n")}</text>
          <text fg={colour("base")}>
            {busy() ? "Working…" : "y: declare + prepare challenge · n: cancel"}
          </text>
        </>
      )}

      {stage() === "confirm" && (
        <>
          <text fg={colour("base")}>{confirmLines().join("\n")}</text>
          <text fg={colour("base")}>
            {busy() ? "Working…" : "y: grant · n: cancel"}
          </text>
        </>
      )}

      {stage() === "revoke" && (
        <>
          <text fg={colour("base")}>
            Revoke delegation grant for {revokeTarget()}?
          </text>
          <text fg={colour("muted")}>
            Existing child attempts and accepted reports are not reset.
          </text>
          <text fg={colour("base")}>
            {busy() ? "Working…" : "y: revoke · n: cancel"}
          </text>
        </>
      )}
    </box>
  )
}
