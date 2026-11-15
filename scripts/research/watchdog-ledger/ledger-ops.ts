/**
 * State transitions for the issue #57 research ledger.
 *
 * Every function runs one `BEGIN IMMEDIATE` transaction through the core and
 * returns an `Outcome`; expected refusals are codes, not thrown exceptions.
 */

import {
  MAX_RESERVATIONS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  checkGeneration,
  checkID,
  LedgerFailure,
  type HandoverEvidence,
  type LedgerCore,
  type Outcome,
  type ReservationState,
  type TaskState,
} from "./ledger-core.ts"

export function registerTask(
  core: LedgerCore,
  input: {
    requestId: string
    taskId: string
    sessionId: string
    ownerActivation: string
    authorizationRound: string
    now?: number
  },
): Outcome<{ taskId: string; generation: number; created: boolean; state: TaskState["state"] }> {
  try {
    checkID("requestId", input.requestId)
    checkID("taskId", input.taskId)
    checkID("sessionId", input.sessionId)
    checkID("ownerActivation", input.ownerActivation)
    checkID("authorizationRound", input.authorizationRound)
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const previous = core.db
        .query("SELECT task_id, session_id FROM registration_requests WHERE request_id = ?")
        .get(input.requestId) as { task_id: string; session_id: string } | null
      if (previous !== null) {
        if (previous.task_id !== input.taskId || previous.session_id !== input.sessionId) {
          throw new LedgerFailure("request_conflict", "request id was used for another task")
        }
        const task = core.task(previous.task_id)
        return { taskId: task.task_id, generation: task.generation, created: false, state: task.state }
      }
      const live = core.db
        .query("SELECT task_id FROM watch_tasks WHERE session_id = ? AND state IN ('active','paused')")
        .get(input.sessionId) as { task_id: string } | null
      if (live !== null) throw new LedgerFailure("session_conflict", live.task_id)

      core.db
        .query(
          `INSERT INTO watch_tasks
           (task_id, ledger_id, schema_version, protocol_version, session_id, authorization_round,
            state, owner_activation, generation, reserved_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, 0, ?, ?)`,
        )
        .run(
          input.taskId,
          core.ledgerId,
          SCHEMA_VERSION,
          PROTOCOL_VERSION,
          input.sessionId,
          input.authorizationRound,
          input.ownerActivation,
          now,
          now,
        )
      core.db
        .query("INSERT INTO registration_requests (request_id, task_id, session_id, created_at) VALUES (?, ?, ?, ?)")
        .run(input.requestId, input.taskId, input.sessionId, now)
      core.event(input.taskId, "task.registered", { sessionId: input.sessionId }, now)
      return { taskId: input.taskId, generation: 1, created: true, state: "active" as const }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}

export function reserve(
  core: LedgerCore,
  input: { reservationId: string; taskId: string; expectedGeneration: number; ownerActivation: string; now?: number },
): Outcome<{ reservationId: string; attemptNo: number; fresh: boolean; maySend: boolean; state: ReservationState["state"] }> {
  try {
    checkID("reservationId", input.reservationId)
    checkID("taskId", input.taskId)
    checkID("ownerActivation", input.ownerActivation)
    checkGeneration(input.expectedGeneration)
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const existing = core.db
        .query("SELECT * FROM reservations WHERE reservation_id = ?")
        .get(input.reservationId) as ReservationState | null
      if (existing !== null) {
        if (existing.task_id !== input.taskId) throw new LedgerFailure("reservation_conflict", existing.task_id)
        if (existing.ledger_id !== core.ledgerId) throw new LedgerFailure("ledger_mismatch", existing.ledger_id)
        return {
          reservationId: existing.reservation_id,
          attemptNo: existing.attempt_no,
          fresh: false,
          maySend: false,
          state: existing.state,
        }
      }
      const task = core.task(input.taskId)
      if (task.state !== "active") throw new LedgerFailure("not_active", task.state)
      if (task.generation !== input.expectedGeneration || task.owner_activation !== input.ownerActivation) {
        throw new LedgerFailure(
          "stale_owner",
          `expected generation=${input.expectedGeneration} owner=${input.ownerActivation}; ` +
            `actual generation=${task.generation} owner=${task.owner_activation}`,
        )
      }
      if (task.reserved_count >= MAX_RESERVATIONS) throw new LedgerFailure("quota_exhausted", String(task.reserved_count))
      const open = core.db
        .query(
          "SELECT reservation_id, state FROM reservations WHERE task_id = ? AND state IN ('reserved','sending','accepted','result_unknown')",
        )
        .get(task.task_id) as { reservation_id: string; state: string } | null
      if (open !== null) throw new LedgerFailure("pending_attempt", `${open.reservation_id}:${open.state}`)

      const attemptNo = task.reserved_count + 1
      core.db
        .query(
          `INSERT INTO reservations
           (reservation_id, task_id, ledger_id, generation, attempt_no, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(input.reservationId, task.task_id, core.ledgerId, task.generation, attemptNo, now, now)
      core.db.query("UPDATE watch_tasks SET reserved_count = ?, updated_at = ? WHERE task_id = ?").run(attemptNo, now, task.task_id)
      core.event(task.task_id, "reservation.created", { reservationId: input.reservationId, attemptNo }, now)
      return { reservationId: input.reservationId, attemptNo, fresh: true, maySend: true, state: "reserved" as const }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}

export function markSending(
  core: LedgerCore,
  input: { reservationId: string; taskId: string; expectedGeneration: number; ownerActivation: string; now?: number },
): Outcome<{ maySend: boolean; code?: "already_sending" }> {
  try {
    checkID("reservationId", input.reservationId)
    checkID("taskId", input.taskId)
    checkID("ownerActivation", input.ownerActivation)
    checkGeneration(input.expectedGeneration)
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const task = core.task(input.taskId)
      if (task.state !== "active") throw new LedgerFailure("not_active", task.state)
      if (task.generation !== input.expectedGeneration || task.owner_activation !== input.ownerActivation) {
        throw new LedgerFailure("stale_owner", `generation=${task.generation} owner=${task.owner_activation}`)
      }
      const reservation = core.reservation(input.reservationId)
      if (reservation.task_id !== task.task_id) throw new LedgerFailure("reservation_conflict", reservation.task_id)
      if (reservation.generation !== task.generation) throw new LedgerFailure("stale_owner", "reservation generation")
      if (reservation.state === "sending") return { maySend: false, code: "already_sending" as const }
      if (reservation.state !== "reserved") throw new LedgerFailure("not_reserved", reservation.state)
      core.db.query("UPDATE reservations SET state = 'sending', updated_at = ? WHERE reservation_id = ?").run(now, input.reservationId)
      core.event(task.task_id, "reservation.sending", { reservationId: input.reservationId }, now)
      return { maySend: true }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}

export function recordOutcome(
  core: LedgerCore,
  input: {
    reservationId: string
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    outcome: "accepted" | "consumed" | "not_accepted" | "unknown"
    now?: number
  },
): Outcome<{ state: ReservationState["state"]; changed: boolean }> {
  try {
    checkID("reservationId", input.reservationId)
    checkID("taskId", input.taskId)
    checkID("ownerActivation", input.ownerActivation)
    checkGeneration(input.expectedGeneration)
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const task = core.task(input.taskId)
      if (task.generation !== input.expectedGeneration || task.owner_activation !== input.ownerActivation) {
        throw new LedgerFailure("stale_owner", `generation=${task.generation} owner=${task.owner_activation}`)
      }
      const reservation = core.reservation(input.reservationId)
      if (reservation.task_id !== task.task_id) throw new LedgerFailure("reservation_conflict", reservation.task_id)
      const target: ReservationState["state"] =
        input.outcome === "accepted"
          ? "accepted"
          : input.outcome === "consumed"
            ? "result_recorded"
            : input.outcome === "not_accepted"
              ? "aborted"
              : "result_unknown"
      if (reservation.state === target) return { state: target, changed: false }
      const allowed: Record<ReservationState["state"], ReservationState["state"][]> = {
        reserved: ["accepted", "aborted", "result_unknown"],
        sending: ["accepted", "result_recorded", "aborted", "result_unknown"],
        accepted: ["result_recorded", "result_unknown"],
        result_recorded: [],
        result_unknown: [],
        aborted: [],
      }
      if (!allowed[reservation.state].includes(target)) {
        throw new LedgerFailure("already_terminal", `${reservation.state} -> ${target}`)
      }
      core.db.query("UPDATE reservations SET state = ?, updated_at = ? WHERE reservation_id = ?").run(target, now, input.reservationId)
      core.event(task.task_id, "reservation.outcome", { reservationId: input.reservationId, outcome: input.outcome, state: target }, now)
      return { state: target, changed: true }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}

export function confirmHandover(
  core: LedgerCore,
  input: {
    handoverId: string
    taskId: string
    expectedGeneration: number
    fromActivation: string
    toActivation: string
    evidence: HandoverEvidence
    now?: number
  },
): Outcome<{ generation: number; changed: boolean }> {
  try {
    checkID("handoverId", input.handoverId)
    checkID("taskId", input.taskId)
    checkID("fromActivation", input.fromActivation)
    checkID("toActivation", input.toActivation)
    checkGeneration(input.expectedGeneration)
    const evidence = input.evidence
    if (
      evidence === undefined ||
      evidence.oldOwnerStopped !== true ||
      evidence.inFlightResolved !== true ||
      evidence.noUnconsumedMessages !== true ||
      typeof evidence.stopProof !== "string" ||
      evidence.stopProof.length === 0 ||
      !Number.isFinite(evidence.observedAt)
    ) {
      throw new LedgerFailure("stop_proof_missing", "stop proof, in-flight resolution and no-unconsumed evidence are required")
    }
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const task = core.task(input.taskId)
      if (task.state !== "active" && task.state !== "paused") throw new LedgerFailure("not_active", task.state)
      if (task.generation !== input.expectedGeneration || task.owner_activation !== input.fromActivation) {
        throw new LedgerFailure("stale_owner", `generation=${task.generation} owner=${task.owner_activation}`)
      }
      if (task.owner_activation === input.toActivation) throw new LedgerFailure("conflict", "already the owner")
      const open = core.db
        .query(
          "SELECT reservation_id, state FROM reservations WHERE task_id = ? AND state IN ('reserved','sending','accepted','result_unknown')",
        )
        .get(task.task_id) as { reservation_id: string; state: string } | null
      if (open !== null) throw new LedgerFailure("pending_attempt", `${open.reservation_id}:${open.state}`)

      const update = core.db
        .query(
          `UPDATE watch_tasks
           SET owner_activation = ?, generation = generation + 1, state = 'active', updated_at = ?
           WHERE task_id = ? AND generation = ? AND owner_activation = ?`,
        )
        .run(input.toActivation, now, task.task_id, input.expectedGeneration, input.fromActivation)
      if (update.changes !== 1) throw new LedgerFailure("stale_owner", "the task changed during handover")
      core.db
        .query(
          `INSERT INTO handovers
           (handover_id, task_id, from_generation, to_generation, from_activation, to_activation, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.handoverId,
          task.task_id,
          task.generation,
          task.generation + 1,
          input.fromActivation,
          input.toActivation,
          JSON.stringify(evidence),
          now,
        )
      core.event(task.task_id, "task.handover", { handoverId: input.handoverId, from: task.generation, to: task.generation + 1 }, now)
      return { generation: task.generation + 1, changed: true }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}

export function setState(
  core: LedgerCore,
  input: {
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    state: "paused" | "sealed" | "completed" | "cancelled"
    now?: number
  },
): Outcome<{ state: TaskState["state"] }> {
  try {
    checkID("taskId", input.taskId)
    checkID("ownerActivation", input.ownerActivation)
    checkGeneration(input.expectedGeneration)
    return core.immediate(() => {
      const now = input.now ?? Date.now()
      const task = core.task(input.taskId)
      if (task.generation !== input.expectedGeneration || task.owner_activation !== input.ownerActivation) {
        throw new LedgerFailure("stale_owner", `generation=${task.generation} owner=${task.owner_activation}`)
      }
      if (task.state !== "active" && task.state !== "paused") throw new LedgerFailure("not_active", task.state)
      core.db.query("UPDATE watch_tasks SET state = ?, updated_at = ? WHERE task_id = ?").run(input.state, now, task.task_id)
      core.event(task.task_id, `task.${input.state}`, {}, now)
      return { state: input.state }
    })
  } catch (error) {
    return { ok: false, ...(error instanceof LedgerFailure ? { code: error.code, detail: error.detail } : { code: "ledger_error" as const, detail: String(error) }) }
  }
}
