/**
 * One independent process enrolling into a shared ledger.
 *
 * The test spawns several of these to prove the SQLite constraint, not a
 * JavaScript lock, decides the winner. It prints one JSON result and exits.
 */

import { openWatchLedger } from "../../src/watch/ledger.ts"

const [path, requestId, sessionId, owner] = process.argv.slice(2)
if (path === undefined || requestId === undefined || sessionId === undefined || owner === undefined) {
  console.error("usage: watch-enroll-worker.ts <ledger-path> <request-id> <session-id> <owner-activation>")
  process.exit(2)
}

const opened = openWatchLedger({ path, busyTimeoutMs: 2_000, openAttempts: 20 })
if (!opened.ok) {
  console.log(JSON.stringify({ ok: false, code: opened.code, detail: opened.detail }))
  process.exit(0)
}

try {
  const enrolled = opened.ledger.enroll({
    requestId,
    initiatorSessionId: sessionId,
    targetSessionId: sessionId,
    goal: "Concurrent enrollment",
    mode: "alert",
    ownerActivation: owner,
  })
  if (enrolled.ok) {
    console.log(
      JSON.stringify({
        ok: true,
        ledgerId: opened.ledger.ledgerId,
        taskID: enrolled.value.task.taskID,
        created: enrolled.value.created,
        version: enrolled.value.task.version,
      }),
    )
  } else {
    console.log(
      JSON.stringify({
        ok: false,
        ledgerId: opened.ledger.ledgerId,
        code: enrolled.code,
        detail: enrolled.detail,
      }),
    )
  }
} finally {
  opened.ledger.close()
}
