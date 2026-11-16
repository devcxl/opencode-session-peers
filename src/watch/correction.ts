/**
 * Pure correction eligibility gates.
 *
 * It reports observed and required facts, never a boolean bypass. The real
 * runtime tuples are accepted only after the isolated production protocol
 * passes. Stock versions remain closed even when every other fact is present.
 */

import {
  WATCH_CORRECTION_DEFAULT_POLICY,
  WATCH_CORRECTION_LIMIT,
  WATCH_MIN_SQLITE,
  isCorrectionAttemptOpen,
  watchCorrectionAttemptAnchor,
  type WatchCorrectionGateView,
  type WatchCorrectionPolicy,
  type WatchCorrectionSnapshot,
  type WatchCorrectionStopReason,
  type WatchObservationView,
  type WatchTaskRecord,
} from "../domain/watch.ts"

/** Exact repaired-host protocol evidence: docs/research/watchdog-61-protocol-plan.md. */
const VERIFIED_APP_TUPLES: readonly string[] = ["2.3.0-watchdog-location.1/linux/x64"]

/** Local filesystem allowlist; unknown or network filesystems stay closed. */
const LOCAL_FILESYSTEMS = new Set(["ext4", "xfs", "btrfs", "tmpfs", "zfs", "overlay"])

export interface CorrectionRuntimeFacts {
  readonly platform: string | null
  readonly arch: string | null
  readonly appVersion: string | null
  readonly sqliteVersion: string | null
  readonly journalMode: string | null
  /** `2` is SQLite's FULL synchronous level. */
  readonly synchronous: number | null
  readonly busyTimeoutMs: number | null
  readonly filesystem: string | null
}

export interface CorrectionGateInput {
  readonly task: WatchTaskRecord
  readonly snapshot: WatchCorrectionSnapshot
  readonly observation: WatchObservationView | null
  readonly runtime: CorrectionRuntimeFacts
  readonly ownerActivation: string
  readonly sameLocation: boolean
  readonly singleHostDeclared: boolean
  readonly closing: boolean
  readonly executorReady: boolean
  readonly now: number
  /** Configured policy; defaults to the documented five- and twenty-minute values. */
  readonly policy?: WatchCorrectionPolicy
  /** The executor's own committed reservation is not a blocking pending attempt. */
  readonly ignoreAttemptID?: string
}

/** Derived, durable facts behind the bounded automatic-attempt policy. */
export interface CorrectionPolicyFacts {
  readonly used: number
  readonly limit: number
  readonly observationMs: number
  readonly windowMs: number
  readonly lastAttemptAt: number | null
  readonly observationEndsAt: number | null
  /** First attempt of the active continuous problem, or null before it starts. */
  readonly windowStartedAt: number | null
  readonly windowEndsAt: number | null
}

export interface CorrectionGateResult {
  readonly eligible: boolean
  readonly stopReason: WatchCorrectionStopReason | null
  readonly missingEvidence: string | null
  readonly gates: readonly WatchCorrectionGateView[]
  readonly policy: CorrectionPolicyFacts
}

export function correctionGate(input: CorrectionGateInput): CorrectionGateResult {
  return evaluate(input, VERIFIED_APP_TUPLES)
}

/**
 * A source-level factory for an isolated candidate harness. Production uses
 * the static whitelist above; no model/config/env path can call this.
 */
export function correctionGateWithVerifiedTuples(
  verified: readonly string[],
): (input: CorrectionGateInput) => CorrectionGateResult {
  return (input) => evaluate(input, verified)
}

