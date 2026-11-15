/**
 * One independent process reserving or claiming a correction attempt.
 *
 * The test spawns several to prove SQLite constraints and conditional writes,
 * not a JavaScript lock, decide the winner. With `killAfter` the worker kills
 * itself after the committed operation, before any later accounting.
 */

import { openWatchLedger } from "../../src/watch/ledger.ts"

const [mode, path, taskId, caller, owner, version, generation, reservationId, killAfter] = process.argv.slice(2)
if (
  (mode !== "reserve" && mode !== "claim") ||
  path === undefined ||
  taskId === undefined ||
  caller === undefined ||
  owner === undefined ||
  version === undefined ||
  generation === undefined ||
  reservationId === undefined
) {
  console.error("usage: watch-correction-worker.ts reserve|claim <path> <task> <caller> <owner> <version> <generation> <reservation> [reserve|claim]")
  process.exit(2)
}

const opened = openWatchLedger({ path, busyTimeoutMs: 2_000, openAttempts: 20 })
if (!opened.ok) {
  console.log(JSON.stringify({ ok: false, code: opened.code, detail: opened.detail }))
  process.exit(0)
}

try {
  const result =
    mode === "reserve"
      ? opened.ledger.reserveCorrection({
          taskId,
          callerSessionId: caller,
          ownerActivation: owner,
          expectedVersion: Number(version),
          generation: Number(generation),
          reservationId,
          at: Date.now(),
        })
      : opened.ledger.claimCorrection({
          taskId,
          reservationId,
          ownerActivation: owner,
          expectedVersion: Number(version),
          generation: Number(generation),
          at: Date.now(),
        })
  console.log(
    JSON.stringify(
      result.ok
        ? { ok: true, value: result.value }
        : { ok: false, code: result.code, detail: result.detail },
    ),
  )
  if (killAfter === mode) process.kill(process.pid, "SIGKILL")
} finally {
  opened.ledger.close()
}
