/**
 * Handover and late-send experiments for issue #57.
 */

import { join } from "node:path"
import { argsFor, check, fresh, readJsonLines, register, runMany, runWorker, waitFor, withLedger, type Json, type Scenario } from "./experiment.ts"
import { codeOf, payload, reserveArgs, resultOf, scenario, valueOf } from "./scenario-helpers.ts"

export async function handover(): Promise<Scenario> {
  return scenario("handover", async (checks, observations) => {
    const scratch = fresh("handover")
    register(scratch)
    const restartReserve = await runWorker(
      argsFor(scratch, "reserve", {
        task: "task-1",
        gen: 1,
        activation: "act-restarted",
        reservation: "res-restart",
        barrier: undefined,
      }),
    )
    check(checks, "a restarted owner with a new activation cannot auto-take-over", codeOf(restartReserve) === "stale_owner", codeOf(restartReserve))
    const workers = Array.from({ length: 10 }, (_, index) => ({
      args: argsFor(scratch, "handover", {
        task: "task-1",
        gen: 1,
        from: "act-1",
        to: `act-2-${index}`,
        handover: `h-${index}`,
        proof: `proof-${index}`,
        barrier: scratch.barrier,
      }),
    }))
    const runs = await runMany(workers, scratch.barrier)
    const winners = runs.filter((run) => resultOf(run)["ok"] === true)
    check(checks, "exactly one concurrent handover for the same generation wins", winners.length === 1, runs.map(codeOf))
    check(checks, "losers are stale_owner", runs.filter((run) => codeOf(run) === "stale_owner").length === 9, runs.map(codeOf))
    const snapshot = withLedger(scratch.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "the task generation advanced exactly once", snapshot.task?.generation === 2, snapshot.task?.generation)
    check(checks, "only one handover row exists", snapshot.handovers.length === 1)
    if (winners[0] === undefined) {
      check(checks, "a handover winner exists", false, runs.map((run) => run.stderr.slice(-500)))
      return
    }
    observations["winner"] = valueOf(winners[0])
    const oldReserve = await runWorker(reserveArgs(scratch, "res-old", { barrier: undefined }))
    check(checks, "the old owner's new reservation is refused", codeOf(oldReserve) === "stale_owner", codeOf(oldReserve))
    const winnerIndex = runs.findIndex((run) => resultOf(run)["ok"] === true)
    const to = `act-2-${winnerIndex}`
    const newReserve = await runWorker(reserveArgs(scratch, "res-new", { gen: 2, activation: to, barrier: undefined }))
    check(checks, "the new owner can reserve once", resultOf(newReserve)["ok"] === true, resultOf(newReserve))

    const missingEvidence = withLedger(scratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-missing",
        taskId: "task-1",
        expectedGeneration: 2,
        fromActivation: to,
        toActivation: "act-3",
        evidence: {} as never,
      }),
    )
    check(checks, "handover without stop proof is refused", missingEvidence.ok === false && missingEvidence.code === "stop_proof_missing", missingEvidence)

    const falseEvidence = withLedger(scratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-false",
        taskId: "task-1",
        expectedGeneration: 2,
        fromActivation: to,
        toActivation: "act-3",
        evidence: {
          oldOwnerStopped: false,
          inFlightResolved: true,
          noUnconsumedMessages: true,
          stopProof: "not stopped",
          observedAt: Date.now(),
        } as never,
      }),
    )
    check(checks, "an attestation that the old owner is not stopped is refused", falseEvidence.ok === false && falseEvidence.code === "stop_proof_missing", falseEvidence)

    const pendingScratch = fresh("handover-pending")
    register(pendingScratch)
    withLedger(pendingScratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-p", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    const pendingHandover = withLedger(pendingScratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-p",
        taskId: "task-1",
        expectedGeneration: 1,
        fromActivation: "act-1",
        toActivation: "act-2",
        evidence: { oldOwnerStopped: true, inFlightResolved: true, noUnconsumedMessages: true, stopProof: "proof", observedAt: Date.now() },
      }),
    )
    check(checks, "an unresolved reservation refuses handover", pendingHandover.ok === false && pendingHandover.code === "pending_attempt", pendingHandover)

    const acceptedScratch = fresh("handover-accepted")
    register(acceptedScratch)
    withLedger(acceptedScratch.db, (ledger) => {
      ledger.reserve({ reservationId: "res-a", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" })
      ledger.markSending({ reservationId: "res-a", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" })
      ledger.recordOutcome({
        reservationId: "res-a",
        taskId: "task-1",
        expectedGeneration: 1,
        ownerActivation: "act-1",
        outcome: "accepted",
      })
    })
    const acceptedHandover = withLedger(acceptedScratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-a",
        taskId: "task-1",
        expectedGeneration: 1,
        fromActivation: "act-1",
        toActivation: "act-2",
        evidence: { oldOwnerStopped: true, inFlightResolved: true, noUnconsumedMessages: true, stopProof: "proof", observedAt: Date.now() },
      }),
    )
    check(checks, "an accepted but unconsumed message refuses handover", acceptedHandover.ok === false && acceptedHandover.code === "pending_attempt", acceptedHandover)

    const resolved = withLedger(acceptedScratch.db, (ledger) => {
      ledger.recordOutcome({
        reservationId: "res-a",
        taskId: "task-1",
        expectedGeneration: 1,
        ownerActivation: "act-1",
        outcome: "consumed",
      })
      return ledger.confirmHandover({
        handoverId: "h-a2",
        taskId: "task-1",
        expectedGeneration: 1,
        fromActivation: "act-1",
        toActivation: "act-2",
        evidence: { oldOwnerStopped: true, inFlightResolved: true, noUnconsumedMessages: true, stopProof: "proof", observedAt: Date.now() },
      })
    })
    check(checks, "handover succeeds once the action is consumed", resolved.ok === true, resolved)
    check(checks, "old owner is locked out after handover", withLedger(acceptedScratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-old", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    ).ok === false)
    check(checks, "new owner can reserve after handover", withLedger(acceptedScratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-new", taskId: "task-1", expectedGeneration: 2, ownerActivation: "act-2" }),
    ).ok === true)

    observations["snapshot"] = snapshot
    observations["pendingHandover"] = pendingHandover
    observations["acceptedHandover"] = acceptedHandover
  })
}

export async function lateSend(): Promise<Scenario> {
  return scenario("late-send", async (checks, observations) => {
    const scratch = fresh("late-send")
    register(scratch)
    const marker = join(scratch.root, "reserved.json")
    const worker = runWorker(
      argsFor(scratch, "reserve-hold-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-late",
        sendlog: scratch.sendlog,
        marker,
        hold: 900,
      }),
    )
    await waitFor(marker)
    const refused = withLedger(scratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-late",
        taskId: "task-1",
        expectedGeneration: 1,
        fromActivation: "act-1",
        toActivation: "act-2",
        evidence: { oldOwnerStopped: true, inFlightResolved: true, noUnconsumedMessages: true, stopProof: "proof", observedAt: Date.now() },
      }),
    )
    check(checks, "handover is refused while the old owner has a reservation", refused.ok === false && refused.code === "pending_attempt", refused)
    const finished = await worker
    check(checks, "the old owner still sends after the refused handover", readJsonLines(scratch.sendlog).length === 1, readJsonLines(scratch.sendlog))
    check(checks, "the old owner records its own result", (payload(finished)["outcome"] as Json | undefined)?.["ok"] === true, payload(finished))
    const after = withLedger(scratch.db, (ledger) =>
      ledger.confirmHandover({
        handoverId: "h-late-2",
        taskId: "task-1",
        expectedGeneration: 1,
        fromActivation: "act-1",
        toActivation: "act-2",
        evidence: { oldOwnerStopped: true, inFlightResolved: true, noUnconsumedMessages: true, stopProof: "proof", observedAt: Date.now() },
      }),
    )
    check(checks, "handover succeeds only after the old action is resolved", after.ok === true, after)

    const forced = fresh("forced-handover")
    register(forced)
    const forcedMarker = join(forced.root, "reserved.json")
    const forcedWorker = runWorker(
      argsFor(forced, "reserve-hold-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-forced",
        sendlog: forced.sendlog,
        marker: forcedMarker,
        hold: 900,
      }),
    )
    await waitFor(forcedMarker)
    const forcedHandover = await runWorker(
      argsFor(forced, "force-handover", { task: "task-1", gen: 1, from: "act-1", to: "act-2", handover: "h-forced" }),
    )
    check(checks, "negative control: a fencing-only handover bypasses the pending check", payload(forcedHandover)["forced"] === true, payload(forcedHandover))
    const forcedFinished = await forcedWorker
    check(checks, "the old owner sends after the fencing-only handover", readJsonLines(forced.sendlog).length === 1)
    check(checks, "the old owner cannot record a result after the handover", (payload(forcedFinished)["outcome"] as Json | undefined)?.["code"] === "stale_owner", payload(forcedFinished))
    const forcedSnapshot = withLedger(forced.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "the late action remains open after the handover", forcedSnapshot.reservations[0]?.state === "sending", forcedSnapshot.reservations[0]?.state)
    const newOwner = withLedger(forced.db, (ledger) =>
      ledger.reserve({ reservationId: "res-new", taskId: "task-1", expectedGeneration: 2, ownerActivation: "act-2" }),
    )
    check(checks, "the new owner is blocked by the old open reservation", newOwner.ok === false && newOwner.code === "pending_attempt", newOwner)
    observations["forcedSnapshot"] = forcedSnapshot
  })
}
