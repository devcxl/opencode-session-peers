/**
 * The read-only delegation pane, independent of the shared watch skeleton.
 *
 * It renders the parent's controlled delegation grants and the direct-child
 * view. An unauthorized child contributes only its identifiers, authorization
 * reason and grant metadata; its goal, reports and alerts are not rendered.
 */

import type { TableCell, Tone } from "./view.ts"
import { cell, ensurePeriod, formatWatchTime, join } from "./watch-format.ts"
import type { DelegatedChildView, WatchDelegationView } from "../watch/delegation-view.ts"
import type { WatchDelegationViewPayload } from "../watch/delegation-contract.ts"

export type DelegationPaneState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "payload"; readonly payload: WatchDelegationViewPayload }

export interface WatchDelegationInput {
  readonly state: DelegationPaneState
  /** The parent session reading the pane. */
  readonly sessionID: string
}

export interface WatchDelegationContent {
  readonly title: string
  readonly contextLines: readonly string[]
  readonly columns: readonly TableCell[]
  readonly rows: readonly (readonly TableCell[])[]
  readonly notes: readonly string[]
  readonly noteTone: Tone
}

export const DELEGATION_COLUMNS: readonly TableCell[] = [
  cell("Child", "muted"),
  cell("Goal", "muted"),
  cell("State", "muted"),
  cell("Authorization", "muted"),
]

export function watchDelegationContent(input: WatchDelegationInput): WatchDelegationContent {
  switch (input.state.kind) {
    case "loading":
      return {
        title: "Session watch — delegation",
        contextLines: ["reading the delegation view…"],
        columns: DELEGATION_COLUMNS,
        rows: [],
        notes: [],
        noteTone: "muted",
      }
    case "failed":
      return {
        title: "Session watch — delegation unavailable",
        contextLines: [],
        columns: [],
        rows: [],
        notes: [input.state.reason],
        noteTone: "error",
      }
    case "payload":
      return payloadContent(input.state.payload, input.sessionID)
  }
}

function payloadContent(payload: WatchDelegationViewPayload, sessionID: string): WatchDelegationContent {
  if (!payload.ok) {
    return {
      title: "Session watch — delegation unavailable",
      contextLines: [],
      columns: [],
      rows: [],
      notes: [
        `${payload.failure?.code ?? "unknown"}: ${payload.failure?.reason ?? "the delegation view failed"}`,
        "No prompt, model generation or interrupt was sent.",
      ],
      noteTone: "error",
    }
  }
  const notes: string[] = []
  if (payload.grants.length === 0) {
    notes.push("No controlled delegation grant exists for this parent task.")
  } else {
    notes.push(
      `Grants: ${payload.grants
        .map((grant) => `${grant.targetSessionID} ${grant.mode}/${grant.state} v${grant.version}`)
        .join(", ")}.`,
    )
  }
  if (payload.children.length === 0) {
    notes.push("No direct child task is enrolled under this parent.")
  }
  for (const child of payload.children) {
    if (!child.authorized) {
      notes.push(
        `Child ${fold(child.targetSessionID)} is not readable: ${ensurePeriod(child.authorization.reason ?? "the fresh authority check refuses it")} No goal, report or alert is shown.`,
      )
    }
  }
  notes.push("This pane is a read. Opening it does not prompt, wake or correct any child session.")
  return {
    title: "Session watch — delegation",
    contextLines: [
      `parent task: ${payload.parentTaskID}`,
      `parent session: ${fold(payload.parentSessionID)}${payload.parentSessionID === sessionID ? " (this session)" : ""}`,
      `children: ${payload.children.length}`,
    ],
    columns: DELEGATION_COLUMNS,
    rows: payload.children.map((child) => childRow(child)),
    notes,
    noteTone: "muted",
  }
}

function childRow(child: DelegatedChildView): readonly TableCell[] {
  if (!child.authorized || child.task === null) {
    return [
      cell(fold(child.targetSessionID), "base"),
      cell("not readable", "muted"),
      cell("unknown", "muted"),
      cell(child.authorization.reason ?? "not authorized", "error"),
    ]
  }
  const task = child.task
  const correction = task.correction
  return [
    cell(fold(child.targetSessionID), "base"),
    cell(task.goal, "base"),
    cell(`${task.taskState} · supervision ${task.watchState}`, "base"),
    cell(
      join(
        `${child.authorization.mode ?? "unknown"} grant v${child.authorization.grantVersion ?? "?"}`,
        `scope ${child.authorization.scopePeerScope ?? "unknown"}`,
        `correction ${correction.actual}`,
        `checked ${formatWatchTime(child.authorization.checkedAt)}`,
      ),
      correction.actual === "ready" ? "base" : "muted",
    ),
  ]
}

function fold(sessionID: string): string {
  return sessionID.length <= 12 ? sessionID : `${sessionID.slice(0, 8)}…${sessionID.slice(-4)}`
}

/** Exported for a caller that only has the wire view type. */
export function delegationChildCount(view: WatchDelegationView | null): number {
  return view?.children.length ?? 0
}
