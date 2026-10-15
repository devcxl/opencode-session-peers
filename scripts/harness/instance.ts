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
  STUB_API_KEY,
  STUB_KEY_ENV,
  STUB_PLUGIN_SOURCE,
  STUB_URL_ENV,
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
  /** Install the stub provider plugin, so the instance can offer the stub model. */
  stub?: boolean
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

  if (contents.stub === true) {
    mkdirSync(join(layout.config, "opencode", "plugins"), { recursive: true })
    copyFileSync(STUB_PLUGIN_SOURCE, layout.stubProvider)
  }
  if (contents.authSource !== undefined) {
    copyFileSync(contents.authSource, layout.authFile)
  }
}

/**
 * The environment the instance runs in.
 *
 * The harness is itself a child of the developer's live opencode service, so
 * its own environment carries that service's identity — a password, a session
 * id, and on some setups a database or config override. The instance must be
 * throwaway, so every `OPENCODE_*` variable is dropped and the four XDG
 * directories and the password are set to values that exist only in scratch.
 *
 * `stubBaseUrl` is present only in the offline pass. The key it is paired with
 * is the literal `stub`: the stub server never checks it, and no developer
 * credential is read, copied or printed anywhere on that path.
 */
export function instanceEnvironment(
  layout: ScratchLayout,
  password: string,
  base: NodeJS.ProcessEnv,
  stubBaseUrl?: string,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("OPENCODE")) continue
    inherited[key] = value
  }
  return {
    ...inherited,
    XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state,
    XDG_CACHE_HOME: layout.cache,
    XDG_CONFIG_HOME: layout.config,
    OPENCODE_SERVER_PASSWORD: password,
    [PROBE_LOG_ENV]: layout.probeLog,
    ...(stubBaseUrl === undefined ? {} : { [STUB_URL_ENV]: stubBaseUrl, [STUB_KEY_ENV]: STUB_API_KEY }),
  }
}

export interface StartOptions {
  layout: ScratchLayout
  password: string
  opencodeBin: string
  bootTimeoutMs: number
  env: NodeJS.ProcessEnv
  /** Base URL of the harness's stub model; set only by the offline pass. */
  stubBaseUrl?: string
}

export interface InstanceHandle {
  pid: number
  port: number
  url: string
  password: string
  layout: ScratchLayout
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
        env: instanceEnvironment(layout, password, options.env, options.stubBaseUrl),
        stdio: ["ignore", logFd, logFd],
        detached: true,
      },
    )
  } finally {
    closeSync(logFd)
  }

  const pid = child.pid
  if (pid === undefined) throw new Error("the opencode server process did not start")

  const handle: InstanceHandle = {
    pid,
    port,
    url,
    password,
    layout,
    log: () => readLog(layout.serverLog),
    stop: () => stopProcess(pid, port),
  }

  try {
    await waitForBoot({ url, password, child, bootTimeoutMs, log: handle.log })
    if (!existsSync(layout.database)) {
      throw new Error(`the instance answered but created no database at ${layout.database}`)
    }
  } catch (error) {
    // A process that failed halfway through boot is still a process this
    // harness started, so it is stopped before the failure is reported.
    const stopped = await stopProcess(pid, port)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}; the instance process was stopped (${stopped.observed})`, { cause: error })
  }
  return handle
}

interface BootWait {
  url: string
  password: string
  child: ChildProcess
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
