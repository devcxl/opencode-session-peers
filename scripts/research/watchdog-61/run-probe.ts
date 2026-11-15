/**
 * #61 isolated runtime probe — plan asset, not run automatically.
 *
 * It reuses the existing harness isolation primitives but passes a minimal
 * whitelist base environment: no inherited OPENCODE_* values, no provider
 * credentials, no authSource, and no SESSION_PEERS_WATCH_STATE_DIR. The new
 * probe plugin reads the embedded SQLite facts inside the child service.
 *
 * Requires explicit confirmation:
 *   WATCH61_SMOKE_CONFIRM=1 bun scripts/research/watchdog-61/run-probe.ts
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { MISSING, readLiveService } from "../../harness/isolation.ts"
import { prepareScratch, startInstance } from "../../harness/instance.ts"
import { defaultScratchRoot, scratchLayout, serviceJsonPath } from "../../harness/paths.ts"

if (process.env["WATCH61_SMOKE_CONFIRM"] !== "1") {
  console.error("refusing to start an opencode service without WATCH61_SMOKE_CONFIRM=1")
  process.exit(2)
}

const opencodeBin = process.env["WATCH61_OPENCODE_BIN"] ?? "/usr/bin/opencode"
const root = join(defaultScratchRoot(), `watchdog-61-smoke-${Date.now()}-${process.pid}`)
const layout = scratchLayout(root, "runtime-probe")
const probeLog = join(layout.root, "runtime-probe.jsonl")
const probeDb = join(layout.root, "probe-ledger.sqlite3")
mkdirSync(layout.root, { recursive: true, mode: 0o700 })

const liveService = serviceJsonPath()
const before = readLiveService(liveService)

// Minimal whitelist: no OPENCODE_*, no provider/credential variables, no watch
// state override. `instanceEnvironment` adds the four scratch XDG paths and a
// throwaway server password; it inherits only what is listed here.
const base: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  HOME: join(layout.root, "home"),
  TMPDIR: join(layout.root, "tmp"),
  LANG: process.env["LANG"] ?? "C.UTF-8",
  LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8",
  TZ: process.env["TZ"] ?? "UTC",
}
mkdirSync(base["HOME"] as string, { recursive: true, mode: 0o700 })
mkdirSync(base["TMPDIR"] as string, { recursive: true, mode: 0o700 })

prepareScratch(layout, { plugins: [join(import.meta.dir, "probe-plugin")] })

process.env["WATCH61_PROBE_LOG"] = probeLog
process.env["WATCH61_PROBE_DB"] = probeDb

const instance = await startInstance({
  layout,
  password: `watch61-${crypto.randomUUID()}`,
  opencodeBin,
  bootTimeoutMs: 30_000,
  env: { ...base, WATCH61_PROBE_LOG: probeLog, WATCH61_PROBE_DB: probeDb },
})

let record: unknown = null
try {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(probeLog, "utf8").trim().split("\n").filter((line) => line.length > 0)
      if (lines.length > 0) {
        record = JSON.parse(lines[lines.length - 1] as string)
        break
      }
    } catch {
      // The plugin has not run yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
} finally {
  await instance.stop()
}

const after = readLiveService(liveService)
const report = {
  ok: record !== null,
  record,
  liveServiceDigestBefore: before.digest,
  liveServiceDigestAfter: after.digest,
  liveServiceUntouched: before.digest === after.digest,
  serviceJsonState: before.digest === MISSING ? "missing" : "present",
  scratchRoot: layout.root,
  serverLog: layout.serverLog,
}
console.log(JSON.stringify(report, null, 2))
if (record === null) process.exitCode = 1
if (process.env["WATCH61_KEEP_SCRATCH"] !== "1") {
  rmSync(layout.root, { recursive: true, force: true })
}
