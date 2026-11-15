/**
 * The observation loop: what a local plugin instance can honestly see.
 *
 * It uses only the host's execution lifecycle events, the target's own
 * text/step/tool/shell activity, same-location permission snapshots, storage
 * asks, and the small set of form/retry events. It never uses the roster
 * status cache, `session.status`, `session.idle`, `time.updated`, heartbeat,
 * title or inbox admission as activity. Missing or contradictory evidence is
 * `unknown`; it is not a licence to infer that the session is idle.
 *
 * The observer persists only alerts. Its in-memory baseline is deliberately
 * lost on reload and reset after a gap/clock anomaly; an old silent period is
 * never counted as uninterrupted observation.
 */

import type { WatchConfig } from "../config.ts"
import { describeError } from "../domain/errors.ts"
import type { AskRecord, ReplyRecord, SessionID } from "../domain/types.ts"
import {
  type WatchActivityView,
  type WatchAlertKind,
  type WatchObservationView,
  type WatchTaskRecord,
  type WatchWaitView,
} from "../domain/watch.ts"
import type { EventSource, HostEvent } from "../host/events.ts"
import type { PermissionLookup } from "../host/permission.ts"
import type { Scheduler } from "../host/scheduler.ts"
import type { SessionLookup } from "../host/session.ts"
import type { RecordStore } from "../host/storage.ts"
import { sessionAtLocation } from "./access.ts"
import type { UpsertWatchAlertInput } from "./ledger.ts"
import type { WatchApplication, WatchObservationSource } from "./service.ts"

const MAX_WAITS = 12
const MAX_CLEARED_WAITS = 6
const MAX_FACT_SESSIONS = 100

type ActivityKind = NonNullable<WatchActivityView["kind"]>

interface SessionFacts {
  execution: "unknown" | "running" | "settled"
  executionAt: number | null
  startedAt: number | null
  settledAt: number | null
  terminalFailure: "failed" | "interrupted" | null
  lastActivityAt: number | null
  lastActivityKind: ActivityKind | null
  invalidatedAt: number | null
  observedFrom: number
  retry: { readonly at: number; readonly attempt: number; readonly id: string } | null
  forms: Map<string, { readonly at: number; readonly title: string }>
  permissionFirstSeen: Map<string, number>
  formFirstSeen: Map<string, number>
  clearedWaits: WatchWaitView[]
  clearedOverflow: boolean
  lifecycleCovered: boolean
  lastObservedAt: number | null
  idleSeenAt: number | null
  idleTicks: number
  unknownSince: number | null
}

interface TaskObservation {
  observation: WatchObservationView
  activity: WatchActivityView
}

export interface WatchObserver extends WatchObservationSource {
  start(): void
  dispose(): void
}

export interface WatchObserverDeps {
  readonly config: WatchConfig
  readonly directory: string
  readonly sessions: SessionLookup
  readonly permissions: PermissionLookup
  readonly events: EventSource
  readonly scheduler: Scheduler
  /** The authoritative task record source; alerts are persisted through the same application. */
  readonly store: WatchApplication
  readonly asks: RecordStore<AskRecord>
  readonly replies: RecordStore<ReplyRecord>
  readonly onChanged?: () => void
  readonly warn: (message: string) => void
}

