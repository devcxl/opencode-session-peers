/**
 * The harness command line.
 *
 * Parsing is pure: it takes argv and a working directory and returns options,
 * so every default and every rejection can be tested without booting anything.
 */

import { REPO_ROOT, STUB_MODEL_ID, STUB_PROVIDER_ID, defaultScratchRoot, resolvePluginPath } from "./paths.ts"

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_BOOT_TIMEOUT_MS = 60 * 1000

export class UsageError extends Error {}

export interface ModelRef {
  providerID: string
  id: string
}

export interface HarnessOptions {
  /** Directory installed as the project plugin; the default is this repository. */
  pluginPath: string
  /** Model for driven turns; unset means "let the instance choose". */
  model?: ModelRef
  /**
   * True with `--model`: the two sessions are driven with real turns. The
   * default is the structural pass, which needs no model and no credentials.
   */
  driveModel: boolean
  /**
   * True with `--stub`: the two sessions are driven through the harness's own
   * stub model, offline and with no credentials. Cannot be combined with
   * `--model` or `--no-model`.
   */
  stub: boolean
  turnTimeoutMs: number
  bootTimeoutMs: number
  /** Where the per-run scratch directory is created. */
  scratchRoot: string
  /** Keep the scratch directory after the run, for debugging. */
  keep: boolean
  json: boolean
}

export const USAGE = `session-peers harness - boot a throwaway opencode instance and drive real sessions

Usage: bun run harness [options]

Options:
  --plugin <dir>            Plugin under test, installed as a project plugin
                            in both scratch projects (default: this repository)
  --model <provider/id>     Drive the two sessions with real turns through this
                            model. Without it the harness runs the structural
                            pass: no turns, no model, no credentials
  --stub                    Drive the two sessions through the harness's own
                            stub model, offline: no hosted model, no credentials
  --no-model                The structural pass, stated explicitly (the default)
  --turn-timeout-ms <n>     How long one driven turn may take (default: ${DEFAULT_TURN_TIMEOUT_MS})
  --boot-timeout-ms <n>     How long the instance may take to answer (default: ${DEFAULT_BOOT_TIMEOUT_MS})
  --scratch <dir>           Scratch root (default: ${defaultScratchRoot()})
  --keep                    Keep the scratch directory after the run
  --json                    Print the report as JSON
  -h, --help                Print this text

The throwaway instance gets its own XDG data, state, cache and config
directories, its own database and its own port. The developer's live service is
never touched; its service.json is hashed before and after the run and the two
digests are compared.

Without --model and --stub nothing is driven and no credentials are read. With
--model the developer's auth.json is copied into the instance for the run and
deleted at teardown, and real turns are driven through the instance's own HTTP
API. Those turns depend on the host's model backend serving a fresh instance,
which is not guaranteed on this machine: a refused turn is asked again in a
fresh session, reported with the provider's own words, and leaves the run
non-zero.

--stub replaces the host's model backend with the harness's own: a tiny
OpenAI-compatible endpoint on a loopback port that answers a scripted turn. It
is offline and deterministic, so the two sessions can prove that a message sent
in one directory arrives in the other without a hosted model and without
reading any credential.
`

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h")
}

export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): HarnessOptions {
  let pluginInput: string | undefined
  let model: ModelRef | undefined
  let driveModel = false
  let stub = false
  let noModel = false
  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS
  let bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS
  let scratchRoot: string | undefined
  let keep = false
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!
    switch (flag) {
      case "--plugin":
        pluginInput = valueAfter(argv, index, flag)
        index += 1
        break
      case "--model":
        if (model !== undefined) throw new UsageError("--model was given more than once")
        model = parseModelRef(valueAfter(argv, index, flag))
        driveModel = true
        index += 1
        break
      case "--stub":
        if (stub) throw new UsageError("--stub was given more than once")
        stub = true
        break
      case "--no-model":
        if (noModel) throw new UsageError("--no-model was given more than once")
        noModel = true
        driveModel = false
        break
      case "--turn-timeout-ms":
        turnTimeoutMs = parsePositiveInteger(valueAfter(argv, index, flag), flag)
        index += 1
        break
      case "--boot-timeout-ms":
        bootTimeoutMs = parsePositiveInteger(valueAfter(argv, index, flag), flag)
        index += 1
        break
      case "--scratch":
        scratchRoot = valueAfter(argv, index, flag)
        index += 1
        break
      case "--keep":
        keep = true
        break
      case "--json":
        json = true
        break
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(flag)}`)
    }
  }

  if (model !== undefined && !driveModel) {
    throw new UsageError("--model and --no-model contradict each other")
  }
  if (stub && model !== undefined) {
    throw new UsageError("--stub and --model contradict each other")
  }
  if (stub && noModel) {
    throw new UsageError("--stub and --no-model contradict each other")
  }

  return {
    pluginPath: pluginInput === undefined ? REPO_ROOT : resolvePluginPath(pluginInput, cwd),
    model,
    driveModel,
    stub,
    turnTimeoutMs,
    bootTimeoutMs,
    scratchRoot: scratchRoot === undefined ? defaultScratchRoot() : resolvePluginPath(scratchRoot, cwd),
    keep,
    json,
  }
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`)
  }
  return value
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) {
    throw new UsageError(`--model must look like <providerID>/<modelID>, got ${JSON.stringify(value)}`)
  }
  return { providerID: value.slice(0, separator), id: value.slice(separator + 1) }
}

export function modelLabel(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

/**
 * The model the two sessions are created with, whichever pass drives them: the
 * developer's hosted choice with `--model`, the harness's own stub with
 * `--stub`, and nothing at all in the structural pass.
 */
export function drivenModel(options: HarnessOptions): ModelRef | undefined {
  if (options.stub) return { providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID }
  return options.model
}

/** Scratch directory ids must be unique per run and safe as one path segment. */
export function scratchId(now: number, random: string): string {
  return `${now.toString(36)}-${random}`
}
