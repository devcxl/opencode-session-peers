/**
 * A separate process that takes the ledger's write lock and holds it.
 *
 * The ledger's bounded `busy_timeout` can only be observed across real
 * connections, so the test spawns this fixture and waits for its marker file.
 * It never touches another process's state or the developer's database.
 */

import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"

const path = process.argv[2]
const marker = process.argv[3]
const holdMs = Number.parseInt(process.argv[4] ?? "500", 10)

if (path === undefined || marker === undefined) {
  console.error("usage: watch-hold-lock.ts <db-path> <marker-path> <hold-ms>")
  process.exit(2)
}

const db = new Database(path, { create: false, strict: true })
try {
  db.run("PRAGMA busy_timeout = 100")
  db.run("BEGIN IMMEDIATE")
  writeFileSync(marker, "held")
  Bun.sleepSync(Number.isFinite(holdMs) ? holdMs : 500)
  db.run("COMMIT")
} finally {
  db.close()
}