export function createWatchObserver(deps: WatchObserverDeps): WatchObserver {
  const facts = new Map<SessionID, SessionFacts>()
  const observations = new Map<string, TaskObservation>()
  const observedWaitKeys = new Map<string, Set<string>>()
  const taskVersions = new Map<string, number>()
  const sessionRevisions = new Map<string, number>()
  const everSeenSessions = new Set<string>()
  const startedAt = deps.scheduler.now()
  let factBaseline = startedAt
  let lastTickAt: number | null = null
  let gap: string | null = null
  let disposed = false
  let epoch = 0
  let ticking = false
  let queued = false
  let runningTick: Promise<void> | undefined
  const controller = new AbortController()
  let registration: { dispose(): void } | undefined

  const fact = (sessionID: SessionID): SessionFacts => {
    const existing = facts.get(sessionID)
    if (existing !== undefined) return existing
    if (facts.size >= MAX_FACT_SESSIONS) {
      const oldest = facts.keys().next().value
      if (oldest !== undefined) facts.delete(oldest)
    }
    const created: SessionFacts = {
      execution: "unknown",
      executionAt: null,
      startedAt: null,
      settledAt: null,
      terminalFailure: null,
      lastActivityAt: null,
      lastActivityKind: null,
      invalidatedAt: null,
      observedFrom: factBaseline,
      retry: null,
      forms: new Map(),
      permissionFirstSeen: new Map(),
      formFirstSeen: new Map(),
      clearedWaits: [],
      clearedOverflow: false,
      lifecycleCovered: false,
      lastObservedAt: null,
      idleSeenAt: null,
      idleTicks: 0,
      unknownSince: null,
    }
    facts.set(sessionID, created)
    return created
  }

  const resetFacts = (at: number) => {
    for (const [sessionID, value] of facts) {
      value.execution = "unknown"
      value.executionAt = null
      value.startedAt = null
      value.settledAt = null
      value.terminalFailure = null
      value.lastActivityAt = null
      value.lastActivityKind = null
      value.invalidatedAt = null
      value.observedFrom = at
      value.retry = null
      value.forms.clear()
      value.permissionFirstSeen.clear()
      value.formFirstSeen.clear()
      value.clearedWaits = []
      value.clearedOverflow = false
      value.lastObservedAt = null
      value.idleSeenAt = null
      value.idleTicks = 0
      value.unknownSince = null
      facts.set(sessionID, value)
    }
  }

  const onEvent = (event: HostEvent) => {
    const eventLocation = (event as { readonly location?: { readonly directory?: unknown } }).location?.directory
    // Events are live-only and process-wide; without a same-location source
    // stamp we cannot attribute them to this instance's target.
    if (typeof eventLocation !== "string" || eventLocation !== deps.directory) return
    const sessionID = sessionOf(event)
    if (sessionID === undefined) return
    const now = deps.scheduler.now()
    const at = eventAt(event)
    if (at === undefined || at > now) {
      gap = at === undefined ? "event has no trusted timestamp" : "event timestamp is in the future"
      epoch += 1
      factBaseline = now
      resetFacts(now)
      return
    }
    if (event.type === "session.created") {
      if (
        !everSeenSessions.has(sessionID) &&
        at >= factBaseline &&
        typeof eventLocation === "string" &&
        eventLocation === deps.directory
      ) {
        const current = fact(sessionID)
        current.lifecycleCovered = true
      }
      everSeenSessions.add(sessionID)
      sessionRevisions.set(sessionID, (sessionRevisions.get(sessionID) ?? 0) + 1)
      return
    }
    const current = fact(sessionID)
    everSeenSessions.add(sessionID)
    if (at < current.observedFrom) return
    if (revisionEvent(event.type)) {
      sessionRevisions.set(sessionID, (sessionRevisions.get(sessionID) ?? 0) + 1)
    }
    switch (event.type) {
      case "permission.asked":
      case "session.status":
      case "session.idle":
        break
      case "session.execution.started":
        if (current.executionAt !== null && at < current.executionAt) return
        current.execution = "running"
        current.executionAt = at
        current.startedAt = at
        current.settledAt = null
        current.terminalFailure = null
        current.idleSeenAt = null
        current.idleTicks = 0
        current.unknownSince = null
        current.retry = null
        current.lastActivityAt = at
        current.lastActivityKind = "execution"
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (current.executionAt !== null && at < current.executionAt) return
        current.execution = "settled"
        current.executionAt = at
        current.settledAt = at
        current.startedAt = null
        current.terminalFailure =
          event.type === "session.execution.failed"
            ? "failed"
            : event.type === "session.execution.interrupted"
              ? "interrupted"
              : null
        current.idleSeenAt = null
        current.idleTicks = 0
        current.unknownSince = null
        current.retry = null
        current.lastActivityAt = at
        current.lastActivityKind = "execution"
        break
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
        markActivity(current, at, "text")
        break
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
        markActivity(current, at, "reasoning")
        break
      case "session.step.started":
      case "session.step.streamed":
      case "session.step.ended":
      case "session.step.failed":
        markActivity(current, at, "step")
        break
      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.input.ended":
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed":
        markActivity(current, at, "tool")
        break
      case "session.shell.started":
      case "session.shell.ended":
        markActivity(current, at, "shell")
        break
      case "session.inbox.enqueued":
        // New input invalidates a candidate, but is not activity evidence.
        current.invalidatedAt = at
        current.idleSeenAt = null
        current.idleTicks = 0
        break
      case "session.retry.scheduled": {
        const data = eventData(event)
        const attempt = typeof data["attempt"] === "number" ? data["attempt"] : 1
        current.retry = { at, attempt, id: `retry:${String(data["assistantMessageID"] ?? at)}` }
        current.idleSeenAt = null
        current.idleTicks = 0
        break
      }
      case "form.created": {
        const data = eventData(event)
        const form = asRecord(data["form"])
        const id = form === undefined ? undefined : form["id"]
        const title = form === undefined ? undefined : form["title"]
        if (typeof id === "string") {
          current.forms.set(id, { at, title: typeof title === "string" ? title : "form" })
        }
        break
      }
      case "form.replied":
      case "form.cancelled": {
        const data = eventData(event)
        const id = data["id"]
        if (typeof id === "string") {
          const form = current.forms.get(id)
          current.forms.delete(id)
          if (form !== undefined) {
            addCleared(current, {
              waitID: `form:${id}`,
              source: "form",
              object: "form",
              reason: "form needs input",
              reference: id,
              startedAt: form.at,
              deadline: null,
              status: event.type === "form.cancelled" ? "cleared" : "cleared",
              clearEvidence: event.type === "form.cancelled" ? "form cancelled" : "form replied",
              denyEvidence: null,
            })
          }
        }
        break
      }
      case "permission.replied": {
        const data = eventData(event)
        const id = data["requestID"]
        const reply = data["reply"]
        if (typeof id === "string") {
          const started = current.permissionFirstSeen.get(id) ?? at
          current.permissionFirstSeen.delete(id)
          const denied = reply === "reject"
          addCleared(current, {
            waitID: `permission:${id}`,
            source: "permission",
            object: "permission",
            reason: "permission request was awaiting a reply",
            reference: id,
            startedAt: started,
            deadline: null,
            status: denied ? "denied" : "cleared",
            clearEvidence: denied ? null : "permission replied",
            denyEvidence: denied ? "permission reply: reject" : null,
          })
          if (denied) {
            // The task itself remains active; the observer only records the
            // refusal as a blocked condition and never treats it as approval.
            current.unknownSince = null
          }
        }
        break
      }
      case "session.deleted":
        facts.delete(sessionID)
        everSeenSessions.delete(sessionID)
        break
      default:
        break
    }
  }

  const tick = async () => {
    if (disposed) return
    const now = deps.scheduler.now()
    if (lastTickAt !== null) {
      const delta = now - lastTickAt
      if (delta < 0 || delta > Math.max(deps.config.tickMs * 4, 60_000)) {
        gap = "clock or scheduling gap"
        epoch += 1
        factBaseline = now
        resetFacts(now)
      }
    }
    lastTickAt = now
    const tasks = deps.store.liveTasks()
    const seen = new Set<string>()
    for (const task of tasks) {
      seen.add(task.taskID)
      await sample(task, now)
    }
    for (const taskID of [...observations.keys()]) {
      if (!seen.has(taskID)) {
        observations.delete(taskID)
        observedWaitKeys.delete(taskID)
        taskVersions.delete(taskID)
      }
    }
    if (gap !== null) {
      // The gap is cleared by a new sample; its effect is already in the
      // reset baselines and the unknown alerts below.
      gap = null
    }
  }

  const thresholdsOf = (): WatchObservationView["effective"] => ({
    idleMs: deps.config.idleMs,
    runningSilentMs: deps.config.runningSilentMs,
    waitOverdueMs: deps.config.waitOverdueMs,
  })

  const sample = async (taskInput: WatchTaskRecord, now: number) => {
    let task = taskInput
    const sampleEpoch = epoch
    const sampleRevision = sessionRevisions.get(task.targetSessionID) ?? 0
    const current = fact(task.targetSessionID)
    if (taskVersions.get(task.taskID) !== task.version) {
      current.idleSeenAt = null
      current.idleTicks = 0
      taskVersions.set(task.taskID, task.version)
    }
    current.lastObservedAt = now
    const local = await sessionAtLocation(deps.sessions, task.targetSessionID, deps.directory)
    if (!local) {
      // Never sample, resolve or retain another location's task snapshot.
      observations.delete(task.taskID)
      observedWaitKeys.delete(task.taskID)
      return
    }
    const waits = await collectWaits(task, current, now)

    let session
    try {
      session = await deps.sessions.get(task.targetSessionID)
    } catch (error) {
      const observation = unknownObservation(now, `the session is not readable: ${describeError(error)}`, waits.items, waits.partial, thresholdsOf())
      observations.set(task.taskID, { observation, activity: activityOf(current) })
      resolveConditionAlerts(task.taskID, ["idle", "running-silent"], now)
      return
    }

    const permission = await readPermissions(task.targetSessionID)
    if (!permission.ok) {
      waits.partial = true
    } else {
      mergePermissionWaits(current, waits, permission.requests, now)
    }
    const asks = await readAsks(task.targetSessionID)
    if (!asks.ok) {
      waits.partial = true
    } else {
      await mergeAskWaits(waits, asks.records, current, now)
    }
    mergeFormWaits(current, waits, now)
    mergeRetryWait(current, waits, now)
    if (disposed || sampleEpoch !== epoch) return
    if ((sessionRevisions.get(task.targetSessionID) ?? 0) !== sampleRevision) return
    const fresh = deps.store.liveTasks().find((candidate) => candidate.taskID === task.taskID)
    if (fresh === undefined || fresh.watchState !== "active" || fresh.version !== task.version) return
    task = fresh

    const previousWaitKeys = observedWaitKeys.get(task.taskID) ?? new Set<string>()
    const currentWaitKeys = new Set(waits.items.map((wait) => wait.waitID))
    for (const key of previousWaitKeys) {
      if (!currentWaitKeys.has(key)) resolveConditionAlerts(task.taskID, [`wait:${key}`], now)
    }
    observedWaitKeys.set(task.taskID, currentWaitKeys)
    waits.items.sort((left, right) => waitPriority(left) - waitPriority(right))
    const waitsTruncated = waits.items.length > MAX_WAITS
    if (waitsTruncated) waits.partial = true
    const visibleWaits = waits.items.slice(0, MAX_WAITS)
    const observed = observe(
      task,
      current,
      session.idleAt,
      session.busyAt,
      waits.partial,
      visibleWaits,
      waitsTruncated,
      now,
    )
    observations.set(task.taskID, observed)
    if (task.watchState !== "active") {
      // Pausing stops new alerts but leaves the old ones queryable/ackable.
      return
    }

    const hasWait = visibleWaits.some((wait) => wait.status === "active" || wait.status === "overdue")
    const blocked = visibleWaits.some((wait) => wait.status === "denied")
    if (blocked) {
      upsert(task.taskID, "approval-rejected", "approval", "An approval was rejected; the task is blocked.", "Review the rejected approval in the executing session; this build cannot approve or resume it.", now)
    } else {
      resolveConditionAlerts(task.taskID, ["approval-rejected"], now)
    }

    if (observed.observation.state === "idle-candidate" && !hasWait) {
      const duration = now - (observed.observation.baselineAt ?? now)
      if (duration >= deps.config.idleMs) {
        upsert(
          task.taskID,
          "idle",
          "idle",
          "No trusted target activity for the idle window; the task is unfinished.",
          "Inspect the task and its evidence; this alert is not a correction and does not start work.",
          now,
        )
      }
    } else {
      resolveConditionAlerts(task.taskID, ["idle"], now)
    }

    if (observed.observation.state === "running-silence") {
      upsert(
        task.taskID,
        "running-silent",
        "running-silent",
        "The target is running but has produced no new activity for the configured window.",
        "Wait for the provider or inspect the long-running tool; this is a warning, not a failure timeout.",
        now,
      )
    } else {
      resolveConditionAlerts(task.taskID, ["running-silent"], now)
    }

    if (observed.observation.state === "blocked") {
      upsert(
        task.taskID,
        "observation-unknown",
        "execution-blocked",
        "The task is blocked by a failed execution or a rejected wait; it is not a quiet idle task.",
        "Inspect the executing session and the blocked evidence; this build does not resume or correct it.",
        now,
      )
    } else {
      resolveConditionAlerts(task.taskID, ["execution-blocked"], now)
    }

    if (observed.observation.state === "unknown" || observed.observation.state === "unavailable") {
      const since = current.unknownSince ?? now
      current.unknownSince = since
      if (now - since >= deps.config.idleMs) {
        upsert(
          task.taskID,
          "observation-unknown",
          "observation-unknown",
          "Observation is incomplete; the watchdog cannot tell whether the task is idle or waiting.",
          "Check the panel's capability reason and the executing session; no automatic action was taken.",
          now,
        )
      }
    } else {
      current.unknownSince = null
      resolveConditionAlerts(task.taskID, ["observation-unknown"], now)
    }

    for (const wait of visibleWaits) {
      const overdueAt = wait.deadline ?? wait.startedAt + deps.config.waitOverdueMs
      if ((wait.status === "active" && now >= overdueAt) || wait.status === "overdue") {
        upsert(
          task.taskID,
          wait.source === "permission" ? "wait-overdue" : "wait-overdue",
          `wait:${wait.waitID}`,
          "A normal wait is overdue; the initiator is notified, not the executing session.",
          `A ${wait.source} wait has passed its expected window. Do not answer it on the target's behalf.`,
          now,
        )
      }
    }
    for (const wait of visibleWaits) {
      if (wait.status !== "active" && wait.status !== "overdue") {
        resolveConditionAlerts(task.taskID, [`wait:${wait.waitID}`], now)
      }
    }
  }

  const observe = (
    task: WatchTaskRecord,
    current: SessionFacts,
    idleAt: number | undefined,
    busyAt: number | undefined,
    waitsPartial: boolean,
    waits: readonly WatchWaitView[],
    waitsTruncated: boolean,
    now: number,
  ): TaskObservation => {
    const thresholds = {
      idleMs: deps.config.idleMs,
      runningSilentMs: deps.config.runningSilentMs,
      waitOverdueMs: deps.config.waitOverdueMs,
    }
    const activity = activityOf(current)
    if (task.watchState !== "active") {
      return {
        observation: {
          state: "unavailable",
          reason: task.watchState === "paused" ? "supervision is paused" : "supervision has ended",
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    const lifecycleCovered = current.lifecycleCovered
    const historyPartial = !lifecycleCovered
    const effectivePartial = waitsPartial || historyPartial
    const historyReason = "session predates continuous observation; event-only wait sources incomplete"
    if (waits.some((wait) => wait.status === "denied")) {
      return {
        observation: {
          state: "blocked",
          reason: "an approval was rejected; the task is blocked",
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (waits.some((wait) => wait.status === "unknown")) {
      return {
        observation: unknownObservation(
          now,
          "a wait expired or could not be matched; it is not proof that the wait ended",
          waits,
          waitsPartial,
          thresholds,
          waitsTruncated,
        ),
        activity,
      }
    }
    if (task.taskState === "blocked") {
      return {
        observation: {
          state: "blocked",
          reason: "the executing session reported blocked work",
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial: effectivePartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (task.taskState === "waiting") {
      return {
        observation: {
          state: "normal-waiting",
          reason: "the executing session reported a normal wait",
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial: effectivePartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (waits.some((wait) => wait.status === "active" || wait.status === "overdue")) {
      return {
        observation: {
          state: "normal-waiting",
          reason: waitsPartial ? "wait sources are incomplete; absence of other waits is not proof" : null,
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (waitsPartial) {
      return {
        observation: unknownObservation(
          now,
          "a wait source is unavailable or incomplete",
          waits,
          true,
          thresholds,
          waitsTruncated,
        ),
        activity,
      }
    }
    if (current.execution === "running") {
      const runningBaseline = Math.max(task.createdAt, current.startedAt ?? task.createdAt)
      const runningContradiction =
        busyAt === undefined ||
        !Number.isFinite(busyAt) ||
        busyAt > now ||
        (idleAt !== undefined && (!Number.isFinite(idleAt) || idleAt > now || busyAt <= idleAt)) ||
        (current.startedAt !== null && busyAt + 1_000 < current.startedAt)
      if (runningContradiction) {
        return {
          observation: unknownObservation(
            now,
            "the running execution event contradicts the host busy/idle snapshot",
            waits,
            true,
            thresholds,
            waitsTruncated,
          ),
          activity,
        }
      }
      const last = current.lastActivityAt ?? runningBaseline
      const state = now - Math.max(runningBaseline, last) >= deps.config.runningSilentMs ? "running-silence" : "active"
      return {
        observation: {
          state,
          reason:
            state === "running-silence"
              ? historyPartial
                ? `${historyReason}; running is observed but no idle/complete wait history is available`
                : "no target activity for the running window"
              : historyPartial
                ? historyReason
                : null,
          observedAt: now,
          baselineAt: runningBaseline,
          idleSince: null,
          trusted: !historyPartial,
          waits,
          waitsPartial: historyPartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (!lifecycleCovered) {
      return {
        observation: unknownObservation(now, historyReason, waits, true, thresholds, waitsTruncated),
        activity,
      }
    }
    if (current.execution !== "settled") {
      return {
        observation: unknownObservation(now, "no local terminal execution has been observed", waits, waitsPartial, thresholds, waitsTruncated),
        activity,
      }
    }
    if (current.terminalFailure !== null) {
      return {
        observation: {
          state: "blocked",
          reason: `the last execution ${current.terminalFailure}; it is not a quiet idle task`,
          observedAt: now,
          baselineAt: null,
          idleSince: null,
          trusted: false,
          waits,
          waitsPartial,
          waitsTruncated,
          effective: thresholds,
        },
        activity,
      }
    }
    if (idleAt === undefined || busyAt === undefined) {
      return {
        observation: unknownObservation(
          now,
          "the host did not report both busy and idle times",
          waits,
          waitsPartial,
          thresholds,
          waitsTruncated,
        ),
        activity,
      }
    }
    if (!Number.isFinite(idleAt) || !Number.isFinite(busyAt) || idleAt > now || busyAt > now) {
      return {
        observation: unknownObservation(
          now,
          "the host execution times are future/invalid",
          waits,
          waitsPartial,
          thresholds,
          waitsTruncated,
        ),
        activity,
      }
    }
    if (busyAt > idleAt) {
      return {
        observation: unknownObservation(
          now,
          "the host busy time is newer than idle; the last execution is not settled",
          waits,
          waitsPartial,
          thresholds,
          waitsTruncated,
        ),
        activity,
      }
    }
    if (current.settledAt !== null && idleAt < current.settledAt) {
      return {
        observation: unknownObservation(now, "the host idle time contradicts the observed terminal event", waits, waitsPartial, thresholds, waitsTruncated),
        activity,
      }
    }
    const baseline = Math.max(
      task.createdAt,
      task.updatedAt,
      current.settledAt ?? task.createdAt,
      current.lastActivityAt ?? 0,
      current.invalidatedAt ?? 0,
      current.observedFrom,
    )
    if (current.idleSeenAt === null) {
      current.idleSeenAt = baseline
      current.idleTicks = 0
    }
    current.idleTicks += 1
    const idleState = now - baseline >= deps.config.idleMs && current.idleTicks >= 2
    return {
      observation: {
        state: idleState ? "idle-candidate" : "active",
        reason: null,
        observedAt: now,
        baselineAt: baseline,
        idleSince: Math.max(current.settledAt ?? task.createdAt, task.createdAt),
        trusted: true,
        waits,
        waitsPartial,
        waitsTruncated,
        effective: thresholds,
      },
      activity,
    }
  }

  const mergePermissionWaits = (
    current: SessionFacts,
    waits: { items: WatchWaitView[]; partial: boolean },
    requests: readonly { readonly id: string; readonly action: string }[],
    now: number,
  ) => {
    const seen = new Set<string>()
    for (const request of requests) {
      seen.add(request.id)
      const started = current.permissionFirstSeen.get(request.id) ?? now
      current.permissionFirstSeen.set(request.id, started)
      const deadline = null
      waits.items.push({
        waitID: `permission:${request.id}`,
        source: "permission",
        object: `permission:${request.action}`.slice(0, 120),
        reason: "permission request is awaiting a reply",
        reference: request.id,
        startedAt: started,
        deadline,
        status: now - started >= deps.config.waitOverdueMs ? "overdue" : "active",
        clearEvidence: null,
        denyEvidence: null,
      })
    }
    for (const id of [...current.permissionFirstSeen.keys()]) {
      if (!seen.has(id)) {
        const started = current.permissionFirstSeen.get(id) ?? now
        current.permissionFirstSeen.delete(id)
        const missingWait: WatchWaitView = {
          waitID: `permission:${id}`,
          source: "permission",
          object: "permission",
          reason: "permission request was awaiting a reply",
          reference: id,
          startedAt: started,
          deadline: null,
          status: "unknown",
          clearEvidence: null,
          denyEvidence: null,
        }
        addCleared(current, missingWait)
        if (!waits.items.some((candidate) => candidate.waitID === missingWait.waitID)) waits.items.push(missingWait)
      }
    }
  }

  const mergeFormWaits = (current: SessionFacts, waits: { items: WatchWaitView[]; partial: boolean }, now: number) => {
    for (const [id, form] of current.forms) {
      const started = current.formFirstSeen.get(id) ?? form.at
      current.formFirstSeen.set(id, started)
      waits.items.push({
        waitID: `form:${id}`,
        source: "form",
        object: "form",
        reason: "a form is awaiting input",
        reference: id,
        startedAt: started,
        deadline: null,
        status: now - started >= deps.config.waitOverdueMs ? "overdue" : "active",
        clearEvidence: null,
        denyEvidence: null,
      })
    }
  }

  const mergeRetryWait = (current: SessionFacts, waits: { items: WatchWaitView[]; partial: boolean }, now: number) => {
    if (current.retry === null) return
    waits.items.push({
      waitID: current.retry.id,
      source: "retry",
      object: "retry",
      reason: `provider retry scheduled (attempt ${current.retry.attempt})`,
      reference: current.retry.id,
      startedAt: current.retry.at,
      deadline: null,
      status: now - current.retry.at >= deps.config.waitOverdueMs ? "overdue" : "active",
      clearEvidence: null,
      denyEvidence: null,
    })
  }

  const mergeAskWaits = async (
    waits: { items: WatchWaitView[]; partial: boolean },
    records: readonly { readonly id: string; readonly value: AskRecord }[],
    current: SessionFacts,
    now: number,
  ) => {
    for (const record of records) {
      const ask = record.value
      if (ask.targetSessionID === undefined) continue
      const reply = await deps.replies.read(ask.askID)
      if (reply !== undefined) {
        const cleared: WatchWaitView = {
          waitID: `ask:${ask.askID}`,
          source: "ask",
          object: "peer ask",
          reason: "a peer question was awaiting an answer",
          reference: ask.askID,
          startedAt: ask.createdAt,
          deadline: ask.expiresAt,
          status: "cleared",
          clearEvidence: "reply stored for this ask",
          denyEvidence: null,
        }
        addCleared(current, cleared)
        if (!waits.items.some((candidate) => candidate.waitID === cleared.waitID)) waits.items.push(cleared)
        continue
      }
      const started = ask.createdAt
      const expired = ask.expiresAt <= now
      waits.items.push({
        waitID: `ask:${ask.askID}`,
        source: "ask",
        object: "peer ask",
        reason: "a peer question is awaiting an answer",
        reference: ask.askID,
        startedAt: started,
        deadline: ask.expiresAt,
        status: expired ? "overdue" : "active",
        clearEvidence: null,
        denyEvidence: null,
      })
    }
  }

  const collectWaits = async (
    task: WatchTaskRecord,
    current: SessionFacts,
    now: number,
  ): Promise<{ items: WatchWaitView[]; partial: boolean }> => {
    const waits: { items: WatchWaitView[]; partial: boolean } = { items: [], partial: false }
    for (const wait of task.reportedWaits) {
      if (wait.clearedAt !== undefined) {
        waits.items.push({
          waitID: wait.waitID,
          source: "reported",
          object: wait.waitFor,
          reason: wait.reason,
          reference: wait.reference,
          startedAt: wait.at,
          deadline: wait.waitUntil ?? null,
          status: "cleared",
          clearEvidence: wait.clearEvidence ?? "reported wait cleared",
          denyEvidence: null,
        })
        continue
      }
      waits.items.push({
        waitID: wait.waitID,
        source: "reported",
        object: wait.waitFor,
        reason: wait.reason,
        reference: wait.reference,
        startedAt: wait.at,
        deadline: wait.waitUntil ?? null,
        status:
          wait.waitUntil !== undefined
            ? now >= wait.waitUntil
              ? "overdue"
              : "active"
            : now - wait.at >= deps.config.waitOverdueMs
              ? "overdue"
              : "active",
        clearEvidence: null,
        denyEvidence: null,
      })
    }
    for (const cleared of current.clearedWaits) waits.items.push(cleared)
    return waits
  }

  const addCleared = (current: SessionFacts, wait: WatchWaitView): void => {
    const existing = current.clearedWaits.findIndex((candidate) => candidate.waitID === wait.waitID)
    if (existing >= 0) {
      current.clearedWaits[existing] = wait
      return
    }
    current.clearedWaits.unshift(wait)
    while (current.clearedWaits.length > MAX_CLEARED_WAITS) {
      const cleared = current.clearedWaits.map((candidate) => candidate.status).lastIndexOf("cleared")
      if (cleared >= 0) {
        current.clearedWaits.splice(cleared, 1)
      } else {
        current.clearedOverflow = true
        current.clearedWaits.pop()
      }
    }
  }

  const readPermissions = async (sessionID: SessionID) => {
    try {
      return { ok: true as const, requests: await deps.permissions.list(sessionID) }
    } catch {
      return { ok: false as const, requests: [] as const }
    }
  }

  const readAsks = async (sessionID: SessionID) => {
    try {
      const records = await deps.asks.list()
      return {
        ok: true as const,
        records: records.filter((record) => record.value.askerSessionID === sessionID),
      }
    } catch {
      return { ok: false as const, records: [] as const }
    }
  }

  const upsert = (
    taskID: string,
    kind: WatchAlertKind,
    dedupe: string,
    summary: string,
    reason: string,
    at: number,
  ) => {
    const result = deps.store.upsertAlert({
      taskId: taskID,
      dedupeKey: dedupe,
      kind,
      summary,
      reason,
      at,
      escalate: true,
    } satisfies UpsertWatchAlertInput)
    if (result?.created === true || result?.escalated === true) {
      try {
        deps.onChanged?.()
      } catch {
        // A UI nudge is not part of the alert commit.
      }
    }
  }

  const resolveConditionAlerts = (taskID: string, dedupeKeys: readonly string[], at: number) => {
    for (const dedupeKey of dedupeKeys) {
      const changed = deps.store.resolveAlert({ taskId: taskID, dedupeKey, at })
      if (changed) {
        try {
          deps.onChanged?.()
        } catch {
          // As above.
        }
      }
    }
  }

  const requestTick = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (ticking) {
      queued = true
      return runningTick ?? Promise.resolve()
    }
    ticking = true
    const run = (async () => {
      do {
        queued = false
        await tick()
      } while (queued && !disposed)
    })()
      .finally(() => {
        ticking = false
        runningTick = undefined
      })
    runningTick = run
    return run
  }

  return {
    start() {
      if (disposed) return
      void (async () => {
        try {
          for await (const event of deps.events.subscribe({ signal: controller.signal })) {
            onEvent(event)
          }
        } catch (error) {
          if (!disposed) {
            gap = `event stream ended: ${describeError(error)}`
            epoch += 1
            factBaseline = deps.scheduler.now()
            resetFacts(factBaseline)
            deps.warn(gap)
          }
        }
        if (!disposed) {
          // A clean end is an observation gap just as an error is: the next
          // sample must not treat the missing interval as continuous silence.
          gap = "event stream ended"
          epoch += 1
          factBaseline = deps.scheduler.now()
          resetFacts(factBaseline)
        }
      })()
      registration = deps.scheduler.every(deps.config.tickMs, requestTick)
    },

    observationFor(taskID) {
      return observations.get(taskID)?.observation ?? null
    },

    activityFor(taskID) {
      return observations.get(taskID)?.activity ?? null
    },

    dispose() {
      disposed = true
      epoch += 1
      controller.abort()
      registration?.dispose()
      registration = undefined
      observations.clear()
      observedWaitKeys.clear()
      taskVersions.clear()
      sessionRevisions.clear()
      facts.clear()
    },
  }
}

function unknownObservation(
  now: number,
  reason: string,
  waits: readonly WatchWaitView[],
  waitsPartial: boolean,
  thresholds: WatchObservationView["effective"],
  truncated = false,
): WatchObservationView {
  return {
    state: "unknown",
    reason,
    observedAt: now,
    baselineAt: null,
    idleSince: null,
    trusted: false,
    waits,
    waitsPartial,
    waitsTruncated: truncated,
    effective: thresholds,
  }
}

function revisionEvent(type: string): boolean {
  return (
    type === "session.execution.started" ||
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted" ||
    type.startsWith("session.text.") ||
    type.startsWith("session.reasoning.") ||
    type.startsWith("session.step.") ||
    type.startsWith("session.tool.") ||
    type.startsWith("session.shell.") ||
    type === "session.inbox.enqueued" ||
    type === "session.retry.scheduled" ||
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "form.created" ||
    type === "form.replied" ||
    type === "form.cancelled" ||
    type === "session.deleted"
  )
}

function waitPriority(wait: WatchWaitView): number {
  if (wait.status === "denied" || wait.status === "unknown") return 0
  if (wait.status === "active" || wait.status === "overdue") return 1
  return 2
}

function activityOf(facts: SessionFacts): WatchActivityView {
  return {
    lastAt: facts.lastActivityAt,
    kind: facts.lastActivityKind,
    judgement: "not-judged",
  }
}

function markActivity(facts: SessionFacts, at: number, kind: ActivityKind) {
  if (facts.lastActivityAt !== null && at < facts.lastActivityAt) return
  facts.lastActivityAt = at
  facts.lastActivityKind = kind
  facts.idleSeenAt = null
  facts.idleTicks = 0
  facts.unknownSince = null
  // A target step/text/tool after a retry is evidence that the retry wait ended;
  // a retry-only observer has no snapshot, so this is the matching terminal fact.
  facts.retry = null
}

function eventAt(event: HostEvent): number | undefined {
  const created = (event as { readonly created?: unknown }).created
  return typeof created === "number" && Number.isFinite(created) && created >= 0 ? created : undefined
}

function sessionOf(event: HostEvent): SessionID | undefined {
  const data = eventData(event)
  const sessionID = data["sessionID"]
  if (typeof sessionID === "string") return sessionID
  const form = asRecord(data["form"])
  const formSessionID = form?.["sessionID"]
  return typeof formSessionID === "string" ? formSessionID : undefined
}

function eventData(event: HostEvent): Record<string, unknown> {
  const data = (event as { readonly data?: unknown }).data
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
