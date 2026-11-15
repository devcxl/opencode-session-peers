/**
 * The correction pane: authorization, actual capability, permanent attempts,
 * receipt/recovery and the gates that stop an automatic send.
 *
 * This pane is inspection only. It never sends a correction or a receipt; the
 * model-facing tool owns receipts, and the automatic executor is server-side.
 * A recorded grant is deliberately not rendered as a sent correction.
 */

import type { WatchPayload } from "../rpc.ts"
import { fact, formatWatchTime, join } from "./watch-format.ts"
import { pageOf, type PageWindow, type TableCell } from "./view.ts"

type Task = NonNullable<WatchPayload["task"]>
type Correction = Task["correction"]
type Attempt = Correction["history"][number]
type Gate = Correction["gates"][number]

export const GRANT_TERMS =
  "Correction grant terms: at most 3 permanent attempts in total; this build may automatically send only the first attempt; automatic sends require one OpenCode service, the same OS user and location; by choosing the declaration step you declare this task runs in one service at this host/location, but that declaration is not proof that no other service is running; the controlled panel confirmation channel is not same-OS-user authentication; any unsupported or uncertain condition stays alert-only; a safety pause or downgrade does not stop business work or reset used attempts."

export interface CorrectionOptions {
  readonly gatePage?: number
  readonly gatePageSize?: number
}

export interface CorrectionContent {
  readonly rows: readonly (readonly TableCell[])[]
  readonly notes: readonly string[]
  readonly gatePage: PageWindow
}

export function correctionRows(
  payload: WatchPayload,
  options: CorrectionOptions = {},
): CorrectionContent {
  const gatePageSize = options.gatePageSize ?? 4
  const gatePage = gatePageOf(payload, options.gatePage ?? 0, gatePageSize)
  const task = payload.task
  if (task === null) {
    return {
      rows: [fact("Correction", "none enrolled")],
      notes: ["No watched task is enrolled for this session.", "c: task · esc: close"],
      gatePage,
    }
  }
  const correction = task.correction
  const authorization = correction.authorization
  const attempts = uniqueAttempts(correction)
  const gates = correction.gates
  const failed = gates.filter((gate) => !gate.ok)
  const failedPage = failed.slice(gatePage.start, gatePage.start + gatePage.size)

  const rows: (readonly TableCell[])[] = [
    fact(
      "Authorization",
      join(
        modeText(authorization.mode),
        grantStateText(authorization.state),
        `version ${authorization.version}`,
        authorization.grantedAt === null ? undefined : `granted ${formatWatchTime(authorization.grantedAt)}`,
      ),
    ),
    fact("Deployment", deploymentText(authorization.deployment)),
    fact("Actual capability", actualText(correction)),
    fact("Policy", `first attempt only · hard limit ${correction.attempts.limit}`),
    fact("Attempts", `${correction.attempts.used} of ${correction.attempts.limit} used`),
    fact("Phase", correction.phase),
    fact("Business completed", correction.businessCompleted ? "yes" : "no"),
    fact("Stop", stopText(correction)),
    fact(
      "Gates",
      gates.length === 0 ? "not reported" : `${gates.length - failed.length} of ${gates.length} ok`,
    ),
  ]

  if (authorization.reviewSummary !== null) {
    rows.push(fact("Grant review", authorization.reviewSummary))
  }
  attempts.forEach((attempt) => {
    rows.push(fact(`Attempt ${attempt.ordinal}`, attemptText(attempt)))
  })
  failedPage.forEach((gate) => {
    rows.push(fact(`Gate ${gate.gate}`, gateText(gate)))
  })

  const notes: string[] = []
  notes.push("A recorded grant is not a sent correction; the server alone decides actual send capability.")
  if (authorization.state === "granted" && correction.actual === "unavailable") {
    notes.push(`Grant active; actual send remains unavailable — ${correction.actualReason}`)
  }
  if (authorization.state === "pending-confirmation") {
    notes.push("A grant is prepared but not confirmed; existing attempt history is unchanged.")
  }
  notes.push("A receipt or continue permit is not recovery and is not business completion.")
  if (correction.stop !== null) {
    notes.push(
      `Automatic send stopped: ${correction.stop.reason}${correction.stop.missingEvidence === null ? "" : ` · missing: ${correction.stop.missingEvidence}`}.`,
    )
  }
  if (correction.businessCompleted) {
    notes.push("Business completion is independent of supervision, grants and correction attempts.")
  }
  if (failed.length > 0) {
    notes.push(`Not ready for automatic send: ${failed.length} failed gate(s).`)
    const pageNote = gatePageNote(gatePage)
    if (pageNote !== undefined) notes.push(pageNote)
  }
  notes.push("Receipts are submitted only by the executing session through the model tool; this panel cannot send or fabricate one.")
  notes.push("No force resume, takeover, unknown clearing, refund or attempt reset is offered.")
  if (correction.controls.grant.enabled) notes.push("g: review correction grant")
  else notes.push(`Correction grant unavailable: ${correction.controls.grant.reason ?? "no reason given"}.`)
  if (correction.controls.downgrade.enabled) notes.push("d: downgrade to alert-only")
  else notes.push(`Downgrade unavailable: ${correction.controls.downgrade.reason ?? "no reason given"}.`)
  notes.push("c: task · esc: close")
  return { rows, notes, gatePage }
}

