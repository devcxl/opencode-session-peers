/**
 * #61 isolated runtime probe — plan asset, not run automatically.
 *
 * It reuses the existing harness isolation primitives but passes a minimal
 * whitelist base environment: no inherited OPENCODE_* values, no provider
 * credentials, no authSource, and no SESSION_PEERS_WATCH_STATE_DIR. A real
 * session is created in the scratch project so the project-scoped probe plugin
 * actually loads; no prompt is sent.
 *
 * Requires explicit confirmation:
 *   WATCH61_SMOKE_CONFIRM=1 bun scripts/research/watchdog-61/run-probe.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { createClient } from "../../harness/client.ts"
import { MISSING, readLiveService } from "../../harness/isolation.ts"
import { prepareScratch, startInstance, type InstanceHandle, type StopOutcome } from "../../harness/instance.ts"
import { defaultScratchRoot, scratchLayout, serviceJsonPath } from "../../harness/paths.ts"

if (process.env["WATCH61_SMOKE_CONFIRM"] !== "1") {
  console.error("refusing to start an opencode service without WATCH61_SMOKE_CONFIRM=1")
  process.exit(2)
}

const opencodeBin = process.env["WATCH61_OPENCODE_BIN"] ?? "/usr/bin/opencode"
const root = mkdtempSync(join(defaultScratchRoot(), "watchdog-61-smoke-"))
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

const password = `watch61-${crypto.randomUUID()}`
let instance: InstanceHandle | undefined
let stop: StopOutcome | undefined
let record: Record<string, unknown> | undefined
let loadError: string | undefined
let probeError: string | undefined

try {
  instance = await startInstance({
    layout,
    password,
    opencodeBin,
    bootTimeoutMs: 30_000,
    env: { ...base, WATCH61_PROBE_LOG: probeLog, WATCH61_PROBE_DB: probeDb },
  })
  // The plugin is project-scoped. Booting the server alone does not load a
  // project; this explicit scratch-project session does, without a prompt.
  await createClient(instance.url, instance.password).createSession({
    directory: layout.projectA,
    title: "watchdog-61 runtime probe",
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(probeLog, "utf8").trim().split("\n").filter((line) => line.length > 0)
      if (lines.length > 0) {
        record = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>
        break
      }
    } catch {
      // The plugin has not run yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (record === undefined) probeError = "the probe plugin did not record a runtime fact"
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error)
} finally {
  if (instance !== undefined) {
    try {
      stop = await instance.stop()
    } catch (error) {
      stop = {
        stopped: false,
        portClosed: false,
        observed: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

const after = readLiveService(liveService)
const recordDirectory = typeof record?.["directory"] === "string" ? record["directory"] : undefined
const recordDatabase = typeof record?.["databasePath"] === "string" ? record["databasePath"] : undefined
const recordPid = typeof record?.["pid"] === "number" ? record["pid"] : undefined
const recordRuntime =
  typeof record?.["sqliteVersion"] === "string" &&
  typeof record?.["journalMode"] === "string" &&
  typeof record?.["synchronous"] === "number" &&
  typeof record?.["busyTimeoutMs"] === "number" &&
  record["busyTimeoutMs"] > 0
const stoppedCleanly = stop?.stopped === true && stop.portClosed === true
const untouched = before.digest === after.digest
const ok =
  record !== undefined &&
  recordRuntime &&
  recordDirectory === layout.projectA &&
  recordDatabase === probeDb &&
  (instance === undefined || recordPid === instance.pid) &&
  stoppedCleanly &&
  untouched
const failure =
  loadError ??
  probeError ??
  (record === undefined
    ? "no runtime record"
    : !recordRuntime
      ? "the runtime record is incomplete"
      : recordDirectory !== layout.projectA
        ? "the plugin did not run for the scratch project"
        : recordDatabase !== probeDb
          ? "the plugin used an unexpected database path"
          : instance !== undefined && recordPid !== instance.pid
            ? "the plugin ran in an unexpected process"
            : !stoppedCleanly
              ? "the throwaway instance was not cleanly stopped"
              : !untouched
                ? "the live service registry changed"
                : undefined)

const report = {
  ok,
  failure: failure ?? null,
  record: record ?? null,
  liveServiceDigestBefore: before.digest,
  liveServiceDigestAfter: after.digest,
  liveServiceUntouched: untouched,
  serviceJsonState: before.digest === MISSING ? "missing" : "present",
  childPid: instance?.pid ?? null,
  stopped: stop?.stopped ?? null,
  portClosed: stop?.portClosed ?? null,
  stopObserved: stop?.observed ?? null,
  scratchRoot: layout.root,
  serverLog: layout.serverLog,
}
console.log(JSON.stringify(report, null, 2))
if (!ok) process.exitCode = 1
if (ok && stoppedCleanly && process.env["WATCH61_KEEP_SCRATCH"] !== "1") {
  rmSync(layout.root, { recursive: true, force: true })
}