function evaluate(input: CorrectionGateInput, verified: readonly string[]): CorrectionGateResult {
  const { task, snapshot, observation, runtime } = input
  const policy = input.policy ?? WATCH_CORRECTION_DEFAULT_POLICY
  const history = snapshot.attempts.filter((attempt) => attempt.reservationID !== input.ignoreAttemptID)
  const open = history.find(isCorrectionAttemptOpen)
  const used = history.length
  const lastAttemptAt = history.reduce<number | null>(
    (latest, attempt) => {
      const anchor = watchCorrectionAttemptAnchor(attempt)
      return latest === null || anchor > latest ? anchor : latest
    },
    null,
  )
  const episode = snapshot.episode
  const observationMs =
    episode?.observationMs ?? snapshot.lastAttemptPolicy?.observationMs ?? policy.observationMs
  const windowMs = episode?.windowMs ?? policy.windowMs
  const observationEndsAt = lastAttemptAt === null ? null : lastAttemptAt + observationMs
  const windowStartedAt = episode?.startedAt ?? null
  const windowEndsAt = episode?.deadlineAt ?? null
  const policyFacts: CorrectionPolicyFacts = {
    used,
    limit: WATCH_CORRECTION_LIMIT,
    observationMs,
    windowMs,
    lastAttemptAt,
    observationEndsAt,
    windowStartedAt,
    windowEndsAt,
  }
  const runtimeTuple = `${runtime.appVersion ?? "?"}/${runtime.platform ?? "?"}/${runtime.arch ?? "?"}`
  const runtimeOk =
    runtime.platform === "linux" &&
    runtime.arch === "x64" &&
    verified.includes(runtimeTuple) &&
    runtime.sqliteVersion !== null &&
    versionAtLeast(runtime.sqliteVersion, WATCH_MIN_SQLITE) &&
    runtime.journalMode === "wal" &&
    runtime.synchronous === 2 &&
    (runtime.busyTimeoutMs ?? 0) > 0 &&
    runtime.filesystem !== null &&
    LOCAL_FILESYSTEMS.has(runtime.filesystem)
  const grantOk =
    snapshot.grant?.state === "granted" &&
    task.mode === "limited-correction" &&
    snapshot.grant.generation === task.generation &&
    snapshot.grant.scopeTargetSessionID === task.targetSessionID
  const taskActive = task.watchState === "active"
  const sessionClear = !snapshot.sessionUnresolved
  const businessOk = task.taskState !== "completed" && task.taskState !== "blocked"
  const singleHost = input.singleHostDeclared && snapshot.grant?.deployment === "single-host-same-location"
  const currentWaits = observation?.waits.filter(
    (wait) => wait.status === "active" || wait.status === "overdue" || wait.status === "unknown",
  ) ?? []
  const denied = observation?.waits.some((wait) => wait.status === "denied") ?? false
  const observationOk =
    observation !== null &&
    observation.trusted &&
    observation.state === "idle-candidate" &&
    observation.waitsPartial === false &&
    observation.waitsTruncated === false &&
    observation.waits.every(
      (wait) => wait.status !== "active" && wait.status !== "overdue" && wait.status !== "unknown",
    )
  const protocolSeen = task.lastReport !== undefined
  const ownerOk = task.ownerActivation === input.ownerActivation
  const gates: WatchCorrectionGateView[] = [
    gate("grant", grantOk, snapshot.grant === null ? "not-granted" : `${snapshot.grant.state} version ${snapshot.grant.version}`, "an active limited-correction grant"),
    gate("attempts", used < WATCH_CORRECTION_LIMIT, `${used}/${WATCH_CORRECTION_LIMIT} permanent attempts`, `fewer than ${WATCH_CORRECTION_LIMIT} permanent attempts`),
    gate("pending-attempt", open === undefined, open === undefined ? "none" : `attempt ${open.ordinal} ${open.phase}`, "no unresolved attempt"),
    gate("business-unfinished", businessOk, task.taskState, "not completed or explicitly blocked"),
    gate("task-active", taskActive, task.watchState, "an active watch"),
    gate("session-unresolved", sessionClear, sessionClear ? "none" : "an older task is unresolved", "no unresolved older attempt for this session"),
    gate(
      "runtime",
      runtimeOk,
      `${runtimeTuple}; sqlite=${runtime.sqliteVersion ?? "unknown"}; journal=${runtime.journalMode ?? "unknown"}; synchronous=${runtime.synchronous ?? "unknown"}; busy=${runtime.busyTimeoutMs ?? "unknown"}; fs=${runtime.filesystem ?? "unknown"}`,
      "Linux x64, a verified app tuple, embedded SQLite >= 3.51.3, WAL, FULL, bounded busy_timeout and local filesystem",
    ),
    gate(
      "single-host",
      singleHost,
      snapshot.grant?.deployment ?? "unknown",
      "an explicit single-host, same-location deployment statement",
    ),
    gate("location", input.sameLocation, input.sameLocation ? "same location" : "unknown", "same host and location"),
    gate("owner-generation", ownerOk, ownerOk ? "this activation" : "another activation", "the recorded owner activation and generation"),
    gate("protocol", protocolSeen, protocolSeen ? "reported" : "no report", "the target has participated in the protocol"),
    gate(
      "observation",
      observationOk,
      observation === null ? "no sample" : `${observation.state}; trusted=${String(observation.trusted)}; partial=${String(observation.waitsPartial)}`,
      "a trusted idle-candidate with complete wait evidence",
    ),
    gate(
      "waits",
      observation !== null && currentWaits.length === 0 && !denied && observation.waitsPartial === false,
      observation === null
        ? "no snapshot"
        : `${currentWaits.length} current wait(s); denied=${String(denied)}; partial=${String(observation.waitsPartial)}`,
      "no active, overdue, unknown or denied wait and a complete snapshot",
    ),
    gate("closing", !input.closing, input.closing ? "closing" : "open", "not closing"),
    gate("executor", input.executorReady, input.executorReady ? "ready" : "closed", "a controlled automatic-attempt executor"),
  ]
  for (const item of gates) {
    if (item.ok || item.gate === "executor") continue
    return result(gates, stopForGate(item.gate, task, open, used, observation), policyFacts)
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return result(
      gates,
      {
        reason: "post-attempt-observation",
        missingEvidence: "a valid non-decreasing clock is required before another automatic attempt",
      },
      policyFacts,
    )
  }
  if (windowStartedAt !== null && input.now < windowStartedAt) {
    return result(
      gates,
      {
        reason: "correction-window",
        missingEvidence: "the clock precedes the fixed start of this continuous problem",
      },
      policyFacts,
    )
  }
  if (windowEndsAt !== null && input.now >= windowEndsAt) {
    return result(
      gates,
      {
        reason: "correction-window",
        missingEvidence: `the continuous problem window of ${windowMs} ms is spent`,
      },
      policyFacts,
    )
  }
  if (observationEndsAt !== null && input.now < observationEndsAt) {
    return result(
      gates,
      {
        reason: "post-attempt-observation",
        missingEvidence: `the last attempt must be observed for ${observationMs} ms before another`,
      },
      policyFacts,
    )
  }
  if (!input.executorReady) {
    return result(
      gates,
      { reason: "executor-unavailable", missingEvidence: "the controlled executor path is not open in this build" },
      policyFacts,
    )
  }
  return { eligible: true, stopReason: null, missingEvidence: null, gates, policy: policyFacts }
}

