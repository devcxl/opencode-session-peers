/**
 * Issue #56: what can a conservative watchdog actually observe on OpenCode
 * 2.2.7 in an isolated instance?
 *
 * Every experiment boots its own throwaway `opencode serve` with private XDG
 * directories, a private port, a private SQLite database, and the local
 * deterministic stub in `./stub-model.ts`. It never sends a request to the
 * developer's live service, reads no credential, and writes no global config.
 *
 * Run: `bun scripts/research/watchdog-observation/run.ts [--scenario all|main|permission|eviction|cross]`
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { prepareScratch, startInstance, sleep, type InstanceHandle } from "../../harness/instance.ts"
import { digestFile, readLiveService } from "../../harness/isolation.ts"
import {
  PROBE_LOG_ENV,
  scratchLayout,
  serviceJsonPath,
  type PluginEntry,
  type ScratchLayout,
} from "../../harness/paths.ts"
import { startResearchStub, type StubHandle } from "./stub-model.ts"

const PROBE_PLUGIN = join(import.meta.dir, "probe-plugin")
const STUB_MODEL = { providerID: "harness-stub", id: "stub" } as const
const ARTIFACT_ROOT = process.env["WATCHDOG_ARTIFACTS"] ?? join("/tmp", "opencode", "watchdog-observation-evidence")

type Json = Record<string, unknown>

interface SessionInfo {
  id: string
  title?: string
  outcome?: string
  location: { directory: string }
  time: { created: number; updated: number; busy?: number; idle?: number }
}

interface Client {
  listSessions(): Promise<SessionInfo[]>
  createSession(directory: string, title: string): Promise<SessionInfo>
  getSession(id: string): Promise<SessionInfo>
  prompt(id: string, text: string, delivery: "steer" | "queue"): Promise<void>
  context(id: string): Promise<unknown[]>
  rename(id: string, title: string): Promise<void>
  interrupt(id: string): Promise<void>
  permissions(id: string): Promise<Json[]>
  replyPermission(id: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>
  forms(id: string): Promise<Json[]>
  replyForm(id: string, formID: string, answer: Record<string, string>): Promise<void>
  activate(directory: string): Promise<void>
}

function makeClient(baseUrl: string, password: string): Client {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  async function request(method: string, path: string, body?: unknown, directory?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization, "content-type": "application/json" }
    if (directory !== undefined) headers["x-opencode-directory"] = directory
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
    return text.length === 0 ? null : JSON.parse(text)
  }
  const data = <T>(envelope: unknown): T => (envelope as { data: T }).data

  return {
    async listSessions() {
      return data<SessionInfo[]>(await request("GET", "/api/session"))
    },
    async createSession(directory, title) {
      return data<SessionInfo>(
        await request("POST", "/api/session", { location: { directory }, title, model: STUB_MODEL }, directory),
      )
    },
    async getSession(id) {
      return data<SessionInfo>(await request("GET", `/api/session/${id}`))
    },
    async prompt(id, text, delivery) {
      await request("POST", `/api/session/${id}/prompt`, { text, delivery })
    },
    async context(id) {
      return data<unknown[]>(await request("GET", `/api/session/${id}/context`))
    },
    async rename(id, title) {
      await request("PATCH", `/api/session/${id}`, { title })
    },
    async interrupt(id) {
      await request("POST", `/api/session/${id}/interrupt`, { resume: false })
    },
    async permissions(id) {
      return data<Json[]>(await request("GET", `/api/session/${id}/permission`))
    },
    async replyPermission(id, requestID, decision) {
      await request("POST", `/api/session/${id}/permission/${requestID}/reply`, { decision })
    },
    async forms(id) {
      return data<Json[]>(await request("GET", `/api/session/${id}/form`))
    },
    async replyForm(id, formID, answer) {
      await request("POST", `/api/session/${id}/form/${formID}/reply`, { answer })
    },
    async activate(directory) {
      await request("GET", "/api/model", undefined, directory)
    },
  }
}

interface RunContext {
  scratchRoot: string
  artifacts: string
  stub: StubHandle
  serviceJson: string
  liveBefore: { digest: string; pid?: number; url?: string }
}

interface InstancePair {
  instance: InstanceHandle
  client: Client
  layout: ScratchLayout
}

function configs(layout: ScratchLayout, directories: string[], extra: Json, pluginPath: string = PROBE_PLUGIN): void {
  const global = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    update: "disable",
    ...extra,
  }
  writeFileSync(join(layout.config, "opencode", "opencode.json"), `${JSON.stringify(global, null, 2)}\n`)
  for (const directory of directories) {
    mkdirSync(join(directory, ".opencode"), { recursive: true })
    writeFileSync(
      join(directory, ".opencode", "opencode.json"),
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json", share: "disabled", plugins: [pluginPath] }, null, 2)}\n`,
    )
  }
}

async function boot(
  context: RunContext,
  id: string,
  extraConfig: Json = {},
  options: { layoutOverride?: ScratchLayout; env?: NodeJS.ProcessEnv; pluginPath?: string } = {},
): Promise<InstancePair> {
  const layoutOverride = options.layoutOverride
  const layout = layoutOverride ?? scratchLayout(context.scratchRoot, id)
  const pluginPath = options.pluginPath ?? PROBE_PLUGIN
  const plugins: PluginEntry[] = [pluginPath]
  prepareScratch(layout, { plugins, stub: true })
  const projectC = join(layout.root, "project-c")
  mkdirSync(projectC, { recursive: true })
  configs(layout, [layout.projectA, layout.projectB, projectC], extraConfig, pluginPath)
  mkdirSync(context.artifacts, { recursive: true })
  const instance = await startInstance({
    layout,
    password: `watchdog-${Math.random().toString(36).slice(2)}`,
    opencodeBin: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode",
    bootTimeoutMs: 60_000,
    env: options.env ?? process.env,
    stubBaseUrl: `${context.stub.url}/v1`,
  })
  return { instance, client: makeClient(instance.url, instance.password), layout }
}

function readProbeLog(layout: ScratchLayout): Json[] {
  if (!existsSync(layout.probeLog)) return []
  return readFileSync(layout.probeLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Json
      } catch {
        return { kind: "unparsable", line }
      }
    })
}

function eventsFor(records: Json[], sessionID: string): Json[] {
  return records.filter(
    (record) =>
      record["kind"] === "event" &&
      typeof record["data"] === "object" &&
      record["data"] !== null &&
      (record["data"] as Json)["sessionID"] === sessionID,
  )
}

function eventTypes(records: Json[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    if (record["kind"] !== "event") continue
    const type = String(record["type"])
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

function snapshotsFor(records: Json[], sessionID: string): Json[] {
  return records.filter((record) => record["kind"] === "snapshot" && record["sessionID"] === sessionID)
}

async function settle(client: Client, sessionID: string, previousIdle: number | undefined, timeoutMs = 90_000): Promise<SessionInfo> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await client.getSession(sessionID)
    const idle = info.time.idle
    if (idle !== undefined && (previousIdle === undefined || idle > previousIdle) && (info.time.busy ?? 0) <= idle) {
      return info
    }
    if (Date.now() > deadline) throw new Error(`session ${sessionID} did not settle within ${timeoutMs} ms`)
    await sleep(100)
  }
}

async function waitBusy(client: Client, sessionID: string, timeoutMs = 30_000): Promise<SessionInfo> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await client.getSession(sessionID)
    if ((info.time.busy ?? 0) > (info.time.idle ?? 0)) return info
    if (Date.now() > deadline) throw new Error(`session ${sessionID} was never observed busy`)
    await sleep(50)
  }
}

interface TurnResult {
  before?: SessionInfo
  after: SessionInfo
  samples: Array<{ at: number; busy?: number; idle?: number; outcome?: string }>
  elapsedMs: number
}

async function drive(
  client: Client,
  sessionID: string,
  text: string,
  delivery: "steer" | "queue" = "queue",
  timeoutMs = 90_000,
): Promise<TurnResult> {
  const before = await client.getSession(sessionID)
  const startedAt = Date.now()
  await client.prompt(sessionID, text, delivery)
  const samples: TurnResult["samples"] = []
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await client.getSession(sessionID)
    samples.push({ at: Date.now(), busy: info.time.busy, idle: info.time.idle, outcome: info.outcome })
    if (
      info.time.idle !== undefined &&
      (before.time.idle === undefined || info.time.idle > before.time.idle) &&
      (info.time.busy ?? 0) <= info.time.idle
    ) {
      await sleep(1_000)
      return { before, after: await client.getSession(sessionID), samples, elapsedMs: Date.now() - startedAt }
    }
    if (Date.now() > deadline) throw new Error(`turn did not settle within ${timeoutMs} ms`)
    await sleep(100)
  }
}

function toolStates(messages: unknown[]): Json[] {
  const states: Json[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if ((part as { type?: string }).type !== "tool") continue
      const tool = part as { name?: string; state?: { status?: string; input?: unknown }; time?: unknown }
      states.push({ name: tool.name, status: tool.state?.status, input: tool.state?.input, time: tool.time })
    }
  }
  return states
}

async function experimentMain(context: RunContext): Promise<Json> {
  const pair = await boot(context, `main-${Date.now().toString(36)}`)
  const { instance, client, layout } = pair
  const result: Json = { scenario: "main", version: instance.url, steps: [] }
  try {
    await client.activate(layout.projectA)
    const session = await client.createSession(layout.projectA, "obs-main")
    const baseline = await client.getSession(session.id)

    const normal = await drive(client, session.id, "WATCHDOG_STUB_TEXT=NORMAL_OK")
    ;(result["steps"] as Json[]).push({ name: "normal-turn", normal })

    const beforeLong = await client.getSession(session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_SHELL_SLEEP=10", "queue")
    const busy = await waitBusy(client, session.id)
    const toolTrace: Json[] = []
    let renamed = false
    const longDeadline = Date.now() + 30_000
    for (;;) {
      const messages = await client.context(session.id)
      toolTrace.push({ at: Date.now(), tools: toolStates(messages) })
      if (!renamed && Date.now() - (busy.time.busy ?? Date.now()) > 2_000) {
        await client.rename(session.id, "obs-main-renamed-during-run")
        renamed = true
      }
      const info = await client.getSession(session.id)
      if (info.time.idle !== undefined && (beforeLong.time.idle === undefined || info.time.idle > beforeLong.time.idle) && (info.time.busy ?? 0) <= info.time.idle) break
      if (Date.now() > longDeadline) throw new Error("long shell turn did not settle")
      await sleep(500)
    }
    const afterLong = await client.getSession(session.id)
    const longMessages = await client.context(session.id)
    ;(result["steps"] as Json[]).push({
      name: "long-shell",
      busyAt: busy.time,
      idleAt: afterLong.time,
      outcome: afterLong.outcome,
      title: afterLong.title,
      toolStates: toolStates(longMessages),
      traceCount: toolTrace.length,
      renamedDuringRun: renamed,
    })

    // A queued prompt admitted while the session is running must not itself
    // refresh execution activity.
    const beforeQueue = await client.getSession(session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_SHELL_SLEEP=8", "queue")
    const queueBusy = await waitBusy(client, session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_TEXT=QUEUED_OK", "queue")
    await sleep(1_500)
    const duringQueue = await client.getSession(session.id)
    const queueSettled = await settle(client, session.id, beforeQueue.time.idle, 60_000)
    ;(result["steps"] as Json[]).push({
      name: "queue-admission-during-run",
      busyTime: queueBusy.time,
      afterAdmission: duringQueue.time,
      outcomeAfterAdmission: duringQueue.outcome,
      settled: queueSettled.time,
      settledOutcome: queueSettled.outcome,
    })

    const retry = await drive(
      client,
      session.id,
      "WATCHDOG_STUB_FAIL_FIRST=1:RETRY1 WATCHDOG_STUB_TEXT=RETRY_OK",
      "queue",
      120_000,
    )
    ;(result["steps"] as Json[]).push({ name: "retry-once", retry })

    const beforeInterrupt = await client.getSession(session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_SHELL_SLEEP=30", "queue")
    await waitBusy(client, session.id)
    await sleep(2_000)
    await client.interrupt(session.id)
    const interrupted = await settle(client, session.id, beforeInterrupt.time.idle, 60_000)
    ;(result["steps"] as Json[]).push({
      name: "interrupt-during-shell",
      interrupted: interrupted.time,
      outcome: interrupted.outcome,
    })

    await sleep(1_000)
    const records = readProbeLog(layout)
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-main.jsonl"))
    result["events"] = eventTypes(records)
    result["sessionEvents"] = eventsFor(records, session.id).map((record) => ({
      type: record["type"],
      t: record["t"],
      data: record["data"],
    }))
    result["snapshots"] = snapshotsFor(records, session.id)
    result["baseline"] = { time: baseline.time, outcome: baseline.outcome }
    result["final"] = { time: (await client.getSession(session.id)).time, outcome: (await client.getSession(session.id)).outcome }
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentPermission(context: RunContext): Promise<Json> {
  const pair = await boot(
    context,
    `permission-${Date.now().toString(36)}`,
    { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
    { env: { ...process.env, WATCHDOG_PROBE_SUBSCRIBE_DELAY_MS: "3000" } },
  )
  const { instance, client, layout } = pair
  const projectC = join(layout.root, "project-c")
  const result: Json = { scenario: "permission", steps: [] }
  try {
    await client.activate(layout.projectA)
    const session = await client.createSession(layout.projectA, "obs-permission")
    const before = await client.getSession(session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_SHELL_SLEEP=6", "queue")
    const busy = await waitBusy(client, session.id)

    let pending: Json[] = []
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      pending = await client.permissions(session.id)
      if (pending.length > 0) break
      await sleep(100)
    }

    // A late observer: a third location loads its own plugin instance only now,
    // so it has missed every earlier event.
    await client.activate(projectC)
    await sleep(1_500)
    const lateRecords = readProbeLog(layout)
    const lateSnapshots = lateRecords.filter(
      (record) => record["kind"] === "snapshot" && record["sessionID"] === session.id && record["directory"] === projectC,
    )
    const lateEvents = lateRecords.filter(
      (record) => record["kind"] === "event" && record["directory"] === projectC,
    )

    const request = pending[0]
    if (request === undefined) throw new Error("no pending permission was observed")
    await client.replyPermission(session.id, String(request["id"]), "once")
    const settled = await settle(client, session.id, before.time.idle, 60_000)
    const remaining = await client.permissions(session.id)
    const records = readProbeLog(layout)
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-permission.jsonl"))

    ;(result["steps"] as Json[]).push({
      name: "permission-ask",
      busyAt: busy.time,
      pendingCount: pending.length,
      pending: pending.map((entry) => ({
        id: entry["id"],
        action: entry["action"],
        resources: entry["resources"],
        message: entry["message"],
      })),
      lateObserverSnapshots: lateSnapshots.length,
      lateObserverSawPermission: lateSnapshots.some((record) => Array.isArray(record["permissions"]) && (record["permissions"] as unknown[]).length > 0),
      lateObserverPermissionError: lateSnapshots.map((record) => record["permissionError"]).filter((value) => value !== undefined),
      lateObserverEvents: lateEvents.map((record) => record["type"]),
      remainingPermissions: remaining.length,
      outcome: settled.outcome,
      settledTime: settled.time,
    })
    result["events"] = eventTypes(records)
    result["sessionEvents"] = eventsFor(records, session.id).map((record) => ({ type: record["type"], t: record["t"], data: record["data"] }))
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentEviction(context: RunContext): Promise<Json> {
  const pair = await boot(context, `eviction-${Date.now().toString(36)}`, {
    experimental: { location_idle_timeout: "5 seconds" },
  })
  const { instance, client, layout } = pair
  const result: Json = { scenario: "eviction", steps: [] }
  try {
    await client.activate(layout.projectA)
    const session = await client.createSession(layout.projectA, "obs-eviction")
    await drive(client, session.id, "WATCHDOG_STUB_TEXT=EVICT_OK", "queue", 60_000)
    const setupBefore = readProbeLog(layout).filter((record) => record["kind"] === "setup").length

    const startedAt = Date.now()
    let evicted = false
    const deadline = Date.now() + 100_000
    while (Date.now() < deadline) {
      const log = existsSync(layout.serverLog) ? readFileSync(layout.serverLog, "utf8") : ""
      const cleanup = readProbeLog(layout).filter((record) => record["kind"] === "cleanup").length
      if (log.includes("location services evicted") || cleanup > 0) {
        evicted = true
        break
      }
      await sleep(1_000)
    }
    const elapsedMs = Date.now() - startedAt

    await client.activate(layout.projectA)
    await sleep(2_000)
    const records = readProbeLog(layout)
    const setups = records.filter((record) => record["kind"] === "setup")
    const cleanups = records.filter((record) => record["kind"] === "cleanup")
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-eviction.jsonl"))
    ;(result["steps"] as Json[]).push({
      name: "location-eviction",
      evicted,
      elapsedMs,
      setupsBefore: setupBefore,
      setups: setups.length,
      cleanups: cleanups.length,
      cleanupRecords: cleanups,
      secondSetupPreviousHeartbeat: setups.at(-1)?.["previousHeartbeat"],
      replayedEventsAfterReactivation: records.filter(
        (record) => record["kind"] === "event" && Number(record["t"] ?? 0) > Date.now() - 2_000,
      ).length,
    })
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentFailure(context: RunContext): Promise<Json> {
  const { instance, client, layout } = await boot(context, `failure-${Date.now().toString(36)}`)
  const result: Json = { scenario: "failure", steps: [] }
  try {
    await client.activate(layout.projectA)
    const session = await client.createSession(layout.projectA, "obs-failure")
    const before = await client.getSession(session.id)
    const startedAt = Date.now()
    await client.prompt(session.id, "WATCHDOG_STUB_FAIL_FIRST=99:FAILEND WATCHDOG_STUB_TEXT=NEVER", "queue")
    const samples: Json[] = []
    let settled: SessionInfo | undefined
    let timedOut = false
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      const info = await client.getSession(session.id)
      samples.push({ at: Date.now(), time: info.time, outcome: info.outcome })
      if (info.time.idle !== undefined && (before.time.idle === undefined || info.time.idle > before.time.idle) && (info.time.busy ?? 0) <= info.time.idle) {
        settled = info
        break
      }
      await sleep(500)
    }
    if (settled === undefined) timedOut = true
    await sleep(1_000)
    const records = readProbeLog(layout)
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-failure.jsonl"))
    ;(result["steps"] as Json[]).push({
      name: "terminal-provider-failure",
      timedOut,
      elapsedMs: Date.now() - startedAt,
      outcome: settled?.outcome,
      time: settled?.time,
      retryScheduled: eventsFor(records, session.id).filter((record) => record["type"] === "session.retry.scheduled").length,
      executionFailed: eventsFor(records, session.id).filter((record) => record["type"] === "session.execution.failed").length,
      executionInterrupted: eventsFor(records, session.id).filter((record) => record["type"] === "session.execution.interrupted").length,
      lastSamples: samples.slice(-4),
    })
    result["events"] = eventTypes(records)
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentForm(context: RunContext): Promise<Json> {
  const pair = await boot(context, `form-${Date.now().toString(36)}`)
  const { instance, client, layout } = pair
  const projectC = join(layout.root, "project-c")
  const result: Json = { scenario: "form", steps: [] }
  try {
    await client.activate(layout.projectA)
    const session = await client.createSession(layout.projectA, "obs-form")
    const before = await client.getSession(session.id)
    await client.prompt(session.id, "WATCHDOG_STUB_QUESTION", "queue")
    const busy = await waitBusy(client, session.id)

    let forms: Json[] = []
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      forms = await client.forms(session.id)
      if (forms.length > 0) break
      await sleep(100)
    }

    await client.activate(projectC)
    await sleep(1_500)
    const lateRecords = readProbeLog(layout)
    const lateSetup = lateRecords.find(
      (record) => record["kind"] === "setup" && record["directory"] === projectC,
    )
    const formFromLateObserver = forms.length === 0 ? [] : await client.forms(session.id)

    const form = forms[0]
    if (form === undefined) throw new Error("no pending form was observed")
    await client.replyForm(session.id, String(form["id"]), { q0: "Yes" })
    const settled = await settle(client, session.id, before.time.idle, 60_000)
    const remaining = await client.forms(session.id)
    const records = readProbeLog(layout)
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-form.jsonl"))
    ;(result["steps"] as Json[]).push({
      name: "question-form",
      busyAt: busy.time,
      formCount: forms.length,
      form: {
        id: form["id"],
        title: form["title"],
        fields: form["fields"],
        metadata: form["metadata"],
      },
      lateObserverSetup: {
        sessionKeys: lateSetup?.["sessionKeys"],
        hasSessionForm: lateSetup?.["hasSessionForm"],
        permissionKeys: lateSetup?.["permissionKeys"],
      },
      formListAtHttp: formFromLateObserver.length,
      remainingForms: remaining.length,
      settledOutcome: settled.outcome,
      settledTime: settled.time,
      toolStates: toolStates(await client.context(session.id)),
    })
    result["events"] = eventTypes(records)
    result["sessionEvents"] = eventsFor(records, session.id).map((record) => ({
      type: record["type"],
      t: record["t"],
      pid: record["pid"],
      data: record["data"],
    }))
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentHotReload(context: RunContext): Promise<Json> {
  const id = `hot-${Date.now().toString(36)}`
  const layout = scratchLayout(context.scratchRoot, id)
  const copy = join(layout.root, "plugin-copy")
  mkdirSync(copy, { recursive: true })
  copyFileSync(join(PROBE_PLUGIN, "index.ts"), join(copy, "index.ts"))
  const { instance, client, layout: actual } = await boot(context, id, {}, {
    layoutOverride: layout,
    pluginPath: copy,
  })
  const result: Json = { scenario: "hot-reload", steps: [] }
  try {
    await client.activate(actual.projectA)
    const session = await client.createSession(actual.projectA, "obs-hot")
    await drive(client, session.id, "WATCHDOG_STUB_TEXT=HOT_OK", "queue", 60_000)
    const before = readProbeLog(actual)
    const setupsBefore = before.filter((record) => record["kind"] === "setup").length
    const cleanupsBefore = before.filter((record) => record["kind"] === "cleanup").length
    const startedAt = Date.now()
    writeFileSync(join(copy, "index.ts"), `${readFileSync(join(copy, "index.ts"), "utf8")}\n// research hot reload touch ${startedAt}\n`)
    let reloaded = false
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const records = readProbeLog(actual)
      const setups = records.filter((record) => record["kind"] === "setup").length
      const cleanups = records.filter((record) => record["kind"] === "cleanup").length
      if (setups > setupsBefore && cleanups > cleanupsBefore) {
        reloaded = true
        break
      }
      await sleep(250)
    }
    await sleep(1_000)
    const records = readProbeLog(actual)
    copyFileSync(actual.probeLog, join(context.artifacts, "probe-hot.jsonl"))
    ;(result["steps"] as Json[]).push({
      name: "plugin-source-hot-reload",
      reloaded,
      elapsedMs: Date.now() - startedAt,
      setupsBefore,
      cleanupsBefore,
      setupsAfter: records.filter((record) => record["kind"] === "setup").length,
      cleanupsAfter: records.filter((record) => record["kind"] === "cleanup").length,
      cleanupLivedMs: records.filter((record) => record["kind"] === "cleanup").map((record) => record["livedMs"]),
      secondSetupPreviousHeartbeat: records.filter((record) => record["kind"] === "setup").at(-1)?.["previousHeartbeat"],
      eventsAfterReload: records.filter((record) => record["kind"] === "event" && Number(record["t"] ?? 0) >= startedAt).map((record) => record["type"]),
    })
  } finally {
    await instance.stop()
  }
  return result
}

async function experimentCrossProcess(context: RunContext): Promise<Json> {
  const layout = scratchLayout(context.scratchRoot, `cross-${Date.now().toString(36)}`)
  prepareScratch(layout, { plugins: [PROBE_PLUGIN], stub: true })
  configs(layout, [layout.projectA], {})
  const layoutB: ScratchLayout = { ...layout, serverLog: join(layout.root, "server-b.log") }
  const instanceA = await startInstance({
    layout,
    password: `cross-a-${Math.random().toString(36).slice(2)}`,
    opencodeBin: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode",
    bootTimeoutMs: 60_000,
    env: process.env,
    stubBaseUrl: `${context.stub.url}/v1`,
  })
  const instanceB = await startInstance({
    layout: layoutB,
    password: `cross-b-${Math.random().toString(36).slice(2)}`,
    opencodeBin: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode",
    bootTimeoutMs: 60_000,
    env: process.env,
    stubBaseUrl: `${context.stub.url}/v1`,
  })
  const clientA = makeClient(instanceA.url, instanceA.password)
  const clientB = makeClient(instanceB.url, instanceB.password)
  const result: Json = { scenario: "cross-process", steps: [] }
  try {
    await clientA.activate(layout.projectA)
    const session = await clientA.createSession(layout.projectA, "obs-cross")
    const before = await clientA.getSession(session.id)
    await clientA.prompt(
      session.id,
      "WATCHDOG_STUB_SHELL_SLEEP=15 WATCHDOG_STUB_STEER=S1",
      "queue",
    )
    await waitBusy(clientA, session.id)
    await sleep(1_000)
    let bPromptError: string | undefined
    try {
      await clientB.prompt(
        session.id,
        "WATCHDOG_STEER_S1 steer from process B",
        "steer",
      )
    } catch (error) {
      bPromptError = String(error)
    }
    await sleep(3_000)
    const during = await clientA.getSession(session.id)
    const settled = await settle(clientA, session.id, before.time.idle, 90_000)
    await sleep(2_000)
    const messages = await clientA.context(session.id)
    const text = JSON.stringify(messages)
    const records = readProbeLog(layout)
    copyFileSync(layout.probeLog, join(context.artifacts, "probe-cross.jsonl"))
    ;(result["steps"] as Json[]).push({
      name: "cross-process-steer",
      bPromptError,
      duringTime: during.time,
      settledTime: settled.time,
      settledOutcome: settled.outcome,
      steerTokenInTranscript: text.includes("WATCHDOG_STEER_S1"),
      deliveredTextInTranscript: text.includes("WATCHDOG_STEER_DELIVERED_S1"),
      bSteerBodyInTranscript: text.includes("steer from process B"),
      shellToolRan: toolStates(messages).some((tool) => tool["name"] === "shell"),
      duringBusy: during.time,
      transcriptUserTexts: messages
        .filter((message) => (message as { type?: string }).type === "user")
        .map((message) => {
          const content = (message as { text?: string; content?: unknown }).text ?? JSON.stringify((message as { content?: unknown }).content)
          return typeof content === "string" ? content.slice(0, 220) : ""
        }),
      executionEventsByPid: records
        .filter((record) => record["kind"] === "event" && String(record["type"]).startsWith("session.execution."))
        .map((record) => ({ pid: record["pid"], type: record["type"], data: record["data"] })),
      toolStates: toolStates(messages),
    })
  } finally {
    await instanceA.stop()
    await instanceB.stop()
  }
  return result
}

async function main(): Promise<void> {
  const scenarioArg = process.argv.find((argument) => argument.startsWith("--scenario="))?.split("=")[1] ?? "all"
  const scenarios =
    scenarioArg === "all" ? ["main", "permission", "form", "failure", "eviction", "hot", "cross"] : [scenarioArg]
  const scratchRoot = join("/tmp", "opencode", `watchdog-observation-${Date.now().toString(36)}`)
  const artifacts = join(ARTIFACT_ROOT, new Date().toISOString().replaceAll(":", "-"))
  mkdirSync(scratchRoot, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  const serviceJson = serviceJsonPath()
  const liveBefore = readLiveService(serviceJson)
  const liveDigestBefore = digestFile(serviceJson)
  const stub = await startResearchStub()
  const context: RunContext = { scratchRoot, artifacts, stub, serviceJson, liveBefore }
  const report: Json = {
    startedAt: new Date().toISOString(),
    version: { host: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode", probeLogEnv: PROBE_LOG_ENV },
    isolation: {
      serviceJson,
      liveDigestBefore,
      livePid: liveBefore.pid,
      liveUrl: liveBefore.url,
      scratchRoot,
      artifacts,
      stubUrl: stub.url,
      authSource: "none (stub provider only)",
    },
    scenarios: [],
  }

  try {
    for (const scenario of scenarios) {
      const startedAt = Date.now()
      let outcome: Json
      try {
        if (scenario === "main") outcome = await experimentMain(context)
        else if (scenario === "permission") outcome = await experimentPermission(context)
        else if (scenario === "form") outcome = await experimentForm(context)
        else if (scenario === "failure") outcome = await experimentFailure(context)
        else if (scenario === "eviction") outcome = await experimentEviction(context)
        else if (scenario === "hot") outcome = await experimentHotReload(context)
        else if (scenario === "cross") outcome = await experimentCrossProcess(context)
        else throw new Error(`unknown scenario ${scenario}`)
      } catch (error) {
        outcome = { scenario, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) }
      }
      outcome["durationMs"] = Date.now() - startedAt
      ;(report["scenarios"] as Json[]).push(outcome)
    }
  } finally {
    await stub.stop()
    try {
      rmSync(scratchRoot, { recursive: true, force: true })
    } catch {
      // Evidence is already under the artifact directory; a leftover scratch
      // directory is reported by its absence from the run, not hidden.
    }
    const liveDigestAfter = digestFile(serviceJson)
    report["isolation"] = {
      ...(report["isolation"] as Json),
      liveDigestAfter,
      liveServiceUntouched: liveDigestAfter === liveDigestBefore,
      livePidAlive: liveBefore.pid === undefined ? "no pid recorded" : psAlive(liveBefore.pid),
    }
    report["finishedAt"] = new Date().toISOString()
    writeFileSync(join(artifacts, "summary.json"), `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
}

function psAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH"
  }
}

void main()