export function gatePageOf(
  payload: WatchPayload,
  requestedPage: number,
  pageSize: number,
): PageWindow {
  const failed = payload.task?.correction.gates.filter((gate) => !gate.ok).length ?? 0
  return pageOf(failed, pageSize, requestedPage)
}

export function gatePageSizeFor(terminalHeight: number): number {
  const rows = Math.floor((terminalHeight - 36) / 2)
  return Math.max(2, Math.min(5, rows))
}

function gatePageNote(page: PageWindow): string | undefined {
  if (page.count <= 1) return undefined
  const from = page.start + 1
  const to = Math.min(page.total, page.start + page.size)
  const span = from === to ? `gate ${from} of ${page.total}` : `gates ${from}–${to} of ${page.total}`
  return `showing failed ${span} · ←/→ to page gates`
}

function uniqueAttempts(correction: Correction): readonly Attempt[] {
  const byID = new Map<string, Attempt>()
  for (const attempt of correction.history) byID.set(attempt.attemptID, attempt)
  if (correction.last !== null) byID.set(correction.last.attemptID, correction.last)
  if (correction.pending !== null) byID.set(correction.pending.attemptID, correction.pending)
  return [...byID.values()].sort((left, right) => left.ordinal - right.ordinal)
}

function modeText(mode: Task["mode"]): string {
  return mode === "limited-correction" ? "limited correction" : "alert-only"
}

function grantStateText(state: Correction["authorization"]["state"]): string {
  switch (state) {
    case "not-granted":
      return "not granted"
    case "pending-confirmation":
      return "pending confirmation"
    case "granted":
      return "granted"
    case "revoked":
      return "revoked"
  }
}

function deploymentText(deployment: Correction["authorization"]["deployment"]): string {
  return deployment === "single-host-same-location"
    ? "single service · same host/location (declaration, not proof)"
    : "unknown"
}

function actualText(correction: Correction): string {
  return correction.actual === "ready"
    ? "ready"
    : `unavailable — ${correction.actualReason}`
}

function stopText(correction: Correction): string {
  if (correction.stop === null) return "—"
  return join(
    correction.stop.reason,
    correction.stop.missingEvidence === null ? undefined : `missing: ${correction.stop.missingEvidence}`,
  )
}

function attemptText(attempt: Attempt): string {
  const parts: string[] = [attempt.phase, `reserved ${formatWatchTime(attempt.reservedAt)}`]
  if (attempt.claimedAt !== null) parts.push(`claimed ${formatWatchTime(attempt.claimedAt)}`)
  if (attempt.acceptedAt !== null) parts.push(`accepted ${formatWatchTime(attempt.acceptedAt)}`)
  if (attempt.rejectedAt !== null) parts.push(`rejected ${formatWatchTime(attempt.rejectedAt)}`)
  if (attempt.unknownAt !== null) parts.push(`unknown ${formatWatchTime(attempt.unknownAt)}`)
  if (attempt.abortedAt !== null) parts.push(`aborted ${formatWatchTime(attempt.abortedAt)}`)
  if (attempt.seen !== null) {
    parts.push(`seen ${formatWatchTime(attempt.seen.at)}${attempt.seen.reason === null ? "" : ` — ${attempt.seen.reason}`}`)
  }
  if (attempt.receipt !== null) {
    parts.push(
      attempt.receipt.continuePermitIssuedAt === null
        ? `receipt ${formatWatchTime(attempt.receipt.at)} · no permit${attempt.receipt.refusalReason === null ? "" : ` — ${attempt.receipt.refusalReason}`}`
        : `receipt ${formatWatchTime(attempt.receipt.at)} · permit ${formatWatchTime(attempt.receipt.continuePermitIssuedAt)}`,
    )
  }
  if (attempt.recovery !== null) {
    parts.push(
      `recovered ${formatWatchTime(attempt.recovery.at)} · ${attempt.recovery.progressReportID} → ${attempt.recovery.resultReference}`,
    )
  }
  if (attempt.stopReason !== null) parts.push(`stop ${attempt.stopReason}`)
  return parts.join(" · ")
}

function gateText(gate: Gate): string {
  return join(
    gate.ok ? "ok" : (gate.reason ?? "not met"),
    gate.observed === null ? undefined : `observed: ${gate.observed}`,
    gate.required === null ? undefined : `required: ${gate.required}`,
  )
}
