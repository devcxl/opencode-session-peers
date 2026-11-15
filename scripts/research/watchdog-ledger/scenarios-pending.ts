/**
 * Pending/unknown result experiments for issue #57.
 */

import { join } from "node:path"
import { argsFor, check, fresh, readJsonLines, register, runMany, runWorker, withLedger, type Scenario } from "./experiment.ts"
import { codeOf, payload, reserveArgs, reservedOf, reservedValue, scenario } from "./scenario-helpers.ts"

export async function pending(): Promise<Scenario> {
  return scenario("pending-and-unknown", async (checks, observations) => {
    const unknown = fresh("pending-unknown")
    register(unknown)
    withLedger(unknown.db, (ledger) =>
      ledger.reserve({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    withLedger(unknown.db, (ledger) =>
      ledger.markSending({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    const unknownOutcome = withLedger(unknown.db, (ledger) =>
      ledger.recordOutcome({
        reservationId: "res-1",
        taskId: "task-1",
        expectedGeneration: 1,
        ownerActivation: "act-1",
        outcome: "unknown",
      }),
    )
    const unknownRuns = await runMany(
      Array.from({ length: 8 }, (_, index) => ({ args: reserveArgs(unknown, `res-x-${index}`, { barrier: `${unknown.barrier}-x` }) })),
      `${unknown.barrier}-x`,
    )
    check(checks, "an unknown result blocks every new reservation", unknownRuns.every((run) => codeOf(run) === "pending_attempt"), unknownRuns.map(codeOf))
    const unknownSnapshot = withLedger(unknown.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "unknown result does not refund the attempt", unknownOutcome.ok === true && unknownSnapshot.task?.reserved_count === 1)
    check(checks, "the unknown reservation stays result_unknown", unknownSnapshot.reservations[0]?.state === "result_unknown")

    const accepted = fresh("pending-accepted")
    register(accepted)
    withLedger(accepted.db, (ledger) =>
      ledger.reserve({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    withLedger(accepted.db, (ledger) =>
      ledger.markSending({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    withLedger(accepted.db, (ledger) =>
      ledger.recordOutcome({
        reservationId: "res-1",
        taskId: "task-1",
        expectedGeneration: 1,
        ownerActivation: "act-1",
        outcome: "accepted",
      }),
    )
    const acceptedRuns = await runMany(
      Array.from({ length: 8 }, (_, index) => ({ args: reserveArgs(accepted, `res-a-${index}`, { barrier: `${accepted.barrier}-a` }) })),
      `${accepted.barrier}-a`,
    )
    check(checks, "host acceptance without consumption also blocks", acceptedRuns.every((run) => codeOf(run) === "pending_attempt"), acceptedRuns.map(codeOf))
    const acceptedSnapshot = withLedger(accepted.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "accepted is not terminal", acceptedSnapshot.reservations[0]?.state === "accepted")

    const crashed = fresh("crash-after-reserve")
    register(crashed)
    const crashMarker = join(crashed.root, "crash-marker.json")
    const crashRun = await runWorker(
      argsFor(crashed, "crash-after-reserve", { task: "task-1", gen: 1, activation: "act-1", reservation: "res-crash", marker: crashMarker }),
    )
    check(checks, "the crash worker died by SIGKILL", crashRun.code === 137 || crashRun.code === null, crashRun.code)
    const crashSnapshot = withLedger(crashed.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "a committed reservation survives SIGKILL", crashSnapshot.reservations[0]?.state === "reserved" && crashSnapshot.task?.reserved_count === 1)
    check(checks, "a crash before send makes no prompt call", readJsonLines(crashed.sendlog).length === 0)
    const crashRetry = await runWorker(reserveArgs(crashed, "res-crash-retry", { barrier: undefined }))
    check(checks, "a crash before send blocks an automatic retry", codeOf(crashRetry) === "pending_attempt", codeOf(crashRetry))

    const sentCrash = fresh("crash-after-send")
    register(sentCrash)
    const sentMarker = join(sentCrash.root, "sent-marker.json")
    const sentRun = await runWorker(
      argsFor(sentCrash, "crash-after-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-crash",
        sendlog: sentCrash.sendlog,
        marker: sentMarker,
      }),
    )
    check(checks, "the send-then-crash worker died", sentRun.code === 137 || sentRun.code === null, sentRun.code)
    check(checks, "the prompt was called once before the crash", readJsonLines(sentCrash.sendlog).length === 1)
    const sentSnapshot = withLedger(sentCrash.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "the crash leaves the reservation in sending", sentSnapshot.reservations[0]?.state === "sending")
    const sentRetry = await runWorker(reserveArgs(sentCrash, "res-crash-retry", { barrier: undefined }))
    check(checks, "a crash after send blocks an automatic retry", codeOf(sentRetry) === "pending_attempt", codeOf(sentRetry))
    check(checks, "no second prompt is sent after the crash", readJsonLines(sentCrash.sendlog).length === 1)

    const duplicates = fresh("duplicate-reservation")
    register(duplicates)
    const duplicateBarrier = `${duplicates.barrier}-dup`
    const duplicateRuns = await runMany(
      [0, 1].map(() => ({
        args: argsFor(duplicates, "reserve-send", {
          task: "task-1",
          gen: 1,
          activation: "act-1",
          reservation: "res-dup",
          sendlog: duplicates.sendlog,
          outcome: "consumed",
          barrier: duplicateBarrier,
        }),
      })),
      duplicateBarrier,
    )
    check(checks, "two workers using one reservation id send once", readJsonLines(duplicates.sendlog).length === 1, duplicateRuns.map((run) => payload(run)))
    check(checks, "only one of them got a fresh reservation", duplicateRuns.filter((run) => reservedValue(run)?.["fresh"] === true).length === 1, duplicateRuns.map((run) => reservedOf(run)))

    observations["unknownSnapshot"] = unknownSnapshot
    observations["acceptedSnapshot"] = acceptedSnapshot
    observations["crashSnapshot"] = crashSnapshot
    observations["sentSnapshot"] = sentSnapshot
  })
}
