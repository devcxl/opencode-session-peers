/**
 * The run.
 *
 * This module only orchestrates: boot a throwaway instance, install the plugin
 * under test as a project plugin, create two sessions in two directories, drive
 * them, read them back, check the expectations and tear everything down. Each
 * phase and each check lives in its own module.
 *
 * Every step reports itself as an `Expectation` with the promise in words and
 * the observation in words, so a run is green only when all of them are met and
 * the teardown really happened.
 */

import { join, relative } from "node:path"
import { modelLabel, scratchId, type HarnessOptions } from "./args.ts"
import { checkAuth, checkIsolation, checkPluginLoading, checkPluginPath } from "./checks.ts"
import { createClient } from "./client.ts"
import { prepareScratch, startInstance, type InstanceHandle } from "./instance.ts"
import { isProcessAlive, readLiveService } from "./isolation.ts"
import { PROBE_PLUGIN_DIR, scratchLayout, serviceJsonPath, type ScratchLayout } from "./paths.ts"
import {
  explain,
  expectationsMet,
  type CleanupSummary,
  type Expectation,
  type HarnessReport,
  type InstanceSummary,
  type PluginSummary,
  type SessionSummary,
} from "./report.ts"
import {
  activateLocations,
  checkAnswers,
  createSessions,
  driveTurns,
  readTranscripts,
  summarizeSession,
} from "./sessions.ts"
import { teardown } from "./teardown.ts"

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
      options.driveModel
        ? "the instance fetched its model catalogue over the network; driven turns also called the model provider"
        : "the instance fetched its model catalogue over the network",
    )
    checkIsolation(instance, liveBefore.url, layout, expectations)

    const client = createClient(instance.url, instance.password)
    await activateLocations(client, layout, expectations)
    const created = await createSessions(client, layout, options, expectations)
    sessions = created.map((info, index) => summarizeSession(index === 0 ? "A" : "B", info))

    // A failed drive still leaves a transcript worth reading: that is where
    // the reason for the failure is, and the report has to name both sessions
    // either way.
    let driveFailure: unknown
    if (options.driveModel) {
      try {
        sessions = await driveTurns(client, options, sessions, expectations, disclosures)
      } catch (error) {
        driveFailure = error
      }
    }
    sessions = await readTranscripts(client, sessions, options, expectations)
    if (options.driveModel && driveFailure === undefined) checkAnswers(sessions, expectations)
    usedModels = [
      ...new Set(sessions.map((session) => session.model).filter((model): model is string => model !== undefined)),
    ]

    checkPluginLoading(instance, options, plugin, layout, expectations, disclosures)
    if (driveFailure !== undefined) throw driveFailure
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
    ok: expectationsMet(expectations),
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

async function boot(
  options: HarnessOptions,
  layout: ScratchLayout,
  expectations: Expectation[],
): Promise<InstanceHandle> {
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
