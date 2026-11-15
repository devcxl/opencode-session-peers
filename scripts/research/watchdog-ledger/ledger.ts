/**
 * Facade for the issue #57 research ledger.
 *
 * The core owns opening/schema/helpers; the operation module owns the state
 * transitions; this class keeps the small API the experiments use.
 */

import {
  LedgerCore,
  openCore,
  type HandoverEvidence,
  type OpenOptions,
  type Outcome,
  type ReservationState,
  type TaskState,
} from "./ledger-core.ts"
import { confirmHandover, markSending, recordOutcome, registerTask, reserve, setState } from "./ledger-ops.ts"

export * from "./ledger-core.ts"

export class Ledger {
  private constructor(private readonly core: LedgerCore) {}

  static open(path: string, options: OpenOptions = {}): Outcome<Ledger> {
    const opened = openCore(path, options)
    return opened.ok ? { ok: true, value: new Ledger(opened.value) } : opened
  }

  get path(): string {
    return this.core.path
  }

  get ledgerId(): string {
    return this.core.ledgerId
  }

  close(): void {
    this.core.close()
  }

  holdWriteLock(ms: number): void {
    this.core.holdWriteLock(ms)
  }

  info(): { ledgerId: string; path: string; schemaVersion: number; protocolVersion: number } {
    return this.core.info()
  }

  registerTask(input: {
    requestId: string
    taskId: string
    sessionId: string
    ownerActivation: string
    authorizationRound: string
    now?: number
  }): Outcome<{ taskId: string; generation: number; created: boolean; state: TaskState["state"] }> {
    return registerTask(this.core, input)
  }

  reserve(input: {
    reservationId: string
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    now?: number
  }): Outcome<{
    reservationId: string
    attemptNo: number
    fresh: boolean
    maySend: boolean
    state: ReservationState["state"]
  }> {
    return reserve(this.core, input)
  }

  markSending(input: {
    reservationId: string
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    now?: number
  }): Outcome<{ maySend: boolean; code?: "already_sending" }> {
    return markSending(this.core, input)
  }

  recordOutcome(input: {
    reservationId: string
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    outcome: "accepted" | "consumed" | "not_accepted" | "unknown"
    now?: number
  }): Outcome<{ state: ReservationState["state"]; changed: boolean }> {
    return recordOutcome(this.core, input)
  }

  confirmHandover(input: {
    handoverId: string
    taskId: string
    expectedGeneration: number
    fromActivation: string
    toActivation: string
    evidence: HandoverEvidence
    now?: number
  }): Outcome<{ generation: number; changed: boolean }> {
    return confirmHandover(this.core, input)
  }

  setState(input: {
    taskId: string
    expectedGeneration: number
    ownerActivation: string
    state: "paused" | "sealed" | "completed" | "cancelled"
    now?: number
  }): Outcome<{ state: TaskState["state"] }> {
    return setState(this.core, input)
  }

  snapshot(taskId: string) {
    return this.core.snapshot(taskId)
  }

  countReservations(taskId: string): number {
    return this.core.countReservations(taskId)
  }

  countTasks(sessionId?: string): number {
    return this.core.countTasks(sessionId)
  }

  mode(): { db: number; directory: number } {
    return this.core.mode()
  }
}
