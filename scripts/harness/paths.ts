/**
 * Where the harness puts things.
 *
 * The throwaway instance gets its own data, state, cache and config
 * directories, all under one scratch root; the projects it serves are scratch
 * directories too. Nothing here may point at the developer's live setup, except
 * the two read-only sources the harness is allowed to read (`auth.json` and the
 * live `service.json`).
 */

import { existsSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Environment variable the fixture probe plugin reads to find its evidence log. */
export const PROBE_LOG_ENV = "SESSION_PEERS_HARNESS_PROBE_LOG"

/**
 * The stub model the offline pass drives its turns through. The provider id and
 * the model id are part of two contracts at once — the provider plugin that
 * declares them and the harness that asks for them — so they are named once
 * here; `test/harness-stub.test.ts` pins that the plugin text agrees.
 */
export const STUB_PROVIDER_ID = "harness-stub"
export const STUB_MODEL_ID = "stub"
/** Base URL of the stub, read by the provider plugin from the instance's environment. */
export const STUB_URL_ENV = "SESSION_PEERS_HARNESS_STUB_URL"
/** The plugin declares this variable as its credential; its value is a literal. */
export const STUB_KEY_ENV = "SESSION_PEERS_HARNESS_STUB_API_KEY"
/** The whole credential an openai-compatible provider needs for a local endpoint. */
export const STUB_API_KEY = "stub"
/** The provider plugin as it lives in the repository, copied into each scratch config. */
export const STUB_PLUGIN_SOURCE = join(import.meta.dir, "stub", "provider-plugin.ts")

/** The checkout the harness was started from; the default plugin under test. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..")

/**
 * The fixture plugin declared next to the plugin under test. It is
 * dependency-free and only records that a location loaded it, which is what
 * proves project plugin discovery worked at all.
 */
export const PROBE_PLUGIN_DIR = join(import.meta.dir, "probe-plugin")

/** Entry points the host resolves for a local plugin directory (`Host.resolve`). */
const ENTRYPOINTS = ["index.ts", "index.js", "server.ts", "server.js"] as const

export interface ScratchLayout {
  root: string
  data: string
  state: string
  cache: string
  config: string
  projectA: string
  projectB: string
  /** Where the instance is told to keep the copied credentials. */
  authFile: string
  /** The instance's SQLite file, once it has booted. */
  database: string
  /** One JSON line per plugin `setup`, written by the fixture probe plugin. */
  probeLog: string
  serverLog: string
  /** Where the stub provider plugin is installed, when the offline pass runs. */
  stubProvider: string
}

export function scratchLayout(scratchRoot: string, id: string): ScratchLayout {
  const root = join(scratchRoot, `session-peers-harness-${id}`)
  const data = join(root, "data")
  const config = join(root, "config")
  return {
    root,
    data,
    state: join(root, "state"),
    cache: join(root, "cache"),
    config,
    projectA: join(root, "project-a"),
    projectB: join(root, "project-b"),
    authFile: join(data, "opencode", "auth.json"),
    database: join(data, "opencode", "opencode.db"),
    probeLog: join(root, "plugin-loads.jsonl"),
    serverLog: join(root, "server.log"),
    stubProvider: join(config, "opencode", "plugins", "harness-stub-provider.ts"),
  }
}

export function resolvePluginPath(input: string, cwd: string): string {
  return resolve(cwd, input)
}

export function pluginEntrypoint(directory: string): string | undefined {
  for (const name of ENTRYPOINTS) {
    const candidate = join(directory, name)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/**
 * A project-scoped config. Both the plugin under test and the probe are
 * declared here, which is the installation mechanism every later ticket uses.
 */
export function projectConfigText(pluginDirectories: readonly string[]): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      plugins: [...pluginDirectories],
    },
    null,
    2,
  )}\n`
}

export function globalConfigText(): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      update: "disable",
    },
    null,
    2,
  )}\n`
}

/** `$XDG_DATA_HOME` or its default, which is where opencode keeps credentials. */
export function developerDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_DATA_HOME"]
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode")
}

export function developerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_STATE_HOME"]
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "state")
  return join(base, "opencode")
}

export function authJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(developerDataDir(env), "auth.json")
}

/** The live service registry. The harness reads it; it must never write it. */
export function serviceJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(developerStateDir(env), "service.json")
}

export function defaultScratchRoot(): string {
  return join(tmpdir(), "opencode")
}
