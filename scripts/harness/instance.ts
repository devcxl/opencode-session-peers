/**
 * The throwaway opencode instance.
 *
 * It is a plain `opencode serve` process with its own XDG directories and its
 * own port, started from the harness's own environment. It is never asked to
 * manage or reach the developer's background service: a plain `serve` does not
 * register itself in `service.json`, and the harness verifies that file anyway.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, connect } from "node:net"
import { join } from "node:path"
import { ApiError, createClient } from "./client.ts"
import { isProcessAlive } from "./isolation.ts"
import {
  PROBE_LOG_ENV,
  globalConfigText,
  projectConfigText,
  type ScratchLayout,
} from "./paths.ts"

const HOSTNAME = "127.0.0.1"

export interface ScratchContents {
  /** Directories declared in both projects' `.opencode/opencode.json`. */
  pluginDirectories: readonly string[]
  /** Copied into the instance's data dir for the run; never committed, never printed. */
  authSource?: string
}

/** Lay out the scratch directories and write every config the instance reads. */
export function prepareScratch(layout: ScratchLayout, contents: ScratchContents): void {
  mkdirSync(join(layout.data, "opencode"), { recursive: true })
  mkdirSync(join(layout.state, "opencode"), { recursive: true })
  mkdirSync(join(layout.cache, "opencode"), { recursive: true })
  mkdirSync(join(layout.config, "opencode"), { recursive: true })
  mkdirSync(join(layout.projectA, ".opencode"), { recursive: true })
  mkdirSync(join(layout.projectB, ".opencode"), { recursive: true })

  writeFileSync(join(layout.config, "opencode", "opencode.json"), globalConfigText())
  const projectConfig = projectConfigText(contents.pluginDirectories)
  writeFileSync(join(layout.projectA, ".opencode", "opencode.json"), projectConfig)
  writeFileSync(join(layout.projectB, ".opencode", "opencode.json"), projectConfig)

  if (contents.authSource !== undefined) {
    copyFileSync(contents.authSource, layout.authFile)
  }
}

export function credentialsPath(layout: ScratchLayout): string {
  return layout.authFile
}

export interface StartOptions {
  layout: ScratchLayout
  password: string
  opencodeBin: string
  bootTimeoutMs: number
  env: NodeJS.ProcessEnv
  /** Called once the process exists, so a caller can clean up if boot fails. */
  onSpawn?: (pid: number) => void
}

export interface InstanceHandle {
  pid: number
  port: number
  url: string
  password: string
  layout: ScratchLayout
  /** True when the instance answered an authenticated request. */
  databaseCreated: boolean
  log(): string
  stop(): Promise<StopOutcome>
}

export interface StopOutcome {
  stopped: boolean
  portClosed: boolean
  observed: string
}

const BOOT_POLL_MS = 250
const STOP_GRACE_MS = 10_000

export async function startInstance(options: StartOptions): Promise<InstanceHandle> {
  const { layout, password, opencodeBin, bootTimeoutMs } = options
  const port = await pickFreePort()
  const url = `http://${HOSTNAME}:${port}`

  const logFd = openSync(layout.serverLog, "a")
  let child: ChildProcess
  try {
    child = spawn(
      opencodeBin,
      ["serve", "--hostname", HOSTNAME, "--port", String(port), "--print-logs", "--log-level", "info"],
      {
        cwd: layout.root,
        env: { ...options.env, [PROBE_LOG_ENV]: layout.probeLog },
        stdio: ["ignore", logFd, logFd],
        detached: true,
      },
    )
  } finally {
    closeSync(logFd)
  }

  const pid = child.pid
  if (pid === undefined) throw new Error("the opencode server process did not start")
  options.onSpawn?.(pid)

  const exits = exitOf(child)
  const handle: InstanceHandle = {
    pid,
    port,
    url,
    password,
    layout,
    databaseCreated: false,
    log: () => readLog(layout.serverLog),
    stop: () => stopProcess(pid, port),
  }

  await waitForBoot({ url, password, child, exits, bootTimeoutMs, log: handle.log })
  if (!existsSync(layout.database)) {
    throw new Error(`the instance answered but created no database at ${layout.database}`)
  }
  return { ...handle, databaseCreated: true }
}

interface BootWait {
  url: string
  password: string
  child: ChildProcess
  exits: Promise<number | null>
  bootTimeoutMs: number
  log: () => string
}

async function waitForBoot(wait: BootWait): Promise<void> {
  const client = createClient(wait.url, wait.password)
  const deadline = Date.now() + wait.bootTimeoutMs

  for (;;) {
    if (wait.child.exitCode !== null) {
      throw new Error(`the instance exited with code ${wait.child.exitCode} during boot\n${logTail(wait.log())}`)
    }
    try {
      await client.listSessions()
      return
    } catch (error) {
      if (error instanceof ApiError) {
        throw new Error(`the instance answered ${error.status} on /api/session during boot`)
      }
      if (Date.now() >= deadline) {
        throw new Error(`the instance did not answer ${wait.url} within ${wait.bootTimeoutMs} ms\n${logTail(wait.log())}`)
      }
      await sleep(BOOT_POLL_MS)
    }
  }
}

async function stopProcess(pid: number, port: number): Promise<StopOutcome> {
  const observations: string[] = []
  let stopped = !isAlive(pid)

  if (!stopped) {
    signalGroup(pid, "SIGTERM")
    stopped = await waitGone(pid, STOP_GRACE_MS)
    observations.push(stopped ? "stopped after SIGTERM" : `still alive after SIGTERM + ${STOP_GRACE_MS} ms`)
  }
  if (!stopped) {
    signalGroup(pid, "SIGKILL")
    stopped = await waitGone(pid, 2_000)
    observations.push(stopped ? "stopped after SIGKILL" : "survived SIGKILL")
  }

  const portClosed = !(await isPortOpen(port))
  if (!portClosed) observations.push(`port ${port} still accepts connections`)
  return { stopped, portClosed, observed: observations.join("; ") || "no process to stop" }
}

export function isAlive(pid: number): boolean {
  try {
    return isProcessAlive(pid)
  } catch {
    // An unexpected errno here must not make teardown believe the process died.
    return true
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid targets the group created for the server, so children go with it.
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone: the caller re-checks liveness.
    }
  }
}

async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(50)
  }
  return !isAlive(pid)
}

export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on("error", reject)
    probe.listen(0, HOSTNAME, () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("could not pick a free port"))))
    })
  })
}

export async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: HOSTNAME, port })
    const finish = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1_000)
    socket.on("connect", () => finish(true))
    socket.on("timeout", () => finish(false))
    socket.on("error", () => finish(false))
  })
}

export function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)))
}

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

export function logTail(log: string, lines = 15): string {
  const tail = log.trimEnd().split("\n").slice(-lines).join("\n")
  return tail.length === 0 ? "(no server output)" : tail
}

/** Lines matching `msg="loading plugin"`, one per plugin load per location. */
export function loadedPluginIds(log: string): string[] {
  const ids: string[] = []
  for (const line of log.split("\n")) {
    if (!line.includes('msg="loading plugin"')) continue
    const match = /(?:^|\s)id=(\S+)/.exec(line)
    if (match !== null) ids.push(match[1]!)
  }
  return [...new Set(ids)]
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
