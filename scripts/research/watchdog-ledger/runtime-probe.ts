/**
 * Issue #57 runtime fact: can an OpenCode server plugin import and use
 * `bun:sqlite`?
 *
 * Boots one throwaway `opencode serve` with private XDG/HOME directories, a
 * random loopback port and a project plugin. No model is called. The plugin
 * writes its report into the scratch root; the runner asserts the live
 * service registry and port were untouched, then stops the process.
 *
 * Run: bun scripts/research/watchdog-ledger/runtime-probe.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "../../harness/client.ts"
import { prepareScratch, startInstance, type InstanceHandle } from "../../harness/instance.ts"
import { readLiveService } from "../../harness/isolation.ts"
import { scratchLayout, serviceJsonPath, type ScratchLayout } from "../../harness/paths.ts"

const PROBE_PLUGIN = join(import.meta.dir, "probe-plugin")
const OPENCODE_BIN = process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode"
const ARTIFACT_ROOT = process.env["WATCHDOG_LEDGER_ARTIFACTS"] ?? join("/tmp", "opencode", "watchdog-ledger-evidence")
const WAIT_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await sleep(50)
  }
  return false
}

interface Result {
  ok: boolean
  report?: unknown
  error?: string
  isolation: Record<string, unknown>
  layout: ScratchLayout
}

async function main(): Promise<Result> {
  const root = join(ARTIFACT_ROOT, `runtime-${Date.now()}`)
  const layout = scratchLayout(root, "runtime")
  const probeOut = join(layout.root, "ledger-probe.json")
  const probeDir = join(layout.root, "ledger-probe-db")
  mkdirSync(layout.root, { recursive: true })
  prepareScratch(layout, { plugins: [PROBE_PLUGIN], stub: false })

  const livePath = serviceJsonPath()
  const liveBefore = readLiveService(livePath)
  const password = `watchdog-ledger-${Math.random().toString(36).slice(2)}`
  let instance: InstanceHandle | undefined
  let report: unknown
  let error: string | undefined

  try {
    instance = await startInstance({
      layout,
      password,
      opencodeBin: OPENCODE_BIN,
      bootTimeoutMs: 60_000,
      env: {
        ...process.env,
        WATCHDOG_LEDGER_PROBE_OUT: probeOut,
        WATCHDOG_LEDGER_PROBE_DIR: probeDir,
        HOME: layout.root,
      },
    })
    const client = createClient(instance.url, password)
    // Serving a location is what loads its project plugins; listing models is
    // the cheapest request that activates the location without a model turn.
    await client.models(layout.projectA)

    if (!(await waitFor(probeOut, WAIT_MS))) {
      error = `the probe plugin wrote no report within ${WAIT_MS} ms`
    } else {
      report = JSON.parse(readFileSync(probeOut, "utf8")) as unknown
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    const stopped = instance === undefined ? undefined : await instance.stop()
    const liveAfter = readLiveService(livePath)
    const isolation = {
      liveServiceDigestBefore: liveBefore.digest,
      liveServiceDigestAfter: liveAfter.digest,
      liveServiceUnchanged: liveBefore.digest === liveAfter.digest,
      liveServicePid: liveBefore.pid ?? null,
      liveServicePidAlive: liveBefore.pid === undefined ? null : isAlive(liveBefore.pid),
      instanceUrl: instance?.url ?? null,
      instanceStopped: stopped?.stopped ?? null,
      instancePortClosed: stopped?.portClosed ?? null,
      scratchRoot: layout.root,
      userDatabaseUntouched: !instance?.url.includes("49374"),
    }
    if (instance !== undefined) {
      writeFileSync(
        join(layout.root, "server-log-tail.txt"),
        instance.log().slice(-20_000),
        "utf8",
      )
    }
    return { ok: report !== undefined && error === undefined, ...(report === undefined ? {} : { report }), ...(error === undefined ? {} : { error }), isolation, layout }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const result = await main()
mkdirSync(join(result.layout.root, "evidence"), { recursive: true })
writeFileSync(join(result.layout.root, "evidence", "runtime.json"), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ ok: result.ok, error: result.error, isolation: result.isolation, report: result.report }, null, 2))
if (!result.ok) process.exitCode = 1