function gate(
  name: WatchCorrectionGateView["gate"],
  ok: boolean,
  observed: string,
  required: string,
): WatchCorrectionGateView {
  return { gate: name, ok, reason: ok ? null : `requires ${required}`, observed, required }
}

function result(
  gates: readonly WatchCorrectionGateView[],
  stop: { readonly reason: WatchCorrectionStopReason; readonly missingEvidence: string | null },
  policy: CorrectionPolicyFacts,
): CorrectionGateResult {
  return { eligible: false, stopReason: stop.reason, missingEvidence: stop.missingEvidence, gates, policy }
}

function stopForGate(
  name: WatchCorrectionGateView["gate"],
  task: WatchTaskRecord,
  open: WatchCorrectionSnapshot["attempts"][number] | undefined,
  used: number,
  observation: WatchObservationView | null,
): { readonly reason: WatchCorrectionStopReason; readonly missingEvidence: string | null } {
  switch (name) {
    case "runtime":
      return { reason: "runtime-unsupported", missingEvidence: "the actual embedded runtime tuple is not verified" }
    case "single-host":
      return { reason: "single-host-unconfirmed", missingEvidence: "no explicit single-host deployment statement" }
    case "location":
      return { reason: "cross-location", missingEvidence: "same-host, same-location observation is not established" }
    case "owner-generation":
      return { reason: "owner-mismatch", missingEvidence: "this activation is not the recorded owner" }
    case "protocol":
      return { reason: "protocol-unseen", missingEvidence: "the target has not reported protocol participation" }
    case "grant":
      return { reason: "grant-missing", missingEvidence: "no active limited-correction grant" }
    case "attempts":
      return { reason: "attempt-limit", missingEvidence: "the three permanent attempts are spent" }
    case "pending-attempt":
      if (open === undefined) return { reason: "session-unresolved", missingEvidence: "an older task is unresolved" }
      if (open.phase === "reserved") return { reason: "reservation-pending", missingEvidence: "the reservation has not claimed its send slot" }
      if (open.phase === "sending") return { reason: "sending-unaccounted", missingEvidence: "the claimed send has no outcome" }
      if (open.phase === "accepted") return { reason: "accepted-without-receipt", missingEvidence: "the target has not submitted a receipt" }
      if (open.phase === "receipted") {
        return {
          reason: "receipted-awaiting-recovery",
          missingEvidence: "the permit is issued, but new progress and a new result reference have not confirmed recovery",
        }
      }
      return { reason: "unknown-result", missingEvidence: "the delivery outcome is unknown" }
    case "business-unfinished":
      if (task.taskState === "completed") return { reason: "task-completed", missingEvidence: "the business task is completed" }
      return { reason: "observation-untrusted", missingEvidence: "the business task is explicitly blocked" }
    case "task-active":
      return task.watchState === "paused"
        ? { reason: "task-paused", missingEvidence: "the watch is paused" }
        : { reason: "task-ended", missingEvidence: "the watch has ended" }
    case "session-unresolved":
      return { reason: "session-unresolved", missingEvidence: "an older task still has an unresolved attempt" }
    case "observation":
      return observation?.state === "normal-waiting"
        ? { reason: "normal-wait", missingEvidence: "a normal wait is present" }
        : { reason: "observation-untrusted", missingEvidence: "trusted continuous idle is not established" }
    case "waits":
      return { reason: "normal-wait", missingEvidence: "a wait is present or the wait snapshot is incomplete" }
    case "closing":
      return { reason: "closing", missingEvidence: "the activation is closing" }
    case "executor":
      return { reason: "executor-unavailable", missingEvidence: "the controlled executor is closed" }
  }
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = actual.split(".").map((part) => Number.parseInt(part, 10))
  const right = minimum.split(".").map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}
