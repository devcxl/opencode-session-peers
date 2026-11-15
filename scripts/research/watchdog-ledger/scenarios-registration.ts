/**
 * Registration and budget experiments for issue #57.
 */

import {
  argsFor,
  check,
  fresh,
  openLedger,
  register,
  runMany,
  withLedger,
  type Json,
  type Scenario,
} from "./experiment.ts"
import { codeOf, reserveArgs, resultOf, scenario, valueOf } from "./scenario-helpers.ts"

export async function registration(): Promise<Scenario> {
  return scenario("registration", async (checks, observations) => {
    const distinct = fresh("registration-distinct")
    const init = openLedger(distinct.db)
    if (!init.ok) throw new Error(`could not initialize registration ledger: ${init.code}`)
    init.value.close()
    const workers = Array.from({ length: 8 }, (_, index) => ({
      args: argsFor(distinct, "register", {
        request: `req-${index}`,
        task: `task-${index}`,
        session: "ses-1",
        activation: `act-${index}`,
        round: "round-1",
        barrier: distinct.barrier,
      }),
    }))
    const runs = await runMany(workers, distinct.barrier)
    const successes = runs.filter((run) => resultOf(run)["ok"] === true && valueOf(run)?.["created"] === true)
    check(checks, "one distinct request creates one active task", successes.length === 1, { successes: successes.length })
    check(checks, "losers report session_conflict", runs.filter((run) => codeOf(run) === "session_conflict").length === 7, runs.map(codeOf))
    check(checks, "task rows for the session = 1", withLedger(distinct.db, (ledger) => ledger.countTasks("ses-1")) === 1)

    const same = fresh("registration-same-request")
    const sameInit = openLedger(same.db)
    if (!sameInit.ok) throw new Error(`could not initialize same-request ledger: ${sameInit.code}`)
    sameInit.value.close()
    const sameWorkers = Array.from({ length: 8 }, () => ({
      args: argsFor(same, "register", {
        request: "req-same",
        task: "task-same",
        session: "ses-same",
        activation: "act-same",
        barrier: same.barrier,
      }),
    }))
    const sameRuns = await runMany(sameWorkers, same.barrier)
    const created = sameRuns.filter((run) => valueOf(run)?.["created"] === true)
    const taskIds = new Set(sameRuns.map((run) => String(valueOf(run)?.["taskId"])))
    check(checks, "same request id creates once", created.length === 1, { created: created.length })
    check(checks, "same request id returns the same task to every caller", taskIds.size === 1 && taskIds.has("task-same"), [...taskIds])
    check(checks, "same request leaves one task row", withLedger(same.db, (ledger) => ledger.countTasks("ses-same")) === 1)

    const paused = fresh("registration-paused")
    register(paused)
    const pause = withLedger(paused.db, (ledger) =>
      ledger.setState({ taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1", state: "paused" }),
    )
    check(checks, "active task can be paused", pause.ok === true, pause)
    const blocked = register(paused, { request: "req-2", task: "task-2" })
    check(checks, "paused task still occupies the one-live-task slot", blocked.ok === false && blocked.code === "session_conflict", blocked)
    const seal = withLedger(paused.db, (ledger) =>
      ledger.setState({ taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1", state: "sealed" }),
    )
    const nextRound = register(paused, { request: "req-3", task: "task-3" })
    check(checks, "a sealed round frees the slot for an explicit new round", seal.ok === true && nextRound.ok === true, { seal, nextRound })
    observations["taskRowsAfterNewRound"] = withLedger(paused.db, (ledger) => ledger.countTasks("ses-1"))
  })
}

export async function quota(): Promise<Scenario> {
  return scenario("quota", async (checks, observations) => {
    const scratch = fresh("quota")
    register(scratch)
    const rounds: Json[] = []
    for (let round = 1; round <= 3; round += 1) {
      const barrier = `${scratch.barrier}-${round}`
      const workers = Array.from({ length: 8 }, (_, index) => ({
        args: reserveArgs(scratch, `res-${round}-${index}`, { barrier }),
      }))
      const runs = await runMany(workers, barrier)
      const winners = runs.filter((run) => resultOf(run)["ok"] === true && valueOf(run)?.["fresh"] === true)
      check(checks, `round ${round}: exactly one concurrent reservation wins`, winners.length === 1, runs.map(codeOf))
      const losers = runs.filter((run) => resultOf(run)["ok"] !== true)
      const expectedLoser = round < 3 ? "pending_attempt" : "quota_exhausted"
      check(
        checks,
        `round ${round}: every loser is ${expectedLoser}`,
        losers.length === 7 && losers.every((run) => codeOf(run) === expectedLoser),
        runs.map(codeOf),
      )
      const winner = winners[0]
      if (winner === undefined) {
        check(checks, `round ${round}: a winner exists`, false, runs.map((run) => run.stderr.slice(-500)))
        continue
      }
      const reservationId = String(valueOf(winner)?.["reservationId"])
      const resolved = withLedger(scratch.db, (ledger) => {
        const sending = ledger.markSending({ reservationId, taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" })
        const outcome = ledger.recordOutcome({
          reservationId,
          taskId: "task-1",
          expectedGeneration: 1,
          ownerActivation: "act-1",
          outcome: "consumed",
        })
        return { sending, outcome }
      })
      check(checks, `round ${round}: the winner can be resolved`, resolved.sending.ok === true && resolved.outcome.ok === true, resolved)
      rounds.push({ round, reservationId, attemptNo: valueOf(winner)?.["attemptNo"] })
    }

    const snapshot = withLedger(scratch.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "reserved_count is 3 after three rounds", snapshot.task?.reserved_count === 3, snapshot.task?.reserved_count)
    check(checks, "exactly three reservation rows exist", snapshot.reservations.length === 3, snapshot.reservations.length)
    check(checks, "all three are terminal and counted", snapshot.reservations.every((row) => row.state === "result_recorded"))

    const finalRuns = await runMany(
      Array.from({ length: 8 }, (_, index) => ({ args: reserveArgs(scratch, `res-final-${index}`, { barrier: `${scratch.barrier}-final` }) })),
      `${scratch.barrier}-final`,
    )
    check(checks, "a fourth reservation is refused for every contender", finalRuns.every((run) => codeOf(run) === "quota_exhausted"), finalRuns.map(codeOf))
    const reopened = openLedger(scratch.db)
    check(checks, "the ledger can be reopened after the quota is spent", reopened.ok === true, reopened.ok ? undefined : reopened.code)
    if (reopened.ok) {
      const after = reopened.value.snapshot("task-1")
      check(checks, "reopening does not refund quota", after.task?.reserved_count === 3 && after.reservations.length === 3)
      reopened.value.close()
    }
    observations["rounds"] = rounds
    observations["finalSnapshot"] = snapshot
  })
}

export async function noRefund(): Promise<Scenario> {
  return scenario("no-refund", async (checks, observations) => {
    const scratch = fresh("no-refund")
    register(scratch)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const reserved = withLedger(scratch.db, (ledger) =>
        ledger.reserve({ reservationId: `res-${attempt}`, taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
      )
      const sending = withLedger(scratch.db, (ledger) =>
        ledger.markSending({ reservationId: `res-${attempt}`, taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
      )
      const outcome = withLedger(scratch.db, (ledger) =>
        ledger.recordOutcome({
          reservationId: `res-${attempt}`,
          taskId: "task-1",
          expectedGeneration: 1,
          ownerActivation: "act-1",
          outcome: "not_accepted",
        }),
      )
      check(checks, `attempt ${attempt} reserves and aborts`, reserved.ok && sending.ok && outcome.ok, { reserved, sending, outcome })
    }
    const refused = withLedger(scratch.db, (ledger) =>
      ledger.reserve({ reservationId: "res-4", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" }),
    )
    check(checks, "an aborted attempt still consumes budget", refused.ok === false && refused.code === "quota_exhausted", refused)
    const snapshot = withLedger(scratch.db, (ledger) => ledger.snapshot("task-1"))
    check(checks, "three aborted rows remain", snapshot.reservations.length === 3 && snapshot.reservations.every((row) => row.state === "aborted"))
    observations["snapshot"] = snapshot
  })
}
