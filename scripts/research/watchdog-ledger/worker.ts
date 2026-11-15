/**
 * One process per experiment for issue #57.
 *
 * Each invocation opens the ledger, optionally waits on a file barrier so many
 * processes contend at the same instant, performs exactly one action, and
 * prints a JSON line. `crash-*` modes kill themselves after the interesting
 * durable write; `raw-send` deliberately bypasses the ledger to show what a
 * ledger cannot stop.
 *
 * Run through `run.ts`; this file is not a production entry point.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { Ledger } from "./ledger.ts"

function args(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const argument of Bun.argv.slice(2)) {
    if (!argument.startsWith("--")) continue
    const index = argument.indexOf("=")
    if (index === -1) result[argument.slice(2)] = "1"
    else result[argument.slice(2, index)] = argument.slice(index + 1)
  }
  return result
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]
  if (value === undefined) throw new Error(`missing --${key}`)
  return value
}

function number(values: Record<string, string>, key: string, fallback?: number): number {
  const value = values[key]
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`missing --${key}`)
    return fallback
  }
  return Number(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitBarrier(path: string | undefined, timeoutMs = 15_000): Promise<void> {
  if (path === undefined) return
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`barrier ${path} did not appear`)
    await sleep(2)
  }
}

function append(path: string, record: unknown): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}

function emit(value: unknown): void {
  console.log(JSON.stringify(value))
}

const values = args()
const dbPath = required(values, "db")
const mode = required(values, "mode")

try {
  const opened = Ledger.open(dbPath, { busyTimeoutMs: number(values, "busy", 1500) })
  if (!opened.ok) {
    emit({ ok: false, mode, code: opened.code, detail: opened.detail, pid: process.pid })
    process.exit(0)
  }
  const ledger = opened.value
  const taskId = values["task"] ?? "task-1"
  const activation = values["activation"] ?? "act-1"
  const generation = number(values, "gen", 1)

  await waitBarrier(values["barrier"])

  if (mode === "register") {
    const result = ledger.registerTask({
      requestId: required(values, "request"),
      taskId,
      sessionId: required(values, "session"),
      ownerActivation: activation,
      authorizationRound: values["round"] ?? "round-1",
    })
    emit({ mode, pid: process.pid, result })
  } else if (mode === "reserve") {
    const result = ledger.reserve({
      reservationId: required(values, "reservation"),
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    emit({ mode, pid: process.pid, result, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "reserve-send") {
    const reservationId = required(values, "reservation")
    const reserved = ledger.reserve({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    let send: unknown = null
    if (reserved.ok && reserved.value.fresh) {
      const sending = ledger.markSending({ reservationId, taskId, expectedGeneration: generation, ownerActivation: activation })
      if (sending.ok && sending.value.maySend) {
        append(required(values, "sendlog"), {
          at: Date.now(),
          pid: process.pid,
          reservationId,
          taskId,
          generation,
          kind: "prompt",
          afterReserve: true,
        })
        const outcome = values["outcome"] ?? "consumed"
        send = ledger.recordOutcome({
          reservationId,
          taskId,
          expectedGeneration: generation,
          ownerActivation: activation,
          outcome: outcome as "accepted" | "consumed" | "not_accepted" | "unknown",
        })
      } else {
        send = sending
      }
    }
    emit({ mode, pid: process.pid, reserved, send, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "reserve-hold-send") {
    const reservationId = required(values, "reservation")
    const reserved = ledger.reserve({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    if (!reserved.ok || !reserved.value.fresh) throw new Error(`reserve failed: ${reserved.ok ? "not fresh" : reserved.code}`)
    const sending = ledger.markSending({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    if (!sending.ok || !sending.value.maySend) throw new Error("could not mark sending")
    const marker = required(values, "marker")
    writeFileSync(marker, JSON.stringify({ pid: process.pid, reserved }))
    await sleep(number(values, "hold", 1000))
    append(required(values, "sendlog"), {
      at: Date.now(),
      pid: process.pid,
      reservationId,
      taskId,
      generation,
      kind: "prompt-late",
    })
    const outcome = ledger.recordOutcome({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
      outcome: "consumed",
    })
    emit({ mode, pid: process.pid, reserved, sending, outcome })
  } else if (mode === "crash-after-reserve") {
    const reservationId = required(values, "reservation")
    const reserved = ledger.reserve({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    writeFileSync(required(values, "marker"), JSON.stringify({ pid: process.pid, reserved, at: Date.now() }))
    process.kill(process.pid, "SIGKILL")
  } else if (mode === "crash-after-send") {
    const reservationId = required(values, "reservation")
    const reserved = ledger.reserve({
      reservationId,
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    if (!reserved.ok) throw new Error(`reserve failed: ${reserved.code}`)
    const sending = ledger.markSending({ reservationId, taskId, expectedGeneration: generation, ownerActivation: activation })
    if (!sending.ok || !sending.value.maySend) throw new Error("could not mark sending")
    append(required(values, "sendlog"), {
      at: Date.now(),
      pid: process.pid,
      reservationId,
      taskId,
      generation,
      kind: "prompt-before-crash",
    })
    writeFileSync(required(values, "marker"), JSON.stringify({ pid: process.pid, at: Date.now() }))
    process.kill(process.pid, "SIGKILL")
  } else if (mode === "outcome") {
    const result = ledger.recordOutcome({
      reservationId: required(values, "reservation"),
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
      outcome: required(values, "outcome") as "accepted" | "consumed" | "not_accepted" | "unknown",
    })
    emit({ mode, pid: process.pid, result, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "mark-sending") {
    const result = ledger.markSending({
      reservationId: required(values, "reservation"),
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
    })
    emit({ mode, pid: process.pid, result, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "handover") {
    const result = ledger.confirmHandover({
      handoverId: required(values, "handover"),
      taskId,
      expectedGeneration: generation,
      fromActivation: required(values, "from"),
      toActivation: required(values, "to"),
      evidence: {
        oldOwnerStopped: true,
        inFlightResolved: true,
        noUnconsumedMessages: true,
        stopProof: values["proof"] ?? "test stop proof",
        observedAt: Date.now(),
      },
    })
    emit({ mode, pid: process.pid, result, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "state") {
    const result = ledger.setState({
      taskId,
      expectedGeneration: generation,
      ownerActivation: activation,
      state: required(values, "state") as "paused" | "sealed" | "completed" | "cancelled",
    })
    emit({ mode, pid: process.pid, result, snapshot: ledger.snapshot(taskId) })
  } else if (mode === "raw-send") {
    append(required(values, "sendlog"), {
      at: Date.now(),
      pid: process.pid,
      reservationId: values["reservation"] ?? null,
      taskId,
      generation,
      kind: "raw-prompt",
      bypassedLedger: true,
    })
    emit({ mode, pid: process.pid, sent: true })
  } else if (mode === "force-handover") {
    // Negative control only: a fencing-only design that updates the owner and
    // generation without checking unresolved reservations. It is deliberately
    // raw SQL so the ledger API cannot be mistaken for offering this path.
    const raw = new (await import("bun:sqlite")).Database(dbPath, { strict: true })
    raw.run("PRAGMA busy_timeout = 1500")
    raw.transaction(() => {
      const from = required(values, "from")
      const to = required(values, "to")
      const update = raw
        .query(
          "UPDATE watch_tasks SET owner_activation = ?, generation = generation + 1, updated_at = ? WHERE task_id = ? AND generation = ? AND owner_activation = ?",
        )
        .run(to, Date.now(), taskId, generation, from)
      if (update.changes !== 1) throw new Error("force-handover did not match the expected owner")
      raw
        .query(
          "INSERT INTO handovers (handover_id, task_id, from_generation, to_generation, from_activation, to_activation, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(required(values, "handover"), taskId, generation, generation + 1, from, to, "{\"testOnly\":true}", Date.now())
    }).immediate()
    raw.close()
    emit({ mode, pid: process.pid, forced: true })
  } else if (mode === "hold-lock") {
    // Acquire the write lock first, then announce it so the contender is
    // guaranteed to meet a held lock rather than a process that has not begun.
    const raw = new (await import("bun:sqlite")).Database(dbPath, { strict: true })
    raw.run("PRAGMA busy_timeout = 1500")
    raw.run("BEGIN IMMEDIATE")
    if (values["marker"] !== undefined) writeFileSync(values["marker"], JSON.stringify({ pid: process.pid }))
    await sleep(number(values, "hold", 2000))
    raw.run("COMMIT")
    raw.close()
    emit({ mode, pid: process.pid, held: true })
  } else if (mode === "lww") {
    // Negative control: a storage-like read-modify-write with no transaction.
    // Every process reads the same count, sleeps, writes count+1 and sends.
    const raw = new (await import("bun:sqlite")).Database(dbPath, { strict: true })
    raw.run("PRAGMA busy_timeout = 1500")
    raw.run("CREATE TABLE IF NOT EXISTS lww_budget (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)")
    raw.run("INSERT OR IGNORE INTO lww_budget (id, count) VALUES (1, 0)")
    const seen = (raw.query("SELECT count FROM lww_budget WHERE id = 1").get() as { count: number }).count
    await sleep(number(values, "delay", 50))
    raw.query("UPDATE lww_budget SET count = ? WHERE id = 1").run(seen + 1)
    append(required(values, "sendlog"), {
      at: Date.now(),
      pid: process.pid,
      kind: "lww-prompt",
      seen,
      wrote: seen + 1,
    })
    raw.close()
    emit({ mode, pid: process.pid, seen, wrote: seen + 1 })
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
  ledger.close()
} catch (error) {
  emit({
    ok: false,
    mode,
    pid: process.pid,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
  process.exitCode = 1
}
