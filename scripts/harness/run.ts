/**
 * The run: boot a throwaway instance, install the plugin, create two sessions
 * in two directories, drive them, read them back, check the expectations, and
 * tear everything down.
 *
 * Every check is an `Expectation` with the promise in words and the observation
 * in words. A run is green only when all of them are met and the teardown
 * really happened.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { modelLabel, scratchId, type HarnessOptions } from "./args.ts"
import { createClient, type HarnessClient, type SessionInfo, type SessionMessage } from "./client.ts"
import { isProcessAlive, readLiveService } from "./isolation.ts"
import { loadedPluginIds, prepareScratch, sleep, startInstance, type InstanceHandle } from "./instance.ts"
import {
  PROBE_PLUGIN_DIR,
  authJsonPath,
  pluginEntrypoint,
  scratchLayout,
  serviceJsonPath,
  type ScratchLayout,
} from "./paths.ts"
import type {
  CleanupSummary,
  Expectation,
  HarnessReport,
  InstanceSummary,
  MessageSummary,
  PluginSummary,
  SessionSummary,
} from "./report.ts"

const TOKENS: Record<SessionSummary["label"], string> = {
  A: "HARNESS_SESSION_A_OK",
  B: "HARNESS_SESSION_B_OK",
}
const TURN_POLL_MS = 1_000

export async function runHarness(options: HarnessOptions): Promise<HarnessReport> {
  const startedAt = Date.now()
  const expectations: Expectation[] = []
  const disclosures: string[] = []
  const layout = scratchLayout(options.scratchRoot, scratchId(startedAt, randomSuffix()))
  const serviceJson = serviceJsonPath()
  const liveBefore = readLiveService(serviceJson)

  let instance: InstanceHandle | undefined
  let sessions: SessionSummary[] = []
  let instanceSummary: InstanceSummary | undefined
  let usedModels: string[] = []
  let cleanup: CleanupSummary = {
    processStopped: false,
    portClosed: false,
    scratchRemoved: false,
    scratchKept: false,
    authFileRemoved: false,
    observed: "teardown did not run",
  }
  const plugin: PluginSummary = {
    path: options.pluginPath,
    installedIn: [],
    loaded: false,
    locations: [],
  }

  try {
    const entrypoint = checkPluginPath(options, plugin, expectations)
    plugin.entrypoint = entrypoint
    const authSource = checkAuth(options, expectations)
    if (authSource !== undefined) {
      disclosures.push(
        `copied ${authSource} into the throwaway data directory for this run; it is deleted at teardown and its contents are never read or printed`,
      )
    }
    disclosures.push(`read ${serviceJson} to hash it; it is never written`)
    disclosures.push(`read the plugin under test at ${options.pluginPath}`)

    plugin.installedIn = [
      relative(layout.root, join(layout.projectA, ".opencode", "opencode.json")),
      relative(layout.root, join(layout.projectB, ".opencode", "opencode.json")),
    ]
    prepareScratch(layout, {
      pluginDirectories: [options.pluginPath, PROBE_PLUGIN_DIR],
      ...(authSource === undefined ? {} : { authSource }),
    })

    instance = await boot(options, layout, expectations)
    instanceSummary = {
      url: instance.url,
      port: instance.port,
      pid: instance.pid,
      database: instance.layout.database,
      dataDir: instance.layout.data,
      stateDir: instance.layout.state,
      cacheDir: instance.layout.cache,
      configDir: instance.layout.config,
    }
    disclosures.push(
      `started one opencode server process (pid ${instance.pid}) on 127.0.0.1:${instance.port}; it is stopped at teardown`,
    )
    disclosures.push(
      "the instance fetched its model catalogue over the network; driven turns also called the model provider",
    )
    checkIsolation(instance, liveBefore.url, layout, expectations)

    const client = createClient(instance.url, instance.password)
    await activateLocations(client, layout, expectations)
    const created = await createSessions(client, layout, options, expectations)
    sessions = created.map((info, index) => sessionSummary(index === 0 ? "A" : "B", info))

    if (options.driveModel) await driveTurns(client, options, sessions, expectations)
    sessions = (await readTranscripts(client, sessions, options, expectations)).sessions
    if (options.driveModel) checkAnswers(sessions, expectations)
    usedModels = [...new Set(sessions.map((session) => session.model).filter((model): model is string => model !== undefined))]

    checkPluginLoading(instance, options, plugin, layout, expectations, disclosures)
  } catch (error) {
    expectations.push({
      name: "harness-completes",
      met: false,
      expected: "every harness step runs",
      observed: explain(error),
    })
  } finally {
    cleanup = await teardown(options, layout, instance, serviceJson)
    expectations.push({
      name: "teardown",
      met:
        cleanup.processStopped &&
        cleanup.portClosed &&
        cleanup.authFileRemoved &&
        (cleanup.scratchRemoved || cleanup.scratchKept),
      expected: "the instance stops, its port closes, auth.json is deleted and the scratch directory is removed",
      observed: cleanup.observed,
    })
    if (!cleanup.scratchRemoved && !cleanup.scratchKept) {
      disclosures.push(`could not remove the scratch directory ${layout.root}`)
    }
    if (cleanup.scratchKept) disclosures.push(`scratch directory kept on request: ${layout.root}`)
    if (!cleanup.processStopped) disclosures.push(`could not stop the instance process (pid ${instance?.pid ?? "?"})`)
  }

  const liveAfter = readLiveService(serviceJson)
  const liveAlive =
    liveBefore.pid === undefined
      ? "no live service pid recorded"
      : `recorded live service pid ${liveBefore.pid} is alive: ${isProcessAlive(liveBefore.pid)}`
  expectations.push({
    name: "live-service-untouched",
    met: liveAfter.digest === liveBefore.digest,
    expected: `${serviceJson} is byte-identical before and after the run`,
    observed: `md5 before ${liveBefore.digest}, after ${liveAfter.digest}; ${liveAlive}`,
  })

  const finishedAt = Date.now()
  return {
    ok: expectations.every((expectation) => expectation.met),
    mode: options.driveModel ? "drive" : "structural",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    expectations,
    sessions,
    ...(instanceSummary === undefined ? {} : { instance: instanceSummary }),
    plugin,
    model: {
      ...(options.model === undefined ? {} : { requested: modelLabel(options.model) }),
      used: usedModels,
    },
    disclosures,
    cleanup,
  }
}

function checkPluginPath(options: HarnessOptions, plugin: PluginSummary, expectations: Expectation[]): string | undefined {
  const expected = "the plugin under test is an existing directory"
  if (!existsSync(options.pluginPath) || !statSync(options.pluginPath).isDirectory()) {
    expectations.push({ name: "plugin-path", met: false, expected, observed: `${options.pluginPath} is not a directory` })
    throw new Error(`the plugin under test ${options.pluginPath} is not a directory`)
  }
  const entrypoint = pluginEntrypoint(options.pluginPath)
  expectations.push({
    name: "plugin-path",
    met: true,
    expected,
    observed:
      entrypoint === undefined
        ? `${options.pluginPath} (no entrypoint yet, so nothing is asserted about loading it)`
        : `${options.pluginPath} (entrypoint ${entrypoint})`,
  })
  plugin.path = options.pluginPath
  return entrypoint
}

function checkAuth(options: HarnessOptions, expectations: Expectation[]): string | undefined {
  if (!options.driveModel) return undefined
  const source = authJsonPath()
  const expected = "the developer's auth.json is available for driven turns"
  if (!existsSync(source)) {
    expectations.push({
      name: "auth-available",
      met: false,
      expected,
      observed: `${source} does not exist; run with --no-model for structural checks`,
    })
    throw new Error(`${source} does not exist (run with --no-model for structural checks)`)
  }
  expectations.push({
    name: "auth-available",
    met: true,
    expected,
    observed: `${source} (copied into the instance data directory; not printed)`,
  })
  return source
}

async function boot(options: HarnessOptions, layout: ScratchLayout, expectations: Expectation[]): Promise<InstanceHandle> {
  const expected = "a throwaway opencode instance answers on its own port and credentials"
  const startedAt = Date.now()
  try {
    const instance = await startInstance({
      layout,
      password: `harness-${randomSuffix()}${randomSuffix()}`,
      opencodeBin: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode",
      bootTimeoutMs: options.bootTimeoutMs,
      env: process.env,
    })
    expectations.push({
      name: "instance-boots",
      met: true,
      expected,
      observed: `${instance.url} answered in ${Date.now() - startedAt} ms (pid ${instance.pid})`,
    })
    return instance
  } catch (error) {
    expectations.push({ name: "instance-boots", met: false, expected, observed: explain(error) })
    throw error
  }
}

function checkIsolation(
  instance: InstanceHandle,
  liveUrl: string | undefined,
  layout: ScratchLayout,
  expectations: Expectation[],
): void {
  const expected = "the instance uses only its own scratch directories, database and port"
  const insideScratch = instance.layout.database.startsWith(`${layout.root}/`)
  const livePort = liveUrl === undefined ? undefined : Number(/:(\d+)$/.exec(liveUrl)?.[1])
  const portDiffers = livePort === undefined || livePort !== instance.port
  const met = insideScratch && portDiffers
  const observed = [
    `port ${instance.port}${liveUrl === undefined ? "" : ` (live service ${liveUrl})`}`,
    `database ${instance.layout.database}`,
    `data/state/cache/config under ${layout.root}`,
  ].join(", ")
  expectations.push({
    name: "instance-isolated",
    met,
    expected,
    observed: met ? observed : `${observed}; database inside scratch: ${insideScratch}, port differs from live: ${portDiffers}`,
  })
}

/** A location-scoped request is what activates a location and loads its plugins. */
async function activateLocations(client: HarnessClient, layout: ScratchLayout, expectations: Expectation[]): Promise<void> {
  const expected = "serving each project activates its location and loads its project plugins"
  const locations = [
    { label: "A", directory: layout.projectA },
    { label: "B", directory: layout.projectB },
  ]
  try {
    const observed: string[] = []
    for (const location of locations) {
      const models = await client.models(location.directory)
      observed.push(`${location.label}: ${location.directory} (${models.length} models offered)`)
    }
    expectations.push({ name: "locations-activate", met: true, expected, observed: observed.join(", ") })
  } catch (error) {
    expectations.push({ name: "locations-activate", met: false, expected, observed: explain(error) })
    throw error
  }
}

