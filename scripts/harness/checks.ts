/**
 * The checks.
 *
 * Each check turns one observation into an `Expectation`: the promise in
 * words, and what was actually there. They are collected here, away from the
 * phases that produce the observations, so the whole set of promises a run
 * makes can be read in one place.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import type { HarnessOptions } from "./args.ts"
import { loadedPluginIds, type InstanceHandle } from "./instance.ts"
import { authJsonPath, pluginEntrypoint, type ScratchLayout } from "./paths.ts"
import type { Expectation, PluginSummary } from "./report.ts"

/** The plugin under test is installed from here, so it has to be a directory. */
export function checkPluginPath(
  options: HarnessOptions,
  plugin: PluginSummary,
  expectations: Expectation[],
): string | undefined {
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

/** Driven turns need the developer's model credentials; structural runs do not. */
export function checkAuth(options: HarnessOptions, expectations: Expectation[]): string | undefined {
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

/** The instance must own its database and its port; the live service owns neither of them. */
export function checkIsolation(
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

/**
 * Each driven session must have answered with its own token.
 */

/**
 * The fixture probe proves that a plugin declared in a project's config is
 * discovered and that its `setup` runs once per location; the plugin under test
 * is only asserted about once it has an entrypoint.
 */
export function checkPluginLoading(
  instance: InstanceHandle,
  options: HarnessOptions,
  plugin: PluginSummary,
  layout: ScratchLayout,
  expectations: Expectation[],
  disclosures: string[],
): void {
  const probeLoads = readProbeLog(layout.probeLog)
  const directories = [...new Set(probeLoads.map((load) => load.directory))]
  const probeExpected =
    "the fixture probe plugin is discovered from each project's .opencode/opencode.json and runs setup once per location"
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

/** One JSON line per plugin `setup`, as written by the fixture probe plugin. */
export function readProbeLog(path: string): Array<{ pid: number; directory: string; version: string }> {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { pid: number; directory: string; version: string })
}
