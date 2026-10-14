/**
 * The report.
 *
 * The harness is only as useful as what it tells a reader afterwards: which
 * sessions ran where, which expectations were checked and against what, and
 * every file or process outside its own scratch directory that it touched.
 */

export type HarnessMode = "drive" | "structural"

export interface Expectation {
  name: string
  met: boolean
  /** What the harness promised, in words. */
  expected: string
  /** What was actually there, in words. */
  observed: string
}

export interface MessageSummary {
  type: string
  text?: string
  finish?: string
  error?: string
}

export interface SessionSummary {
  label: "A" | "B"
  id: string
  directory: string
  title: string
  model?: string
  outcome?: string
  messages: MessageSummary[]
  error?: string
}

export interface InstanceSummary {
  url: string
  port: number
  pid: number
  database: string
  dataDir: string
  stateDir: string
  cacheDir: string
  configDir: string
}

export interface PluginSummary {
  path: string
  entrypoint?: string
  /** Project config files the plugin is declared in. */
  installedIn: string[]
  loaded: boolean
  locations: string[]
}

export interface CleanupSummary {
  processStopped: boolean
  portClosed: boolean
  scratchRemoved: boolean
  scratchKept: boolean
  authFileRemoved: boolean
  observed: string
}

export interface HarnessReport {
  ok: boolean
  mode: HarnessMode
  startedAt: string
  finishedAt: string
  durationMs: number
  expectations: Expectation[]
  sessions: SessionSummary[]
  instance?: InstanceSummary
  plugin: PluginSummary
  model: { requested?: string; used: string[] }
  disclosures: string[]
  cleanup: CleanupSummary
}

export function expectationsMet(expectations: readonly Expectation[]): boolean {
  return expectations.every((expectation) => expectation.met)
}

/**
 * An unknown thrown value as one line of an `observed` field. Errors thrown by
 * the host with an empty message (a named Effect failure) still have to say
 * something, so their name carries the meaning.
 */
export function explain(error: unknown): string {
  if (error instanceof Error) return error.message.length === 0 ? error.name : error.message
  return typeof error === "string" ? error : JSON.stringify(error)
}

export function renderReport(report: HarnessReport): string {
  const lines: string[] = []
  lines.push(`session-peers harness — ${report.mode === "drive" ? "model-driven" : "structural"} mode`)
  lines.push(`ok        ${report.ok ? "yes" : "NO"}`)
  lines.push(`started   ${report.startedAt}`)
  lines.push(`duration  ${(report.durationMs / 1000).toFixed(1)} s`)
  lines.push("")

  if (report.instance !== undefined) {
    const instance = report.instance
    lines.push(`instance  ${instance.url} (pid ${instance.pid})`)
    lines.push(`  database ${instance.database}`)
    lines.push(`  scratch  ${instance.configDir} (data, state, cache and config all under it)`)
  } else {
    lines.push("instance  (none started)")
  }
  lines.push("")

  const plugin = report.plugin
  lines.push(`plugin    ${plugin.path}`)
  lines.push(`  entrypoint ${plugin.entrypoint ?? "missing (no index.ts / server.ts)"}`)
  lines.push(`  installed  ${plugin.installedIn.length === 0 ? "(not installed)" : plugin.installedIn.join(", ")}`)
  lines.push(
    `  loaded     ${loadedState(plugin)}${plugin.locations.length === 0 ? "" : ` — locations: ${plugin.locations.join(", ")}`}`,
  )
  lines.push("")

  lines.push(`model     requested: ${report.model.requested ?? "(instance default)"}`)
  if (report.model.used.length > 0) lines.push(`          used: ${report.model.used.join(", ")}`)
  lines.push("")

  lines.push(`sessions  ${report.sessions.length}`)
  for (const session of report.sessions) {
    lines.push(`  ${session.label}  ${session.id}`)
    lines.push(`     directory ${session.directory}`)
    lines.push(
      `     title ${session.title} | model ${session.model ?? "(unset)"} | outcome ${
        session.outcome ?? "(none)"
      }`,
    )
    if (session.error !== undefined) lines.push(`     error ${session.error}`)
    for (const message of session.messages) {
      const parts = [`     ${message.type}`]
      if (message.text !== undefined && message.text.length > 0) parts.push(oneLine(message.text))
      if (message.finish !== undefined) parts.push(`finish=${message.finish}`)
      if (message.error !== undefined) parts.push(`error=${message.error}`)
      lines.push(parts.join("  "))
    }
  }
  lines.push("")

  lines.push(`expectations (${report.expectations.filter((e) => e.met).length}/${report.expectations.length} met)`)
  for (const expectation of report.expectations) {
    lines.push(`  ${expectation.met ? "PASS" : "FAIL"}  ${expectation.name}`)
    lines.push(`        expected ${expectation.expected}`)
    lines.push(`        observed ${expectation.observed}`)
  }
  lines.push("")

  lines.push("disclosures")
  if (report.disclosures.length === 0) lines.push("  (nothing outside the scratch directory was touched)")
  for (const disclosure of report.disclosures) lines.push(`  - ${disclosure}`)
  lines.push("")

  const cleanup = report.cleanup
  lines.push("cleanup")
  lines.push(`  process stopped    ${cleanup.processStopped ? "yes" : "NO"}`)
  lines.push(`  port closed        ${cleanup.portClosed ? "yes" : "NO"}`)
  lines.push(`  scratch removed    ${cleanup.scratchRemoved ? "yes" : cleanup.scratchKept ? "kept (--keep)" : "NO"}`)
  lines.push(`  auth.json removed  ${cleanup.authFileRemoved ? "yes" : "NO"}`)
  if (cleanup.observed.length > 0) lines.push(`  observed           ${cleanup.observed}`)

  return `${lines.join("\n")}\n`
}

function oneLine(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
}

/**
 * A plugin with no entrypoint is not loaded *or* unloaded: nothing is asserted
 * about it, and the report must not read as if a check had failed.
 */
function loadedState(plugin: PluginSummary): string {
  if (plugin.entrypoint === undefined) return "not asserted (no entrypoint yet)"
  return plugin.loaded ? "yes" : "no"
}