async function createSessions(
  client: HarnessClient,
  layout: ScratchLayout,
  options: HarnessOptions,
  expectations: Expectation[],
): Promise<SessionInfo[]> {
  const expected = "two sessions exist in two different directories"
  try {
    const created = await Promise.all([
      client.createSession({ directory: layout.projectA, title: "harness-a", ...(options.model === undefined ? {} : { model: options.model }) }),
      client.createSession({ directory: layout.projectB, title: "harness-b", ...(options.model === undefined ? {} : { model: options.model }) }),
    ])
    const fetched = await Promise.all([client.getSession(created[0]!.id), client.getSession(created[1]!.id)])
    const met =
      fetched[0]!.location.directory === layout.projectA &&
      fetched[1]!.location.directory === layout.projectB &&
      fetched[0]!.id !== fetched[1]!.id
    expectations.push({
      name: "sessions-created",
      met,
      expected,
      observed: `A ${fetched[0]!.id} in ${fetched[0]!.location.directory}, B ${fetched[1]!.id} in ${fetched[1]!.location.directory}`,
    })
    if (!met) throw new Error("the created sessions did not land in the two project directories")
    return fetched
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "sessions-created")) {
      expectations.push({ name: "sessions-created", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

async function driveTurns(
  client: HarnessClient,
  options: HarnessOptions,
  sessions: readonly SessionSummary[],
  expectations: Expectation[],
): Promise<void> {
  const expected = "a driven turn reaches a terminal outcome in each session"
  try {
    if (options.model !== undefined) await requireModel(client, options, sessions[0]!.directory, expectations)
    const outcomes = await Promise.all(
      sessions.map(async (session) => {
        const startedAt = Date.now()
        await client.prompt(
          session.id,
          `Reply with exactly the token ${TOKENS[session.label]} and nothing else. Do not use any tools.`,
        )
        for (;;) {
          const info = await client.getSession(session.id)
          if (info.outcome !== undefined) {
            return `${session.label}: ${info.outcome} in ${Date.now() - startedAt} ms`
          }
          if (Date.now() - startedAt > options.turnTimeoutMs) {
            throw new Error(
              `${session.label} reached no outcome within ${options.turnTimeoutMs} ms (last state: ${describeSession(info)})`,
            )
          }
          await sleep(TURN_POLL_MS)
        }
      }),
    )
    const met = outcomes.every((outcome) => outcome.includes(": succeeded "))
    expectations.push({ name: "turns-complete", met, expected, observed: outcomes.join("; ") })
    if (!met) throw new Error("at least one driven turn did not succeed")
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "turns-complete")) {
      expectations.push({ name: "turns-complete", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

async function requireModel(
  client: HarnessClient,
  options: HarnessOptions,
  directory: string,
  expectations: Expectation[],
): Promise<void> {
  const requested = options.model!
  const expected = `the requested model ${modelLabel(requested)} is offered by the instance`
  const models = await client.models(directory)
  const found = models.some((model) => model.providerID === requested.providerID && model.id === requested.id)
  expectations.push({
    name: "model-available",
    met: found,
    expected,
    observed: found
      ? `${modelLabel(requested)} is offered`
      : `${modelLabel(requested)} is not offered; offered: ${models.slice(0, 8).map(modelLabel).join(", ")}`,
  })
  if (!found) throw new Error(`the requested model ${modelLabel(requested)} is not offered by the instance`)
}

async function readTranscripts(
  client: HarnessClient,
  sessions: readonly SessionSummary[],
  options: HarnessOptions,
  expectations: Expectation[],
): Promise<{ sessions: SessionSummary[] }> {
  const expected = "each session's conversation can be read back through the instance API"
  try {
    const read = await Promise.all(
      sessions.map(async (session) => {
        const [messages, info] = await Promise.all([client.context(session.id), client.getSession(session.id)])
        return {
          ...session,
          messages: messages.map(summarizeMessage),
          ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
          ...(info.model == null ? {} : { model: modelLabel(info.model) }),
        } satisfies SessionSummary
      }),
    )
    expectations.push({
      name: "conversations-readable",
      met: true,
      expected: options.driveModel ? `${expected}, including the driven turn` : expected,
      observed: read.map((session) => `${session.label}: ${session.messages.length} messages`).join(", "),
    })
    return { sessions: read }
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "conversations-readable")) {
      expectations.push({ name: "conversations-readable", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

function checkAnswers(sessions: readonly SessionSummary[], expectations: Expectation[]): void {
  const expected = "each driven session answered with its own token"
  const observed: string[] = []
  let met = true
  for (const session of sessions) {
    const token = TOKENS[session.label]
    const text = session.messages.filter((message) => message.type === "assistant").map((message) => message.text ?? "").join(" ")
    const found = text.includes(token)
    if (!found) met = false
    observed.push(`${session.label}: ${found ? `found ${token}` : `missing ${token} (assistant said ${JSON.stringify(text.slice(0, 80))})`}`)
  }
  expectations.push({ name: "turn-answers", met, expected, observed: observed.join("; ") })
}

function checkPluginLoading(
  instance: InstanceHandle,
  options: HarnessOptions,
  plugin: PluginSummary,
  layout: ScratchLayout,
  expectations: Expectation[],
  disclosures: string[],
): void {
  const probeLoads = readProbeLog(layout.probeLog)
  const directories = [...new Set(probeLoads.map((load) => load.directory))]
  const probeExpected = "the fixture probe plugin is discovered from each project's .opencode/opencode.json and runs setup once per location"
  const probeMet = directories.includes(layout.projectA) && directories.includes(layout.projectB)
  expectations.push({
    name: "project-plugins-load",
    met: probeMet,
    expected: probeExpected,
    observed: directories.length === 0 ? "no probe setup was recorded" : `setup ran in ${directories.join(", ")}`,
  })
  plugin.locations = directories

  if (plugin.entrypoint === undefined) {
    disclosures.push(
      `${options.pluginPath} has no index.ts or server.ts yet, so the harness installed it but asserts nothing about loading it`,
    )
    return
  }
  const loaded = loadedPluginIds(instance.log()).includes(options.pluginPath)
  plugin.loaded = loaded
  expectations.push({
    name: "plugin-under-test-loads",
    met: loaded,
    expected: `the instance log records loading ${options.pluginPath}`,
    observed: loaded ? `loading recorded for both projects` : `no load record for ${options.pluginPath}`,
  })
}

function sessionSummary(label: SessionSummary["label"], info: SessionInfo): SessionSummary {
  return {
    label,
    id: info.id,
    directory: info.location.directory,
    title: info.title ?? "",
    messages: [],
    ...(info.model == null ? {} : { model: modelLabel(info.model) }),
    ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
  }
}

function summarizeMessage(message: SessionMessage): MessageSummary {
  const text = message.text ?? (message.content ?? []).map((part) => part.text ?? "").join("")
  return {
    type: message.type,
    ...(text.length === 0 ? {} : { text }),
    ...(message.finish === undefined ? {} : { finish: message.finish }),
    ...(message.error === undefined ? {} : { error: message.error.type ?? message.error.message ?? "unknown" }),
  }
}

function describeSession(info: SessionInfo): string {
  return `outcome ${info.outcome ?? "pending"}, model ${info.model == null ? "unset" : modelLabel(info.model)}`
}

async function teardown(
  options: HarnessOptions,
  layout: ScratchLayout,
  instance: InstanceHandle | undefined,
  serviceJson: string,
): Promise<CleanupSummary> {
  const observations: string[] = []
  let processStopped = instance === undefined
  let portClosed = instance === undefined

  if (instance !== undefined) {
    const outcome = await instance.stop()
    processStopped = outcome.stopped
    portClosed = outcome.portClosed
    observations.push(`instance: ${outcome.observed}`)
  }

  let authFileRemoved = true
  try {
    if (existsSync(layout.authFile)) {
      rmSync(layout.authFile, { force: true })
      observations.push("deleted the copied auth.json")
    }
    authFileRemoved = !existsSync(layout.authFile)
  } catch (error) {
    authFileRemoved = false
    observations.push(`could not delete the copied auth.json: ${explain(error)}`)
  }

  let scratchRemoved = false
  let scratchKept = false
  if (options.keep) {
    scratchKept = true
    observations.push(`scratch kept at ${layout.root}`)
  } else {
    try {
      rmSync(layout.root, { recursive: true, force: true })
    } catch (error) {
      observations.push(`could not remove scratch: ${explain(error)}`)
    }
    scratchRemoved = !existsSync(layout.root)
    if (!scratchRemoved) observations.push(`scratch still exists at ${layout.root}`)
  }
  observations.push(`${serviceJson} was read only`)
  return { processStopped, portClosed, scratchRemoved, scratchKept, authFileRemoved, observed: observations.join("; ") }
}

function explain(error: unknown): string {
  if (error instanceof Error) return error.message.length === 0 ? error.name : error.message
  return typeof error === "string" ? error : JSON.stringify(error)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

export function readProbeLog(path: string): Array<{ pid: number; directory: string }> {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { pid: number; directory: string })
}
