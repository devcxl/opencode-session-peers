/**
 * Shared plumbing for the issue #57 ledger experiments.
 *
 * Every experiment gets a fresh scratch directory and a fresh plugin-owned
 * SQLite file. Workers are real Bun processes; the only synchronization is a
 * file barrier, so "concurrent" means concurrent at the OS process level.
 */

import { Database } from "bun:sqlite"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Ledger, type Outcome } from "./ledger.ts"

export const WORKER = join(import.meta.dir, "worker.ts")
export const BUN = process.execPath
export const ROOT =
  process.env["WATCHDOG_LEDGER_ARTIFACTS"] ?? join("/tmp", "opencode", "watchdog-ledger-evidence", `pure-${Date.now()}`)

export type Json = Record<string, unknown>

export interface WorkerRun {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  parsed: Json[]
}

export interface Scratch {
  name: string
  root: string
  db: string
  sendlog: string
  barrier: string
}

export interface Check {
  name: string
  ok: boolean
  detail?: unknown
}

export interface Scenario {
  name: string
  checks: Check[]
  observations: Json
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function fresh(name: string): Scratch {
  const root = join(ROOT, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const scratch = {
    name,
    root,
    db: join(root, "ledger.sqlite3"),
    sendlog: join(root, "sends.jsonl"),
    barrier: join(root, "barrier"),
  }
  writeFileSync(scratch.sendlog, "")
  return scratch
}

export async function runWorker(args: string[], timeoutMs = 20_000): Promise<WorkerRun> {
  const process_ = Bun.spawn([BUN, WORKER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process_.kill("SIGKILL")
  }, timeoutMs)
  const code = await process_.exited
  clearTimeout(timer)
  const stdout = await new Response(process_.stdout).text()
  const stderr = await new Response(process_.stderr).text()
  const parsed = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Json
      } catch {
        return { kind: "unparsable", line }
      }
    })
  return { code, timedOut, stdout, stderr, parsed }
}

export async function runMany(workers: Array<{ args: string[]; timeoutMs?: number }>, barrier: string): Promise<WorkerRun[]> {
  const promises = workers.map((worker) => runWorker(worker.args, worker.timeoutMs))
  // Give every child time to reach the barrier poll before releasing it.
  await sleep(120)
  writeFileSync(barrier, "go")
  return Promise.all(promises)
}

export function argsFor(scratch: Scratch, mode: string, extra: Record<string, string | number | undefined>): string[] {
  const values: Record<string, string> = { db: scratch.db, mode }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) values[key] = String(value)
  }
  return Object.entries(values).map(([key, value]) => `--${key}=${String(value)}`)
}

export function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (existsSync(path)) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${path}`))
      setTimeout(poll, 5)
    }
    poll()
  })
}

export function openLedger(path: string, busyTimeoutMs = 2000): Outcome<Ledger> {
  return Ledger.open(path, { busyTimeoutMs })
}

export function mustOpen(path: string, busyTimeoutMs = 2000): Ledger {
  const opened = Ledger.open(path, { busyTimeoutMs })
  if (!opened.ok) throw new Error(`could not open ledger: ${opened.code}: ${opened.detail ?? ""}`)
  return opened.value
}

export function withLedger<T>(path: string, fn: (ledger: Ledger) => T, busyTimeoutMs = 2000): T {
  const ledger = mustOpen(path, busyTimeoutMs)
  try {
    return fn(ledger)
  } finally {
    ledger.close()
  }
}

export function readJsonLines(path: string): Json[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Json)
}

export function raw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path, { strict: true })
  try {
    db.run("PRAGMA busy_timeout = 2000")
    return fn(db)
  } finally {
    db.close()
  }
}

export function register(scratch: Scratch, overrides: Record<string, string> = {}): Outcome<{ taskId: string; generation: number; created: boolean }> {
  return withLedger(scratch.db, (ledger) =>
    ledger.registerTask({
      requestId: overrides["request"] ?? "req-1",
      taskId: overrides["task"] ?? "task-1",
      sessionId: overrides["session"] ?? "ses-1",
      ownerActivation: overrides["activation"] ?? "act-1",
      authorizationRound: overrides["round"] ?? "round-1",
    }),
  ) as Outcome<{ taskId: string; generation: number; created: boolean }>
}

export function check(checks: Check[], name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
}

export function countBy(results: WorkerRun[], predicate: (record: Json) => boolean): number {
  return results.reduce((total, run) => total + run.parsed.filter(predicate).length, 0)
}

export function workerResult(run: WorkerRun): Json {
  return run.parsed.find((record) => record["result"] !== undefined) ?? run.parsed[0] ?? { missing: true }
}

export function appendJson(path: string, value: Json): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}
