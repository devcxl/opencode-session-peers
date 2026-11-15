/**
 * Identity, corruption and negative-control experiments for issue #57.
 */

import { chmodSync, closeSync, copyFileSync, openSync, rmSync, symlinkSync, writeSync } from "node:fs"
import { argsFor, check, fresh, openLedger, raw, readJsonLines, register, runMany, runWorker, withLedger, type Json, type Scenario } from "./experiment.ts"
import { payload, reservedOf, scenario } from "./scenario-helpers.ts"

export async function corruption(): Promise<Scenario> {
  return scenario("identity-and-corruption", async (checks, observations) => {
    const scratch = fresh("path-mismatch")
    register(scratch)
    raw(scratch.db, (db) => db.run("PRAGMA wal_checkpoint(TRUNCATE)"))
    const copy = `${scratch.root}/copy.sqlite3`
    copyFileSync(scratch.db, copy)
    const copied = openLedger(copy)
    check(checks, "a copied ledger is rejected by its canonical path", copied.ok === false && copied.code === "ledger_path_mismatch", copied)
    if (copied.ok) copied.value.close()

    const corrupt = fresh("corrupt")
    register(corrupt)
    raw(corrupt.db, (db) => db.run("PRAGMA wal_checkpoint(TRUNCATE)"))
    const fd = openSync(corrupt.db, "r+")
    writeSync(fd, Buffer.alloc(100, 0xff), 0, 100, 0)
    closeSync(fd)
    const corruptOpen = openLedger(corrupt.db)
    check(checks, "a corrupted database is rejected before any task is created", corruptOpen.ok === false && (corruptOpen.code === "corrupt" || corruptOpen.code === "io_error"), corruptOpen)
    if (corruptOpen.ok) corruptOpen.value.close()

    const schema = fresh("schema")
    register(schema)
    raw(schema.db, (db) => db.query("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run())
    const schemaOpen = openLedger(schema.db)
    check(checks, "an unknown schema version is rejected", schemaOpen.ok === false && schemaOpen.code === "unsupported_schema", schemaOpen)
    if (schemaOpen.ok) schemaOpen.value.close()

    const protocol = fresh("protocol")
    register(protocol)
    raw(protocol.db, (db) => db.query("UPDATE meta SET value = '999' WHERE key = 'protocol_version'").run())
    const protocolOpen = openLedger(protocol.db)
    check(checks, "an unknown protocol version is rejected", protocolOpen.ok === false && protocolOpen.code === "unsupported_schema", protocolOpen)
    if (protocolOpen.ok) protocolOpen.value.close()

    const recreated = fresh("recreated")
    register(recreated)
    const oldLedgerId = withLedger(recreated.db, (ledger) => ledger.ledgerId)
    rmSync(recreated.db, { force: true })
    rmSync(`${recreated.db}-wal`, { force: true })
    rmSync(`${recreated.db}-shm`, { force: true })
    const recreatedOpen = openLedger(recreated.db)
    check(checks, "deleting and recreating the file creates a new ledger", recreatedOpen.ok === true && recreatedOpen.value.ledgerId !== oldLedgerId, recreatedOpen.ok ? { oldLedgerId, newLedgerId: recreatedOpen.value.ledgerId } : recreatedOpen)
    if (recreatedOpen.ok) {
      const resurrect = recreatedOpen.value.reserve({ reservationId: "res-old", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" })
      check(checks, "the old task is unknown in the recreated ledger", resurrect.ok === false && resurrect.code === "unknown_task", resurrect)
      recreatedOpen.value.close()
    }

    const symlinked = fresh("symlink")
    register(symlinked)
    symlinkSync(symlinked.db, `${symlinked.root}/link.sqlite3`)
    const symlinkOpen = openLedger(`${symlinked.root}/link.sqlite3`)
    check(checks, "a symlinked ledger path is refused", symlinkOpen.ok === false && symlinkOpen.code === "unsafe_path", symlinkOpen)
    if (symlinkOpen.ok) symlinkOpen.value.close()

    const relative = openLedger("relative-ledger.sqlite3")
    check(checks, "a relative ledger path is refused", relative.ok === false && relative.code === "unsafe_path", relative)
    if (relative.ok) relative.value.close()

    const ledgerMismatch = fresh("ledger-mismatch")
    register(ledgerMismatch)
    raw(ledgerMismatch.db, (db) => db.query("UPDATE watch_tasks SET ledger_id = 'other' WHERE task_id = 'task-1'").run())
    const mismatchOpen = openLedger(ledgerMismatch.db)
    check(checks, "a task bound to another ledger id opens only to refuse work", mismatchOpen.ok === true, mismatchOpen.ok ? undefined : mismatchOpen.code)
    if (mismatchOpen.ok) {
      const refused = mismatchOpen.value.reserve({ reservationId: "res-1", taskId: "task-1", expectedGeneration: 1, ownerActivation: "act-1" })
      check(checks, "the foreign task's reservation is refused", refused.ok === false && refused.code === "ledger_mismatch", refused)
      mismatchOpen.value.close()
    }

    const readonly = fresh("readonly")
    register(readonly)
    raw(readonly.db, (db) => db.run("PRAGMA wal_checkpoint(TRUNCATE)"))
    chmodSync(readonly.db, 0o400)
    chmodSync(readonly.root, 0o500)
    const readonlyOpen = openLedger(readonly.db)
    check(checks, "a read-only ledger is refused", readonlyOpen.ok === false && (readonlyOpen.code === "readonly" || readonlyOpen.code === "io_error"), readonlyOpen)
    if (readonlyOpen.ok) readonlyOpen.value.close()
    chmodSync(readonly.root, 0o700)
    chmodSync(readonly.db, 0o600)

    const modes = fresh("modes")
    const opened = openLedger(modes.db)
    if (opened.ok) {
      const mode = opened.value.mode()
      check(checks, "database file mode is 0600", mode.db === 0o600, mode.db.toString(8))
      check(checks, "ledger directory mode is 0700", mode.directory === 0o700, mode.directory.toString(8))
      opened.value.close()
    } else {
      check(checks, "ledger opens for the permission check", false, opened)
    }
    observations["copyPath"] = copy
  })
}

export async function lww(): Promise<Scenario> {
  return scenario("lww-negative-control", async (checks, observations) => {
    const scratch = fresh("lww")
    const opened = openLedger(scratch.db)
    if (!opened.ok) throw new Error(`could not initialize lww ledger: ${opened.code}`)
    opened.value.close()
    const runs = await runMany(
      Array.from({ length: 10 }, () => ({ args: argsFor(scratch, "lww", { sendlog: scratch.sendlog, delay: 60, barrier: scratch.barrier }) })),
      scratch.barrier,
    )
    const final = raw(scratch.db, (db) => (db.query("SELECT count FROM lww_budget WHERE id = 1").get() as { count: number }).count)
    const sends = readJsonLines(scratch.sendlog).length
    check(checks, "ten lost-update workers all send", sends === 10, sends)
    check(checks, "the shared count collapses below the number of actions", final < sends, { final, sends })
    check(checks, "a read-modify-write counter cannot enforce a three-action cap", final <= 3 && sends > 3, { final, sends })
    observations["finalCount"] = final
    observations["sends"] = sends
    observations["workerRuns"] = runs.map((run) => run.parsed)
  })
}

export async function singleHostIdentity(): Promise<Scenario> {
  return scenario("single-host-identity", async (checks, observations) => {
    const scratch = fresh("single-host")
    register(scratch)
    const sends: number[] = []
    for (let index = 1; index <= 3; index += 1) {
      const run = await runWorker(
        argsFor(scratch, "reserve-send", {
          task: "task-1",
          gen: 1,
          activation: "act-1",
          reservation: `res-${index}`,
          sendlog: scratch.sendlog,
          outcome: "consumed",
          barrier: undefined,
        }),
      )
      sends.push(readJsonLines(scratch.sendlog).length)
      check(checks, `process ${index} with the same activation token is accepted`, reservedOf(run)["ok"] === true, payload(run))
    }
    const fourth = await runWorker(
      argsFor(scratch, "reserve-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-4",
        sendlog: scratch.sendlog,
        outcome: "consumed",
        barrier: undefined,
      }),
    )
    check(checks, "three separate processes can spend the same task's budget", sends[2] === 3, sends)
    check(checks, "the fourth process is stopped by the quota, not by process identity", reservedOf(fourth)["code"] === "quota_exhausted", reservedOf(fourth))
    observations["sendCounts"] = sends
    observations["note"] = "The ledger authenticates a bearer activation value, not a process or host."
  })
}

export async function reserveBeforeSend(): Promise<Scenario> {
  return scenario("reserve-before-send", async (checks, observations) => {
    const scratch = fresh("reserve-before-send")
    register(scratch)
    const run = await runWorker(
      argsFor(scratch, "reserve-send", {
        task: "task-1",
        gen: 1,
        activation: "act-1",
        reservation: "res-1",
        sendlog: scratch.sendlog,
        outcome: "consumed",
        barrier: undefined,
      }),
    )
    const sends = readJsonLines(scratch.sendlog)
    check(checks, "the send is recorded after the reservation", sends.length === 1 && sends[0]?.["afterReserve"] === true, sends)
    check(checks, "the send carries the committed reservation id", sends[0]?.["reservationId"] === "res-1", sends[0])
    check(checks, "the worker reports the successful transaction", reservedOf(run)["ok"] === true && (payload(run)["send"] as Json | undefined)?.["ok"] === true, payload(run))
    observations["send"] = sends[0]
  })
}
