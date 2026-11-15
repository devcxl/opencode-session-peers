/**
 * Seal, busy-timeout and durability experiments for issue #57.
 */

import { join } from "node:path"
import { argsFor, check, fresh, readJsonLines, register, runWorker, waitFor, withLedger, type Json, type Scenario } from "./experiment.ts"
import { codeOf, reserveArgs, resultOf, scenario } from "./scenario-helpers.ts"

export async function seal(): Promise<Scenario> {
  return scenario("seal", async (checks, observations) => {
    const scratch = fresh("seal")
    register(scratch)
    withLedger(scratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    const sealed = withLedger(scratch.db, (ledger) =>
      ledger.setState({ taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1", state: "sealed" }),
    )
    check(checks, "seal succeeds for the current owner", sealed.ok === true, sealed)
    const next = withLedger(scratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-2", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    check(checks, "seal blocks a new reservation", next.ok === false && next.code === "not_active", next)
    const cooperative = withLedger(scratch.db, (ledger) =>
      ledger.markSending({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    check(checks, "a cooperative sender is stopped by seal", cooperative.ok === false && cooperative.code === "not_active", cooperative)
    await runWorker(argsFor(scratch, "raw-send", { task: "task-1", gen: 1, reservation: "res-1", sendlog: scratch.sendlog, barrier: undefined }))
    check(checks, "seal cannot retract a prompt the old owner still sends", readJsonLines(scratch.sendlog).length === 1)

    const accepted = fresh("seal-accepted")
    register(accepted)
    await runWorker(
      argsFor(accepted, "reserve-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-a",
        sendlog: accepted.sendlog,
        outcome: "accepted",
        barrier: undefined,
      }),
    )
    withLedger(accepted.db, (ledger) =>
      ledger.setState({ taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1", state: "sealed" }),
    )
    await runWorker(argsFor(accepted, "raw-send", { task: "task-1", gen: 1, reservation: "res-a", sendlog: accepted.sendlog, barrier: undefined }))
    check(checks, "a message accepted before seal can still be consumed after it", readJsonLines(accepted.sendlog).length === 2)
    const acceptedNext = withLedger(accepted.db, (ledger) =>
      ledger.reserve({ reservationId: "res-b", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    check(checks, "the sealed task still refuses new work", acceptedNext.ok === false && acceptedNext.code === "not_active", acceptedNext)

    const cancelled = fresh("cancel")
    register(cancelled)
    const cancel = withLedger(cancelled.db, (ledger) =>
      ledger.setState({ taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1", state: "cancelled" }),
    )
    const cancelReserve = withLedger(cancelled.db, (ledger) =>
      ledger.reserve({ reservationId: "res-c", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    check(checks, "cancel also blocks new reservations", cancel.ok === true && cancelReserve.ok === false && cancelReserve.code === "not_active", { cancel, cancelReserve })
    observations["scratchSnapshot"] = withLedger(scratch.db, (ledger) => ledger.snapshot("task-1"))
  })
}

export async function busyTimeout(): Promise<Scenario> {
  return scenario("busy-timeout", async (checks, observations) => {
    const scratch = fresh("busy-timeout")
    register(scratch)
    const marker = join(scratch.root, "lock-held.json")
    const holder = runWorker(argsFor(scratch, "hold-lock", { hold: 2000, marker }))
    await waitFor(marker)
    const started = Date.now()
    const contender = await runWorker(reserveArgs(scratch, "res-busy", { busy: 300, barrier: undefined }), 8_000)
    const elapsed = Date.now() - started
    check(checks, "a held write lock yields a bounded lock_timeout", codeOf(contender) === "lock_timeout", { code: codeOf(contender), elapsed })
    check(checks, "the wait is shorter than the lock holder's hold", elapsed < 1_500, elapsed)
    await holder
    const retry = await runWorker(reserveArgs(scratch, "res-after", { busy: 2_000, barrier: undefined }), 8_000)
    check(checks, "the same reservation succeeds after the lock is released", resultOf(retry)["ok"] === true, resultOf(retry))
    observations["elapsedMs"] = elapsed
  })
}

export async function durability(): Promise<Scenario> {
  return scenario("durability", async (checks, observations) => {
    const runs: Json[] = []
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const scratch = fresh(`durability-${iteration}`)
      register(scratch)
      const marker = join(scratch.root, "marker.json")
      const run = await runWorker(
        argsFor(scratch, "crash-after-reserve", { task: "task-1", gen: 1, activation: "act-1", reservation: `res-${iteration}`, marker }),
      )
      await waitFor(marker)
      const snapshot = withLedger(scratch.db, (ledger) => ledger.snapshot("task-1"))
      runs.push({ iteration, code: run.code, state: snapshot.reservations[0]?.state, count: snapshot.task?.reserved_count })
      check(checks, `iteration ${iteration}: committed reservation survives SIGKILL`, snapshot.reservations[0]?.state === "reserved" && snapshot.task?.reserved_count === 1, snapshot)
    }
    observations["runs"] = runs
  })
}
